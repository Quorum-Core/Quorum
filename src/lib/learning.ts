/**
 * 학습 루프(Phase A) sqlite 데이터 레이어 — REFLECT 트랜잭션·canonical 메모리·멱등.
 * 순수 로직(hashing/extract/validate)은 learning-core. (Supabase는 learning-supabase.ts.)
 */
import crypto from 'crypto';
import { getDb } from './sqlite';
import { untrustedBlock } from './untrusted';
import {
  HASH_VERSION, LEASE_MS, MAX_ATTEMPTS, RETRY_BACKOFF_MS, STALE_DAYS, nowISO, futureISO,
  lessonHash, lessonFingerprint,
  buildReflectRows, roundBounds, extractLessons, validateLessons,
  type Claim, type Lesson, type ReflectRow, type LlmFn,
} from './learning-core';

export {
  HASH_VERSION, normalizeLessonV1, lessonHash, lessonFingerprint,
  buildReflectRows, extractLessons, validateLessons,
} from './learning-core';
export type { Claim, Lesson, ReflectRow, LlmFn } from './learning-core';

// ── REFLECT lease claim ──
// failed 전이(max 초과 & lease 만료/error) 먼저 → 단일 SQL 원자 claim(attempt_count+1<=MAX).
export function tryStartReflection(roundId: string, hashVersion = HASH_VERSION): Claim | null {
  const db = getDb();
  const ownerId = crypto.randomUUID();
  const now = nowISO();
  const lease = futureISO(LEASE_MS);

  const tx = db.transaction(() => {
    // 1) max 초과 + (error 또는 lease 만료 started) → failed (실행 중 runner는 안 건드림)
    db.prepare(
      `UPDATE meeting_reflections SET status='failed', updated_at=@now
       WHERE round_id=@rid AND attempt_count>=@max
         AND (status='error' OR (status='started' AND lease_until < @now))`
    ).run({ rid: roundId, max: MAX_ATTEMPTS, now });

    // 2) 원자 claim: 신규 INSERT(attempt_count=1) 또는 재claim(만료/backoff & attempt+1<=MAX)
    db.prepare(
      `INSERT INTO meeting_reflections (round_id, status, hash_version, owner_id, lease_until, updated_at, attempt_count, created_at)
       VALUES (@rid, 'started', @hv, @owner, @lease, @now, 1, @now)
       ON CONFLICT(round_id) DO UPDATE SET
         status='started', owner_id=@owner, lease_until=@lease, updated_at=@now,
         attempt_count = meeting_reflections.attempt_count + 1
       WHERE meeting_reflections.attempt_count + 1 <= @max
         AND ( (meeting_reflections.status='started' AND meeting_reflections.lease_until < @now)
            OR (meeting_reflections.status='error'   AND (meeting_reflections.next_retry_at IS NULL OR meeting_reflections.next_retry_at <= @now)) )`
    ).run({ rid: roundId, hv: hashVersion, owner: ownerId, lease, now, max: MAX_ATTEMPTS });

    const row = db.prepare(`SELECT owner_id, lease_until, hash_version, status FROM meeting_reflections WHERE round_id=?`)
      .get(roundId) as { owner_id?: string; lease_until?: string; hash_version?: number; status?: string } | undefined;
    if (row && row.owner_id === ownerId && row.status === 'started') {
      return { ownerId, leaseUntil: row.lease_until || lease, hashVersion: row.hash_version ?? hashVersion };
    }
    return null;
  });
  return tx();
}

function holdsLease(roundId: string, ownerId: string): boolean {
  const db = getDb();
  const r = db.prepare(
    `SELECT 1 FROM meeting_reflections WHERE round_id=? AND owner_id=? AND status='started' AND lease_until > ?`
  ).get(roundId, ownerId, nowISO());
  return !!r;
}

const PROMOTE_EVIDENCE = 3;  // #71: evidence_count 이 이상이면 lesson→skill 승격

// ── evidence-first 멱등 write ──
// 1 lease 가드 → 2 span upsert + link claim(fingerprint) → 3 canonical upsert(충돌 처리) + link.memory_id fill + count.
export function addMemoryIdempotent(l: Lesson, roundId: string, ownerId: string, hashVersion = HASH_VERSION): void {
  const db = getDb();
  const tx = db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return; // lease 잃은 느린 runner write 금지

    // span upsert
    const ev = db.prepare(
      `INSERT INTO memory_evidence (agent_id, round_id, evidence_seq, excerpt, excerpt_start, excerpt_end)
       VALUES (@aid, @rid, @seq, @ex, @s, @e)
       ON CONFLICT(round_id, agent_id, evidence_seq, excerpt_start, excerpt_end)
       DO UPDATE SET excerpt=excluded.excerpt RETURNING id`
    ).get({ aid: l.agentId, rid: roundId, seq: l.evidenceSeq, ex: l.excerpt ?? '', s: l.excerptStart, e: l.excerptEnd }) as { id: number };
    const evidenceId = ev.id;

    const fingerprint = lessonFingerprint(hashVersion, l.content, l.evidenceSeq, l.excerptStart, l.excerptEnd);
    const requestedHash = lessonHash(hashVersion, l.content);

    // link claim — memory_id NULL일 때만 candidate 갱신(CASE), NOT NULL이면 immutable. 항상 row 회수.
    const link = db.prepare(
      `INSERT INTO memory_evidence_links
         (evidence_id, memory_id, lesson_index, lesson_fingerprint, importance, content, requested_hash, hash_version, updated_at)
       VALUES (@eid, NULL, @idx, @fp, @imp, @content, @rhash, @hv, @now)
       ON CONFLICT(evidence_id, lesson_fingerprint) DO UPDATE SET
         content    = CASE WHEN memory_evidence_links.memory_id IS NULL THEN excluded.content    ELSE memory_evidence_links.content    END,
         importance = CASE WHEN memory_evidence_links.memory_id IS NULL THEN excluded.importance ELSE memory_evidence_links.importance END,
         requested_hash = CASE WHEN memory_evidence_links.memory_id IS NULL THEN excluded.requested_hash ELSE memory_evidence_links.requested_hash END,
         updated_at = @now
       RETURNING id, memory_id`
    ).get({ eid: evidenceId, idx: l.lessonIndex ?? 0, fp: fingerprint, imp: l.importance ?? 5, content: l.content, rhash: requestedHash, hv: hashVersion, now: nowISO() }) as { id: number; memory_id: number | null };

    if (link.memory_id != null) return; // 이미 완결

    resolveCanonical(l.agentId, l.content, l.importance ?? 5, requestedHash, hashVersion, link.id);
  });
  tx();
}

// canonical upsert + 충돌 분리 + link.memory_id/canonical_hash fill + evidence_count 재계산.
function resolveCanonical(
  agentId: string, content: string, importance: number, requestedHash: string, hashVersion: number, linkId: number
): void {
  const db = getDb();
  // #44: normalized_hash 일치 = 정규화-동일 → 항상 merge(Supabase add_memory_link RPC와 의미 통일).
  // 과거의 SHA 충돌 대비 secondary split은 SHA-256 충돌 확률 ~0이라 사실상 dead code → 제거(백엔드 불일치 해소).
  const canonicalHash = requestedHash;
  const collisionGroup: string | null = null;

  const now = nowISO();
  const canon = db.prepare(
    `INSERT INTO agent_memory
       (agent_id, memory_type, content, importance, source_id, created_at,
        normalized_hash, hash_version, current_type, status, confidence, evidence_count, last_seen_at, hash_collision_group)
     VALUES (@aid, 'lesson', @content, @imp, NULL, @now,
        @nhash, @hv, 'lesson', 'active', 0.5, 0, @now, @cg)
     ON CONFLICT(agent_id, normalized_hash) WHERE normalized_hash IS NOT NULL DO UPDATE SET last_seen_at=@now
     RETURNING id`
  ).get({ aid: agentId, content, imp: importance, now, nhash: canonicalHash, hv: hashVersion, cg: collisionGroup }) as { id: number };
  const memoryId = canon.id;

  db.prepare(`UPDATE memory_evidence_links SET memory_id=?, canonical_hash=?, updated_at=? WHERE id=?`)
    .run(memoryId, canonicalHash, now, linkId);

  // evidence_count = 연결된 distinct link 수(증분 X — 복원 중복 방지)
  const cnt = db.prepare(`SELECT COUNT(*) AS c FROM memory_evidence_links WHERE memory_id=?`).get(memoryId) as { c: number };
  db.prepare(`UPDATE agent_memory SET evidence_count=?, last_seen_at=? WHERE id=?`).run(cnt.c, now, memoryId);
  // #71(IMPROVE): 반복 교훈(evidence_count>=임계) → skill 승격 + confidence↑(identity 불변). retire(반례 obsolete)는 추후.
  if (cnt.c >= PROMOTE_EVIDENCE) {
    db.prepare(`UPDATE agent_memory SET current_type='skill', confidence=min(1.0, COALESCE(confidence,0.5)+0.1) WHERE id=? AND current_type<>'skill'`).run(memoryId);
  }
}

// orphan link(memory_id NULL) 복원 — link.content 기반으로 canonical 재구성(LLM 불필요).
export function repairOrphanEvidence(roundId: string, ownerId: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return false;
    const orphans = db.prepare(
      `SELECT lk.id, lk.content, lk.requested_hash, lk.hash_version, ev.agent_id, lk.importance
       FROM memory_evidence_links lk JOIN memory_evidence ev ON lk.evidence_id = ev.id
       WHERE ev.round_id=? AND lk.memory_id IS NULL`
    ).all(roundId) as Array<{ id: number; content: string; requested_hash: string; hash_version: number; agent_id: string; importance: number }>;
    for (const o of orphans) {
      resolveCanonical(o.agent_id, o.content, o.importance ?? 5, o.requested_hash, o.hash_version ?? HASH_VERSION, o.id);
    }
    return true;
  });
  return tx();
}

export function countRoundLinks(roundId: string): number {
  const db = getDb();
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM memory_evidence_links lk JOIN memory_evidence ev ON lk.evidence_id=ev.id WHERE ev.round_id=?`
  ).get(roundId) as { c: number };
  return r.c;
}

// 전수 memory_id NOT NULL이면 done. lesson_count = round link 집계.
export function finishReflection(roundId: string, ownerId: string): boolean {
  const db = getDb();
  const tx = db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return false;
    const orphan = db.prepare(
      `SELECT 1 FROM memory_evidence_links lk JOIN memory_evidence ev ON lk.evidence_id=ev.id
       WHERE ev.round_id=? AND lk.memory_id IS NULL LIMIT 1`
    ).get(roundId);
    if (orphan) return false; // orphan 남으면 done 금지
    const count = countRoundLinks(roundId);
    db.prepare(`UPDATE meeting_reflections SET status='done', lesson_count=?, updated_at=? WHERE round_id=? AND owner_id=?`)
      .run(count, nowISO(), roundId, ownerId);
    return true;
  });
  return tx();
}

// 명시적 빈 결과(LLM이 []) → no_lessons terminal.
export function markNoLessons(roundId: string, ownerId: string): void {
  const db = getDb();
  db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return;
    db.prepare(`UPDATE meeting_reflections SET status='no_lessons', updated_at=? WHERE round_id=? AND owner_id=?`).run(nowISO(), roundId, ownerId);
  })();
}
// LLM/파싱 실패 등 일시 오류 → error+next_retry_at(워치독이 재개, #1). terminal 아님.
export function markError(roundId: string, ownerId: string, msg = ''): void {
  const db = getDb();
  db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return;
    db.prepare(`UPDATE meeting_reflections SET status='error', next_retry_at=?, error=?, updated_at=? WHERE round_id=? AND owner_id=?`)
      .run(futureISO(RETRY_BACKOFF_MS), String(msg).slice(0, 300), nowISO(), roundId, ownerId);
  })();
}
// LLM이 교훈을 출력했으나 전부 attribution 검증 실패 → failed_validation terminal(재추출 무의미, no_lessons와 구분, #22).
export function markFailedValidation(roundId: string, ownerId: string): void {
  const db = getDb();
  db.transaction(() => {
    if (!holdsLease(roundId, ownerId)) return;
    db.prepare(`UPDATE meeting_reflections SET status='failed_validation', updated_at=? WHERE round_id=? AND owner_id=?`).run(nowISO(), roundId, ownerId);
  })();
}
// #77/#82(IMPROVE retire): 오염 메모리 은퇴 — obsolete(retrieve 제외) + confidence↓. normalized_hash 기준(정규화-동일 retire).
export function retireMemory(agentId: string, content: string): boolean {
  const db = getDb();
  const nh = lessonHash(HASH_VERSION, content);
  // #87: normalized_hash(현재 버전) OR content(다른 hash_version·legacy) 둘 다 매칭 → 버전 migration 후에도 retire.
  const r = db.prepare(`UPDATE agent_memory SET status='obsolete', confidence=max(0, COALESCE(confidence,0.5)-0.3) WHERE agent_id=? AND (normalized_hash=? OR content=?) AND status='active'`).run(agentId, nh, content);
  return r.changes > 0;
}

// #79: legacy marker에 재구성한 round 경계 저장(from_seq NULL일 때만 — 이미 있으면 보존).
export function setLegacyBounds(roundId: string, fromSeq: number, toSeq: number): void {
  const db = getDb();
  db.prepare(`UPDATE meeting_reflections SET from_seq=?, to_seq=? WHERE round_id=? AND from_seq IS NULL`).run(fromSeq, toSeq, roundId);
}

// #69: batch9 이전 marker는 from_seq NULL(round 경계 미저장) → superseded(followup 발생) 시 resume하면
// 현재 chairman 기준으로 옛 round 오염. 경계 복원 불가 → failed terminal로 skip(경계 있는 marker는 false=정상 재개).
export function failIfLegacyStale(roundId: string): boolean {
  const db = getDb();
  const r = db.prepare(`SELECT from_seq FROM meeting_reflections WHERE round_id=?`).get(roundId) as { from_seq?: number | null } | undefined;
  if (r && (r.from_seq === null || r.from_seq === undefined)) {
    db.prepare(`UPDATE meeting_reflections SET status='failed', updated_at=? WHERE round_id=? AND status IN ('error','started')`).run(nowISO(), roundId);
    return true;
  }
  return false;
}

// 현재 round의 attempt_count(재시도 한도 판정용, #30).
function attemptCount(roundId: string): number {
  const db = getDb();
  const r = db.prepare(`SELECT attempt_count FROM meeting_reflections WHERE round_id=?`).get(roundId) as { attempt_count?: number } | undefined;
  return Number(r?.attempt_count ?? 0);
}
export const retryOrGiveUp = markNoLessons;  // 하위호환 별칭

// ── RETRIEVE: 에이전트별 과거 학습을 fenced user-context로 ──
const RETRIEVE_LIMIT = 5;
const PER_MEM_CHARS = 300;
const TOTAL_CHARS = 1200;

type MemRow = { content: string; current_type?: string; importance?: number };

// 비신뢰 학습 메모리를 낮은 권한 블록으로 렌더. systemPrompt 직접 주입 금지(injection 전파 차단).
// 감쇠(#29): evidence_count<=1(미보강)이면서 STALE_DAYS 넘게 미참조한 메모리는 retrieve에서 제외(자동 obsolete).
export function getRetrieveBlock(agentId: string): string {
  const db = getDb();
  const cutoff = new Date(Date.now() - STALE_DAYS * 86400_000).toISOString();
  const rows = db.prepare(
    `SELECT content, current_type, importance FROM agent_memory
     WHERE agent_id=? AND (status='active' OR status IS NULL)
       AND NOT (COALESCE(evidence_count,0) <= 1 AND COALESCE(last_seen_at, created_at) < ?)
     ORDER BY importance DESC, COALESCE(evidence_count,0) DESC, last_seen_at DESC, created_at DESC LIMIT ?`
  ).all(agentId, cutoff, RETRIEVE_LIMIT) as MemRow[];
  if (!rows.length) return '';
  let total = 0;
  const lines: string[] = [];
  for (const r of rows) {
    const c = String(r.content || '').slice(0, PER_MEM_CHARS);
    if (total + c.length > TOTAL_CHARS) break;
    total += c.length;
    lines.push(`- (${r.current_type || 'memory'}) ${c}`);
  }
  if (!lines.length) return '';
  return untrustedBlock('UNTRUSTED_LEARNED_CONTEXT', lines.join('\n'));
}

// 이미 종결된 round면 LLM 생략용 cheap 체크(#1: extract 전 호출).
export function isReflectionTerminal(roundId: string): boolean {
  const db = getDb();
  const r = db.prepare(`SELECT status FROM meeting_reflections WHERE round_id=?`).get(roundId) as { status?: string } | undefined;
  return !!r && (r.status === 'done' || r.status === 'no_lessons' || r.status === 'failed' || r.status === 'failed_validation');
}

// REFLECT 1회: claim(단일 추출자) → extract(LLM, lease 5분 내) → ok/fail 분기 → 저장 → repair → finish.
// claim-first: 동시 runner 중복 LLM·valid 폐기 방지(#3). lease 5분 > LLM → 만료 silent failure 차단(#1/#2).
// done 확정 '전' 동기 호출: marker(claim) 선점만(LLM extract 분리). terminal/live-lease면 null.
// → 회의가 done 되기 전 항상 marker가 존재 → crash 시 started lease 만료 후 워치독이 재개(#18/#22 근본해결).
export function reserveReflection(meetingId: string, version: number, fromSeq?: number, toSeq?: number): Claim | null {
  const roundId = `${meetingId}:${version}`;
  const claim = tryStartReflection(roundId, HASH_VERSION);
  if (!claim) return null;
  const db = getDb();
  // 경계(#60): 최초 reserve일 때만 저장(from_seq IS NULL), 재claim은 원래 경계 보존. owner-guarded.
  if (fromSeq != null && toSeq != null) {
    db.prepare(`UPDATE meeting_reflections SET from_seq=?, to_seq=? WHERE round_id=? AND owner_id=? AND from_seq IS NULL`).run(fromSeq, toSeq, roundId, claim.ownerId);
  }
  const b = db.prepare(`SELECT from_seq, to_seq FROM meeting_reflections WHERE round_id=?`).get(roundId) as { from_seq?: number; to_seq?: number } | undefined;
  return { ...claim, fromSeq: b?.from_seq ?? undefined, toSeq: b?.to_seq ?? undefined };
}

// 선점한 claim으로 extract~finish(재claim 안 함). reserveReflection → done → 이 함수(background) 순서.
export async function runReflectionWithClaim(meetingId: string, version: number, claim: Claim, allRows: ReflectRow[], agenda: string, llm: LlmFn): Promise<void> {
  const roundId = `${meetingId}:${version}`;
  const reflectRows = buildReflectRows(allRows, claim.fromSeq, claim.toSeq); // #60: 저장된 round 경계로 필터(followup 무관)
  const ext = await extractLessons(agenda, reflectRows, llm);
  if (!ext.ok) { markError(roundId, claim.ownerId, 'extract failed (llm/parse)'); return; } // #1: 일시 실패 → error(재개), no_lessons 아님
  const valid = validateLessons(ext.lessons, reflectRows, claim.hashVersion);
  for (const l of valid) addMemoryIdempotent(l, roundId, claim.ownerId, claim.hashVersion);
  const hasLinks = countRoundLinks(roundId) > 0;
  if (valid.length === 0 && !hasLinks) {
    if (ext.lessons.length === 0) { markNoLessons(roundId, claim.ownerId); return; } // 진짜 빈 결과 → terminal
    // raw non-empty + valid empty: attribution은 LLM 비결정적 → MAX_ATTEMPTS까지 error 재시도, 도달 시에만 failed_validation(#30)
    if (attemptCount(roundId) >= MAX_ATTEMPTS) markFailedValidation(roundId, claim.ownerId);
    else markError(roundId, claim.ownerId, 'no valid lessons (attribution failed)');
    return;
  }
  repairOrphanEvidence(roundId, claim.ownerId);
  const done = finishReflection(roundId, claim.ownerId);
  if (!done) console.warn('reflection not finalized (lease lost?):', roundId);
}

// reserve + extract 합성(워치독 재개 경로). claim 없으면(terminal/live) LLM 생략.
export async function runReflection(meetingId: string, version: number, allRows: ReflectRow[], agenda: string, llm: LlmFn): Promise<void> {
  const { fromSeq, toSeq } = roundBounds(allRows);
  const claim = reserveReflection(meetingId, version, fromSeq, toSeq); // 신규면 경계 저장, 재claim이면 무시(저장된 것 사용)
  if (!claim) return;
  await runReflectionWithClaim(meetingId, version, claim, allRows, agenda, llm);
}

// 워치독: 재개 대상 round_id — error(backoff 경과) 또는 started(lease 만료).
// attempt 필터 없음(#2 v8): max 도달 row도 포함해야 tryStartReflection의 failed 전이가 실행됨(아니면 error 영구체류).
export function listPendingReflections(limit = 20): string[] {
  const db = getDb();
  const now = nowISO();
  const rows = db.prepare(
    `SELECT round_id FROM meeting_reflections
     WHERE (status='error' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        OR (status='started' AND lease_until < ?)
     ORDER BY updated_at ASC LIMIT ?`
  ).all(now, now, limit) as Array<{ round_id: string }>;
  // done 전 marker 선점(reserveReflection)으로 모든 done 회의가 marker 보유 → orphan 스캔 불필요(#22).
  return rows.map((r) => r.round_id);
}

export const _internals = { MAX_ATTEMPTS, LEASE_MS };
