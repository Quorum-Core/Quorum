/**
 * 학습 루프 Supabase 백엔드 — PL/pgSQL RPC(sql/learning-loop-rpc.sql) 호출.
 * sqlite import 없음(supabase 프로덕션에서 better-sqlite3 미설치여도 안전).
 * service-role 강제(#2): anon/dummy면 no-op(조용한 anon 권한 동작 금지). RPC 미적용 시 graceful skip.
 */
import { getServiceClient } from './supabase';
import { untrustedBlock } from './untrusted';
import { embed, embeddingEnabled, toVectorLiteral } from './embedding';
import {
  HASH_VERSION, LEASE_MS, MAX_ATTEMPTS, RETRY_BACKOFF_MS, STALE_DAYS,
  lessonHash, lessonFingerprint, buildReflectRows, roundBounds, extractLessons, validateLessons,
  type Claim, type ReflectRow, type LlmFn,
} from './learning-core';

// #2: service_role 키가 있을 때만 client 반환. 없으면 null → 학습 경로 전부 no-op(anon 금지).
function db() {
  const hasService = !!(process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
  const hasUrl = !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
  return hasService && hasUrl ? getServiceClient() : null;
}

async function tryStartReflection(roundId: string, hashVersion: number): Promise<Claim | null> {
  const c = db(); if (!c) return null;
  const owner = crypto.randomUUID();
  const { data, error } = await c.rpc('try_start_reflection', {
    p_round_id: roundId, p_hash_version: hashVersion, p_owner: owner, p_lease_ms: LEASE_MS, p_max: MAX_ATTEMPTS,
  });
  if (error || !data || !data.length) return null;
  const row = data[0] as { owner_id: string; lease_until: string; hash_version: number };
  if (row.owner_id !== owner) return null;
  return { ownerId: owner, leaseUntil: row.lease_until, hashVersion: row.hash_version ?? hashVersion };
}

async function countRoundLinks(roundId: string): Promise<number> {
  const c = db(); if (!c) return 0;
  const { data } = await c.rpc('count_round_links', { p_round_id: roundId });
  return Number(data ?? 0);
}

type MemRow = { content: string; current_type?: string };

function renderBlock(rows: MemRow[]): string {
  let total = 0; const lines: string[] = [];
  for (const r of rows) {
    const c = String(r.content || '').slice(0, 300);
    if (total + c.length > 1200) break;
    total += c.length;
    lines.push(`- (${r.current_type || 'memory'}) ${c}`);
  }
  if (!lines.length) return '';
  return untrustedBlock('UNTRUSTED_LEARNED_CONTEXT', lines.join('\n'));
}

// #3: query 임베딩 캐시 + circuit breaker(CF 지연/실패 시 일정시간 임베딩 skip → 에이전트당 재호출/누적 지연 차단).
const embedCache = new Map<string, number[] | null>();
let embedCooldownUntil = 0;
async function embedCached(query: string): Promise<number[] | null> {
  if (embedCache.has(query)) return embedCache.get(query)!;
  if (Date.now() < embedCooldownUntil) return null;  // breaker open
  const vec = await embed(query);
  if (vec) { if (embedCache.size > 200) embedCache.clear(); embedCache.set(query, vec); }
  else embedCooldownUntil = Date.now() + 60_000;       // 실패 → 60s 동안 importance fallback
  return vec;
}

async function importanceRows(agentId: string): Promise<MemRow[]> {
  const c = db(); if (!c) return [];
  // #113: 감쇠(stale) 필터를 limit 전(쿼리 안)에서 적용 — 이전엔 limit(15) 뒤 JS 필터라, stale 고중요도 15개가 앞서면
  //   fresh 메모리가 잘려 5개 미달(sqlite는 SQL WHERE로 필터하므로 비동치였음). KEEP 조건: evidence_count>1 OR last_seen_at>=cutoff.
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
  const { data, error } = await c.from('agent_memory')
    .select('content, current_type, evidence_count, last_seen_at')
    .eq('agent_id', agentId).eq('status', 'active')
    .or(`evidence_count.gt.1,last_seen_at.gte.${cutoff}`)
    .order('importance', { ascending: false }).order('evidence_count', { ascending: false }).order('last_seen_at', { ascending: false }) // #47: sqlite와 동치(보강 교훈 우대)
    .limit(15); // 버퍼(호출부 semantic dedup 후 5개 보장)
  if (error || !data) return [];
  return (data as MemRow[]).slice(0, 5);
}

// RETRIEVE: 시맨틱(query) 결과 + importance fallback 병합·dedup·top-5(#4: partial recall 손실 방지).
export async function getRetrieveBlockAsync(agentId: string, query?: string): Promise<string> {
  const c = db(); if (!c) return '';
  const merged: MemRow[] = [];
  const seen = new Set<string>();
  const add = (rows: MemRow[]) => { for (const r of rows) { const k = String(r.content || ''); if (k && !seen.has(k)) { seen.add(k); merged.push(r); } } };

  if (query && embeddingEnabled()) {
    const vec = await embedCached(query);
    if (vec) {
      const { data, error } = await c.rpc('match_memories', { p_agent: agentId, p_query: toVectorLiteral(vec), p_k: 5, p_stale_days: STALE_DAYS });
      if (!error && data) add(data as MemRow[]);
    }
  }
  if (merged.length < 5) add(await importanceRows(agentId));  // 시맨틱 부족분 importance로 보강
  return renderBlock(merged.slice(0, 5));
}

// WRITE: active 메모리 중 embedding NULL인 row를 CF 임베딩으로 채움. 미설정/비-service면 no-op.
// #71(IMPROVE): 반복 교훈(evidence_count>=3) → skill 승격(최소구현: type 승격). retire(반례 obsolete)는 추후.
async function promoteSkills(agentIds: string[]): Promise<void> {
  const c = db(); if (!c || !agentIds.length) return;
  // #78: sqlite와 동치 — current_type 승격 + confidence↑(supabase-js는 컬럼 산술 불가 → fetch 후 row별 update).
  const { data } = await c.from('agent_memory').select('id, confidence')
    .in('agent_id', Array.from(new Set(agentIds))).gte('evidence_count', 3).eq('status', 'active').neq('current_type', 'skill');
  for (const r of (data || []) as Array<{ id: number; confidence?: number }>) {
    await c.from('agent_memory').update({ current_type: 'skill', confidence: Math.min(1, (r.confidence ?? 0.5) + 0.1) }).eq('id', r.id);
  }
}

async function embedActiveMemories(agentIds: string[]): Promise<void> {
  const c = db(); if (!c || !embeddingEnabled() || !agentIds.length) return;
  const { data, error } = await c.from('agent_memory')
    .select('id, content').in('agent_id', Array.from(new Set(agentIds)))
    .eq('status', 'active').is('embedding', null).limit(50);
  if (error || !data) return;
  for (const r of data as Array<{ id: number; content: string }>) {
    const vec = await embed(r.content);
    if (!vec) continue;
    await c.from('agent_memory').update({ embedding: toVectorLiteral(vec) }).eq('id', r.id);
  }
}


// 워치독(#2): 재개 대상 round_id(error backoff 경과 / started lease 만료, attempt 한도 내).
export async function listPendingReflections(limit = 20): Promise<string[]> {
  const c = db(); if (!c) return [];
  const nowIso = new Date().toISOString();
  // attempt 필터 없음(#2 v8): max 도달 row도 포함 → tryStartReflection failed 전이 실행.
  const { data, error } = await c.from('meeting_reflections')
    .select('round_id, status, next_retry_at, lease_until')
    .in('status', ['error', 'started'])
    .order('updated_at', { ascending: true }).limit(100);
  const ids = (error || !data) ? [] : (data as Array<{ round_id: string; status: string; next_retry_at?: string; lease_until?: string }>)
    .filter((r) => (r.status === 'error' && (!r.next_retry_at || r.next_retry_at <= nowIso))
                || (r.status === 'started' && (r.lease_until || '') < nowIso))
    .slice(0, limit).map((r) => r.round_id);
  // done 전 marker 선점(reserveReflection)으로 모든 done 회의가 marker 보유 → orphan 스캔 불필요(#23).
  return ids;
}

// 일시 실패(LLM/파싱) → owner+lease-guarded로 error+next_retry_at(워치독 재개, #1/#29). terminal 아님.
async function markErrorSupabase(roundId: string, ownerId: string, msg: string): Promise<void> {
  const c = db(); if (!c) return;
  const nowIso = new Date().toISOString();
  await c.from('meeting_reflections')
    .update({ status: 'error', next_retry_at: new Date(Date.now() + RETRY_BACKOFF_MS).toISOString(), error: msg.slice(0, 300), updated_at: nowIso })
    .eq('round_id', roundId).eq('owner_id', ownerId).eq('status', 'started').gt('lease_until', nowIso); // #29: lease 만료 guard(sqlite holdsLease 대응)
}

// 현재 round의 attempt_count(재시도 한도 판정, #30).
async function reflectionAttempts(roundId: string): Promise<number> {
  const c = db(); if (!c) return 0;
  const { data } = await c.from('meeting_reflections').select('attempt_count').eq('round_id', roundId).maybeSingle();
  return Number((data as { attempt_count?: number } | null)?.attempt_count ?? 0);
}

// #77/#82(IMPROVE retire): 오염 메모리 은퇴 — obsolete + confidence↓. normalized_hash 기준(정규화-동일).
export async function retireMemory(agentId: string, content: string): Promise<boolean> {
  const c = db(); if (!c) return false;
  const nh = lessonHash(HASH_VERSION, content);
  // #87: normalized_hash(현재 버전) 우선, 없으면 content(다른 hash_version·legacy)로 fallback.
  let { data } = await c.from('agent_memory').select('id, confidence').eq('agent_id', agentId).eq('normalized_hash', nh).eq('status', 'active');
  if (!data || !data.length) ({ data } = await c.from('agent_memory').select('id, confidence').eq('agent_id', agentId).eq('content', content).eq('status', 'active'));
  const rows = (data || []) as Array<{ id: number; confidence?: number }>;
  for (const r of rows) {
    await c.from('agent_memory').update({ status: 'obsolete', confidence: Math.max(0, (r.confidence ?? 0.5) - 0.3) }).eq('id', r.id);
  }
  return rows.length > 0;
}

// #79: legacy marker에 재구성한 round 경계 저장(from_seq NULL일 때만).
export async function setLegacyBounds(roundId: string, fromSeq: number, toSeq: number): Promise<void> {
  const c = db(); if (!c) return;
  await c.from('meeting_reflections').update({ from_seq: fromSeq, to_seq: toSeq }).eq('round_id', roundId).is('from_seq', null);
}

// #69: batch9 이전 from_seq NULL marker는 superseded 시 resume하면 오염 → failed terminal로 skip(경계 있으면 false).
export async function failIfLegacyStale(roundId: string): Promise<boolean> {
  const c = db(); if (!c) return false;
  const { data } = await c.from('meeting_reflections').select('from_seq').eq('round_id', roundId).maybeSingle();
  const fromSeq = (data as { from_seq?: number | null } | null)?.from_seq;
  if (data && (fromSeq === null || fromSeq === undefined)) {
    await c.from('meeting_reflections').update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('round_id', roundId).in('status', ['error', 'started']);
    return true;
  }
  return false;
}

// done 확정 '전' 호출: marker(claim) 선점만(extract 분리). terminal/live-lease면 null.
// → done 전 항상 marker 존재 → crash 시 started lease 만료 후 워치독 재개(#18/#23 근본해결).
export async function reserveReflection(meetingId: string, version: number, fromSeq?: number, toSeq?: number): Promise<Claim | null> {
  const roundId = `${meetingId}:${version}`;
  const claim = await tryStartReflection(roundId, HASH_VERSION);
  if (!claim) return null;
  const c = db(); if (!c) return claim;
  // 경계(#60): 최초 reserve일 때만 저장(from_seq IS NULL), 재claim은 보존. owner-guarded.
  if (fromSeq != null && toSeq != null) {
    await c.from('meeting_reflections').update({ from_seq: fromSeq, to_seq: toSeq })
      .eq('round_id', roundId).eq('owner_id', claim.ownerId).is('from_seq', null);
  }
  const { data } = await c.from('meeting_reflections').select('from_seq, to_seq').eq('round_id', roundId).maybeSingle();
  const b = data as { from_seq?: number; to_seq?: number } | null;
  return { ...claim, fromSeq: b?.from_seq ?? undefined, toSeq: b?.to_seq ?? undefined };
}

// reserve + extract 합성(워치독 재개 경로).
export async function runReflection(meetingId: string, version: number, allRows: ReflectRow[], agenda: string, llm: LlmFn): Promise<void> {
  const { fromSeq, toSeq } = roundBounds(allRows);
  const claim = await reserveReflection(meetingId, version, fromSeq, toSeq);
  if (!claim) return;
  await runReflectionWithClaim(meetingId, version, claim, allRows, agenda, llm);
}

// 선점한 claim으로 extract~finish(재claim 안 함). reserveReflection → done → 이 함수(background) 순서.
export async function runReflectionWithClaim(meetingId: string, version: number, claim: Claim, allRows: ReflectRow[], agenda: string, llm: LlmFn): Promise<void> {
  const c = db(); if (!c) return;
  const roundId = `${meetingId}:${version}`;
  const rows = buildReflectRows(allRows, claim.fromSeq, claim.toSeq); // #60: 저장된 round 경계로 필터
  const ext = await extractLessons(agenda, rows, llm);
  if (!ext.ok) { await markErrorSupabase(roundId, claim.ownerId, 'extract failed (llm/parse)'); return; } // #1
  const valid = validateLessons(ext.lessons, rows, claim.hashVersion);
  let addFailed = false;  // add 실패 시 finish 금지(link 0개 false done·교훈 유실 방지)
  for (const l of valid) {
    const fp = lessonFingerprint(claim.hashVersion, l.content, l.evidenceSeq, l.excerptStart, l.excerptEnd);
    const rhash = lessonHash(claim.hashVersion, l.content);
    const { error } = await c.rpc('add_memory_link', {
      p_round_id: roundId, p_owner: claim.ownerId, p_agent: l.agentId, p_seq: l.evidenceSeq,
      p_excerpt: l.excerpt ?? '', p_start: l.excerptStart, p_end: l.excerptEnd, p_idx: l.lessonIndex ?? 0,
      p_fingerprint: fp, p_importance: l.importance ?? 6, p_content: l.content, p_rhash: rhash, p_hv: claim.hashVersion,
    });
    if (error) { addFailed = true; console.error('add_memory_link error:', roundId, error.message); }
  }
  if (addFailed) return;  // marker 'started' 유지 → lease 만료 후 재시도

  const hasLinks = (await countRoundLinks(roundId)) > 0;
  if (valid.length === 0 && !hasLinks) {
    if (ext.lessons.length === 0) {
      // 진짜 빈 결과 → no_lessons(#45). 실패(RPC 미적용/권한) 시 marker는 started로 남아 워치독이 재개(#51).
      const { error: mnlErr } = await c.rpc('mark_no_lessons', { p_round_id: roundId, p_owner: claim.ownerId });
      if (mnlErr) console.warn('mark_no_lessons not applied (marker started 유지 → 워치독 재개):', roundId, mnlErr.message);
    } else if (await reflectionAttempts(roundId) >= MAX_ATTEMPTS) {
      // raw non-empty + valid empty: MAX_ATTEMPTS 도달 → failed_validation terminal(#30). owner+lease guard(#29).
      const nowIso = new Date().toISOString();
      await c.from('meeting_reflections').update({ status: 'failed_validation', updated_at: nowIso })
        .eq('round_id', roundId).eq('owner_id', claim.ownerId).eq('status', 'started').gt('lease_until', nowIso);
    } else {
      // 아직 재시도 여지 → error(attribution 비결정적, 재추출 시 성공 가능, #30)
      await markErrorSupabase(roundId, claim.ownerId, 'no valid lessons (attribution failed)');
    }
  } else {
    const { data: repData, error: repErr } = await c.rpc('repair_orphan_evidence', { p_round_id: roundId, p_owner: claim.ownerId });
    if (repErr || repData === false) { console.warn('repair not applied (lease lost?):', roundId, repErr?.message); return; } // #1: false도 미완료
    const { data: finData, error: finErr } = await c.rpc('finish_reflection', { p_round_id: roundId, p_owner: claim.ownerId });
    if (finErr || finData === false) { console.warn('finish not applied (lease lost?):', roundId, finErr?.message); return; } // marker 'started' 유지 → 재claim
    // finish 이후 후처리 — 임베딩 + skill 승격(#71). fire-and-forget(회의 종료 안 막음).
    void embedActiveMemories(valid.map((l) => l.agentId)).catch((e) => console.error('embed memories error:', roundId, e));
    void promoteSkills(valid.map((l) => l.agentId)).catch((e) => console.error('promote skills error:', roundId, e));
  }
}
