/**
 * Quorum Database Abstraction Layer
 * Supports: SQLite (default) | Supabase
 */

import { supabase } from './supabase';
import * as supaDb from './supabase-db';

export type DbProvider = 'sqlite' | 'supabase';
type DbQueryOptions = {
  where?: Record<string, unknown>;
  like?: Record<string, string>;
  orderBy?: string;
  ascending?: boolean;
  limit?: number;
};

export function getDbProvider(): DbProvider {
  if (process.env.DB_PROVIDER) {
    if (process.env.DB_PROVIDER === 'sqlite' || process.env.DB_PROVIDER === 'supabase') {
      return process.env.DB_PROVIDER;
    }
    throw new Error('DB_PROVIDER invalid: expected sqlite or supabase');
  }
  // Legacy detection: if Supabase env vars are set, use supabase
  const hasSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasSupabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (hasSupabaseUrl && hasSupabaseKey) {
    return 'supabase';
  }
  return 'sqlite';
}

const provider = getDbProvider();
const USE_SUPABASE = provider === 'supabase';

// 과거/손상 데이터로 JSON.parse가 throw해 라우트 전체가 죽지 않도록 안전 파싱
function safeJsonParse<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function getSupabase() {
  return supabase;
}
function nodeRequire<T>(modulePath: string): T {
  const req = (0, eval)('require') as NodeRequire;
  return req(modulePath) as T;
}
function getSqlite() {
  const { getDb } = nodeRequire<typeof import('./sqlite')>('./sqlite');
  return getDb();
}
// better-sqlite3는 객체/배열을 바인딩 못 함 → 회의 payload 같은 객체값은 JSON 문자열로 직렬화.
// (supabase는 JSONB 컬럼이라 객체 그대로 둠 — sqlite write 경로에서만 적용)
function sqliteValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

function assertSqlIdentifier(value: string, label = 'identifier'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`${label} invalid`);
  }
  return value;
}

function assertSqlRecordKeys(record: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(record)) assertSqlIdentifier(key, label);
}

function clampLimit(limit: unknown, fallback: number, max: number): number {
  const n = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function optionalLimit(limit: unknown): number | undefined {
  if (limit == null) return undefined;
  return clampLimit(limit, 100, 1000);
}

// ─── Unified DB Functions (new interface for gradual migration) ───

export async function dbQuery(
  table: string,
  options?: DbQueryOptions
): Promise<unknown[]> {
  const safeTable = assertSqlIdentifier(table, 'table');
  // orderBy는 raw SQL에 보간되므로 컬럼명 화이트리스트로 SQL injection 차단(sqlite)
  if (options?.orderBy && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.orderBy)) {
    options = { ...options, orderBy: undefined };
  }
  if (options?.where) assertSqlRecordKeys(options.where, 'where column');
  if (options?.like) assertSqlRecordKeys(options.like, 'like column');
  const safeLimit = optionalLimit(options?.limit);
  if (USE_SUPABASE) {
    return supaDb.query(safeTable, { ...(options || {}), ...(safeLimit ? { limit: safeLimit } : {}) });
  }
  // SQLite
  const db = getSqlite();
  let sql = `SELECT * FROM ${safeTable}`;
  const params: unknown[] = [];
  const clauses: string[] = [];
  if (options?.where) {
    clauses.push(...Object.entries(options.where).map(([col]) => {
      return `${col} = ?`;
    }));
    params.push(...Object.values(options.where));
  }
  if (options?.like) {
    clauses.push(...Object.entries(options.like).map(([col, val]) => {
      params.push(val);
      return `${col} LIKE ?`;
    }));
  }
  if (clauses.length) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  if (options?.orderBy) {
    sql += ` ORDER BY ${options.orderBy} ${options.ascending ? 'ASC' : 'DESC'}`;
  }
  if (safeLimit) {
    sql += ` LIMIT ${safeLimit}`;
  }
  return db.prepare(sql).all(...params);
}

export async function dbInsert(table: string, data: Record<string, unknown>): Promise<unknown> {
  const safeTable = assertSqlIdentifier(table, 'table');
  assertSqlRecordKeys(data, 'insert column');
  if (USE_SUPABASE) {
    return supaDb.insert(safeTable, data);
  }
  const db = getSqlite();
  const cols = Object.keys(data);
  const vals = Object.values(data).map(sqliteValue);
  const placeholders = cols.map(() => '?');
  const result = db.prepare(`INSERT INTO ${safeTable} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`).run(...vals);
  return { id: result.lastInsertRowid, ...data };
}

export async function dbInsertIdempotent(table: string, data: Record<string, unknown>): Promise<unknown | null> {
  const safeTable = assertSqlIdentifier(table, 'table');
  assertSqlRecordKeys(data, 'insert column');
  if (USE_SUPABASE) {
    return supaDb.insertIdempotent(safeTable, data);
  }
  try {
    return await dbInsert(table, data);
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === '23505' || /unique/i.test(err.message || '')) return null;
    throw e;
  }
}

export async function dbUpdate(table: string, id: string, data: Record<string, unknown>): Promise<unknown> {
  const safeTable = assertSqlIdentifier(table, 'table');
  assertSqlRecordKeys(data, 'update column');
  if (Object.keys(data).length === 0) return { id };
  if (USE_SUPABASE) {
    return supaDb.update(safeTable, id, data);
  }
  const db = getSqlite();
  const entries = Object.entries(data);
  const setClauses = entries.map(([col]) => `${col} = ?`);
  const vals = [...entries.map(([, v]) => sqliteValue(v)), id];
  db.prepare(`UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals);
  return { id, ...data };
}

export async function dbUpdateWhere(
  table: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<unknown[]> {
  const safeTable = assertSqlIdentifier(table, 'table');
  assertSqlRecordKeys(where, 'where column');
  assertSqlRecordKeys(data, 'update column');
  if (Object.keys(where).length === 0 || Object.keys(data).length === 0) return [];
  if (USE_SUPABASE) {
    return supaDb.updateWhere(safeTable, where, data);
  }
  const db = getSqlite();
  const updates = Object.entries(data);
  const filters = Object.entries(where);
  const setClauses = updates.map(([col]) => `${col} = ?`);
  const whereClauses = filters.map(([col]) => `${col} = ?`);
  const vals = [...updates.map(([, v]) => sqliteValue(v)), ...filters.map(([, v]) => sqliteValue(v))];
  const res = db.prepare(`UPDATE ${safeTable} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`).run(...vals);
  return res.changes > 0 ? [{ ...where, ...data }] : [];
}

export async function dbDelete(table: string, id: string): Promise<void> {
  const safeTable = assertSqlIdentifier(table, 'table');
  if (USE_SUPABASE) {
    return supaDb.remove(safeTable, id);
  }
  getSqlite().prepare(`DELETE FROM ${safeTable} WHERE id = ?`).run(id);
}

export async function dbDeleteWhere(table: string, where: Record<string, unknown>): Promise<void> {
  const safeTable = assertSqlIdentifier(table, 'table');
  assertSqlRecordKeys(where, 'where column');
  if (Object.keys(where).length === 0) return;
  if (USE_SUPABASE) {
    return supaDb.removeWhere(safeTable, where);
  }
  const db = getSqlite();
  const filters = Object.entries(where);
  const clauses = filters.map(([col]) => `${col} = ?`);
  db.prepare(`DELETE FROM ${safeTable} WHERE ${clauses.join(' AND ')}`).run(...filters.map(([, v]) => v));
}

export async function dbGet(table: string, id: string): Promise<unknown> {
  const safeTable = assertSqlIdentifier(table, 'table');
  if (USE_SUPABASE) {
    const client = getSupabase();
    const { data } = await client.from(safeTable).select('*').eq('id', id).single();
    return data;
  }
  return getSqlite().prepare(`SELECT * FROM ${safeTable} WHERE id = ?`).get(id);
}

export async function allocateMeetingSeq(meetingId: string): Promise<number> {
  if (USE_SUPABASE) {
    return supaDb.allocateMeetingSeq(meetingId);
  }
  const db = getSqlite();
  const row = db.prepare('SELECT next_seq FROM meetings WHERE id = ?').get(meetingId) as { next_seq?: number } | undefined;
  if (!row) throw new Error(`Meeting not found: ${meetingId}`);
  const seq = Number(row.next_seq || 1);
  db.prepare("UPDATE meetings SET next_seq = ?, updated_at = datetime('now') WHERE id = ?").run(seq + 1, meetingId);
  return seq;
}

// followup 에이전트 추가 원자화(agent_order||추가 + version++ + status='running'). 새 version 반환.
export async function appendMeetingAgents(meetingId: string, agents: string[]): Promise<number> {
  if (USE_SUPABASE) {
    return supaDb.appendMeetingAgents(meetingId, agents);
  }
  const db = getSqlite();
  const row = db.prepare('SELECT agent_order, version FROM meetings WHERE id = ?').get(meetingId) as { agent_order?: string; version?: number } | undefined;
  if (!row) throw new Error(`Meeting not found: ${meetingId}`);
  const order = [...(JSON.parse(row.agent_order || '[]') as string[]), ...agents];
  const version = Number(row.version || 0) + 1;
  db.prepare("UPDATE meetings SET agent_order = ?, version = ?, status = 'running', updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(order), version, meetingId);
  return version;
}

// #61: followup 전환 원자화 — meeting_end/finalize(검증·종합) 삭제 + chairman 발언 삽입 + agent_order append + version++/status running을
// 단일 transaction(sqlite) / RPC(supabase)로. 중간 실패 시 전부 롤백(반쪽 상태 방지).
// #2(P1): expectedVersion 지정 시 version CAS — 동시 followup 2건이면 패자는 CAS 불일치로 거부(chairman·agent_order 이중 append 방지).
export class FollowupVersionConflict extends Error {
  constructor(meetingId: string) { super(`Followup version conflict: ${meetingId}`); this.name = 'FollowupVersionConflict'; }
}
export async function followupTransition(
  meetingId: string, agents: string[], userMsg: string, finalizeSlots: number[],
  chairman: { agent_name: string; number: string; role: string }, expectedVersion?: number,
): Promise<void> {
  if (USE_SUPABASE) {
    // supabase RPC 시그니처를 바꾸지 않고(재배포 불필요) version CAS를 앞단에서 claim — 동시 followup 패자는 0행이라 거부.
    // RPC가 뒤에서 version++을 또 하지만(총 +2) version은 단조증가 CAS 토큰일 뿐이라 무해(runner의 done/finalize CAS는 값 불일치만 검사).
    if (expectedVersion != null) {
      const claimed = await dbUpdateWhere('meetings', { id: meetingId, version: expectedVersion }, { version: expectedVersion + 1 });
      if (!claimed.length) throw new FollowupVersionConflict(meetingId);
    }
    return supaDb.followupTransition(meetingId, agents, userMsg, finalizeSlots, chairman);
  }
  const db = getSqlite();
  db.transaction(() => {
    const row = db.prepare('SELECT next_seq, agent_order, version FROM meetings WHERE id = ?').get(meetingId) as { next_seq?: number; agent_order?: string; version?: number } | undefined;
    if (!row) throw new Error(`Meeting not found: ${meetingId}`);
    // CAS: 기대 version 불일치면 삭제/삽입 전에 중단(트랜잭션 롤백) → 반쪽 상태·이중 append 없음.
    if (expectedVersion != null && Number(row.version || 0) !== expectedVersion) throw new FollowupVersionConflict(meetingId);
    db.prepare("DELETE FROM meeting_messages WHERE meeting_id = ? AND type = 'meeting_end'").run(meetingId);
    for (const slot of finalizeSlots) db.prepare('DELETE FROM meeting_messages WHERE meeting_id = ? AND slot = ?').run(meetingId, slot);
    const seq = Number(row.next_seq || 1);
    db.prepare('INSERT INTO meeting_messages (meeting_id, seq, type, agent_id, agent_name, number, role, message) VALUES (?,?,?,?,?,?,?,?)')
      .run(meetingId, seq, 'message', 'chairman', chairman.agent_name, chairman.number, chairman.role, userMsg);
    const order = [...(JSON.parse(row.agent_order || '[]') as string[]), ...agents];
    db.prepare("UPDATE meetings SET next_seq = ?, agent_order = ?, version = ?, status = 'running', updated_at = datetime('now') WHERE id = ?")
      .run(seq + 1, JSON.stringify(order), Number(row.version || 0) + 1, meetingId);
  })();
}

// ─── Legacy API (full backward compatibility) ───

export async function saveMessage(agentId: string, role: 'user' | 'assistant', content: string) {
  if (USE_SUPABASE) return getSupabase().from('conversations').insert({ agent_id: agentId, role, content });
  return getSqlite().prepare('INSERT INTO conversations (agent_id, role, content) VALUES (?, ?, ?)').run(agentId, role, content);
}
export async function getConversationHistory(agentId: string, limit = 20) {
  const safeLimit = clampLimit(limit, 20, 100);
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('conversations').select('*').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(safeLimit);
    return (data || []).reverse();
  }
  return getSqlite().prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, safeLimit).reverse();
}
export async function saveReport(agentId: string, title: string, content: string, reportType = 'general', meetingId?: string) {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('reports').insert({ agent_id: agentId, title, content, report_type: reportType, meeting_id: meetingId }).select().single();
    return data;
  }
  const db = getSqlite(); const id = crypto.randomUUID();
  db.prepare('INSERT INTO reports (id, agent_id, title, content, report_type, meeting_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, agentId, title, content, reportType, meetingId || null);
  return { id, agent_id: agentId, title, content, report_type: reportType, meeting_id: meetingId, status: 'pending' };
}

// 같은 안건의 회의 보고서는 새로 만들지 않고 갱신(추가 질문/이어하기 중복 방지)
export async function upsertMeetingReport(title: string, content: string) {
  try {
    const existing = await dbQuery('reports', {
      where: { report_type: 'meeting', title },
      orderBy: 'created_at',
      ascending: false,
      limit: 1,
    }) as Array<{ id: string }>;
    if (existing[0]?.id) {
      return await dbUpdate('reports', existing[0].id, { content });
    }
  } catch { /* 조회 실패 시 새로 저장 */ }
  return saveReport('lead', title, content, 'meeting');
}

// 같은 directive의 보고서는 재실행해도 새로 만들지 않고 갱신
export async function upsertDirectiveReport(directiveId: string, title: string, content: string) {
  try {
    const existing = await dbQuery('reports', {
      where: { directive_id: directiveId, report_type: 'directive_report' },
      orderBy: 'created_at',
      ascending: false,
      limit: 1,
    }) as Array<{ id: string }>;
    if (existing[0]?.id) {
      await dbUpdate('reports', existing[0].id, { title, content });
      return existing[0].id;
    }
  } catch { /* 조회 실패 시 새로 저장 */ }
  const id = crypto.randomUUID();
  try {
    await dbInsert('reports', {
      id, agent_id: 'lead', title, content,
      report_type: 'directive_report', status: 'pending', directive_id: directiveId,
    });
    return id;
  } catch (e) {
    // race: 동시 insert가 directive_id unique 제약을 위반하면 기존 보고서를 갱신하는 쪽으로 수렴
    const again = await dbQuery('reports', {
      where: { directive_id: directiveId, report_type: 'directive_report' },
      orderBy: 'created_at', ascending: false, limit: 1,
    }) as Array<{ id: string }>;
    if (again[0]?.id) {
      await dbUpdate('reports', again[0].id, { title, content });
      return again[0].id;
    }
    throw e;
  }
}

// #92/#93: directive 종료를 원자적으로 — status 전이 + report upsert를 한 트랜잭션/RPC로.
// terminal이면 {ok:false}(report side-effect 없음). active면 status+report 동시 커밋(중간 crash로 'completed인데 report 없음' 방지).
const FINAL_TERMS = ['rejected', 'completed', 'completed_with_errors', 'deleted']; // #105: deleted도 완료 전이 금지(부활 차단)
export async function finalizeDirectiveWithReport(
  directiveId: string, title: string, content: string, status: string, progress?: string,
): Promise<{ ok: boolean; reportId?: string }> {
  if (USE_SUPABASE) {
    const { data, error } = await getSupabase().rpc('finalize_directive_with_report', {
      p_directive_id: directiveId, p_title: title, p_content: content, p_status: status, p_progress: progress ?? null,
    });
    if (error) { console.error('finalizeDirectiveWithReport rpc:', error); return { ok: false }; }
    const r = (Array.isArray(data) ? data[0] : data) as { ok?: boolean; report_id?: string } | null;
    return { ok: !!r?.ok, reportId: r?.report_id };
  }
  const db = getSqlite();
  const txn = db.transaction((): { ok: boolean; reportId?: string } => {
    const cur = db.prepare('SELECT status FROM decisions WHERE id = ?').get(directiveId) as { status?: string } | undefined;
    if (cur && FINAL_TERMS.includes(String(cur.status))) return { ok: false };
    const existing = db.prepare("SELECT id FROM reports WHERE directive_id = ? AND report_type = 'directive_report' ORDER BY created_at DESC LIMIT 1").get(directiveId) as { id?: string } | undefined;
    let reportId: string;
    if (existing?.id) {
      db.prepare('UPDATE reports SET title = ?, content = ? WHERE id = ?').run(title, content, existing.id);
      reportId = existing.id;
    } else {
      reportId = crypto.randomUUID();
      db.prepare("INSERT INTO reports (id, agent_id, title, content, report_type, status, directive_id) VALUES (?,?,?,?,?,?,?)")
        .run(reportId, 'lead', title, content, 'directive_report', 'pending', directiveId);
    }
    if (progress !== undefined) db.prepare("UPDATE decisions SET status = ?, progress = ?, updated_at = datetime('now') WHERE id = ?").run(status, progress, directiveId);
    else db.prepare("UPDATE decisions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, directiveId);
    return { ok: true, reportId };
  });
  try { return txn(); } catch (e) { console.error('finalizeDirectiveWithReport sqlite:', e); return { ok: false }; }
}

export async function getPendingReports() {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('reports').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC').all('pending');
}
export async function updateReportStatus(reportId: string, status: 'approved' | 'rejected') {
  if (USE_SUPABASE) return getSupabase().from('reports').update({ status, reviewed_at: new Date().toISOString() }).eq('id', reportId);
  return getSqlite().prepare("UPDATE reports SET status = ?, reviewed_at = datetime('now') WHERE id = ?").run(status, reportId);
}
export async function addMemory(agentId: string, memoryType: string, content: string, importance = 5, sourceId?: string) {
  if (USE_SUPABASE) return getSupabase().from('agent_memory').insert({ agent_id: agentId, memory_type: memoryType, content, importance, source_id: sourceId });
  return getSqlite().prepare('INSERT INTO agent_memory (agent_id, memory_type, content, importance, source_id) VALUES (?, ?, ?, ?, ?)').run(agentId, memoryType, content, importance, sourceId || null);
}
export async function getAgentMemories(agentId: string, limit = 10) {
  const safeLimit = clampLimit(limit, 10, 50);
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('agent_memory').select('*').eq('agent_id', agentId).order('importance', { ascending: false }).order('created_at', { ascending: false }).limit(safeLimit);
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?').all(agentId, safeLimit);
}
export async function enqueueChat(agentId: string, message: string, model?: string, systemPrompt?: string, metadata?: Record<string, unknown>) {
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('chat_queue').insert({ agent_id: agentId, message, model, system_prompt: systemPrompt || null, metadata: metadataJson, status: 'pending' }).select().single();
    return data;
  }
  const result = getSqlite().prepare('INSERT INTO chat_queue (agent_id, message, model, system_prompt, metadata) VALUES (?, ?, ?, ?, ?)').run(agentId, message, model || null, systemPrompt || null, metadataJson);
  return { id: result.lastInsertRowid, agent_id: agentId, message, status: 'pending' };
}
export async function dequeueChat() {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('chat_queue').select('*').eq('status', 'pending').order('created_at', { ascending: true }).limit(1);
    if (data?.[0]) await getSupabase().from('chat_queue').update({ status: 'processing' }).eq('id', data[0].id);
    return data?.[0] || null;
  }
  const db = getSqlite();
  const row = db.prepare('SELECT * FROM chat_queue WHERE status = ? ORDER BY created_at ASC LIMIT 1').get('pending');
  if (row) db.prepare('UPDATE chat_queue SET status = ? WHERE id = ?').run('processing', (row as Record<string, unknown>).id);
  return row || null;
}
export async function completeChat(id: number | string, response: string) {
  if (USE_SUPABASE) return getSupabase().from('chat_queue').update({ status: 'done', response, processed_at: new Date().toISOString() }).eq('id', id);
  return getSqlite().prepare("UPDATE chat_queue SET status = ?, response = ?, processed_at = datetime('now') WHERE id = ?").run('done', response, id);
}
export async function getDecisions(status?: string, limit = 20) {
  const safeLimit = clampLimit(limit, 20, 200);
  if (USE_SUPABASE) {
    let q = getSupabase().from('decisions').select('*');
    if (status) q = q.eq('status', status);
    const { data } = await q.order('created_at', { ascending: false }).limit(safeLimit);
    return data || [];
  }
  const db = getSqlite();
  return status ? db.prepare('SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, safeLimit) : db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}
export async function saveDecision(decision: Record<string, unknown>) {
  // P2: raw body 전체 주입 가능 → id + DECISION_COLUMNS allowlist만 통과(임의 컬럼 차단).
  const safe = pickDecisionColumns(decision, true);
  normalizeDecisionJsonFields(safe);
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions').insert(safe).select().single(); return data;
  }
  const db = getSqlite(); const id = (safe.id as string) || crypto.randomUUID();
  db.prepare('INSERT INTO decisions (id, title, description, type, status, priority, source_agent, trigger_source, trigger_agent_id, trigger_data, progress, analysis, verification, counsel_summary, final_decision, meeting_id, delegation_level, review_notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, safe.title, safe.description || null, safe.type || 'general', safe.status || 'pending', safe.priority || 'normal', safe.source_agent || null, safe.trigger_source || null, safe.trigger_agent_id || null, safe.trigger_data || null, safe.progress || null, safe.analysis || null, safe.verification || null, safe.counsel_summary || null, safe.final_decision || null, safe.meeting_id || null, safe.delegation_level ?? 2, safe.review_notes || null);
  return { id, ...safe };
}
// #86: 종결상태(rejected/completed/completed_with_errors)가 아닐 때만 갱신(CAS) — read-then-write race 차단.
// updates의 status/progress/meeting_id 등은 호출부가 신뢰값으로만 전달(컬럼 화이트리스트는 updateDecision 별도).
// #101: 상태 전이 원자 CAS — 읽은 from과 write 시점 status가 같을 때만 갱신(read→write 사이 변경 시 패배).
// canTransition(graph) 판정을 호출부에서 한 뒤, 그 판정 근거였던 from을 CAS로 고정해 TOCTOU 제거. terminal 출발도 차단.
export async function transitionDecisionStatus(id: string, from: string, updates: Record<string, unknown>): Promise<boolean> {
  const TERMS = ['rejected', 'completed', 'completed_with_errors', 'deleted']; // #105: deleted 출발도 차단(부활 방지)
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) if (DECISION_COLUMNS.has(k)) safe[k] = v;
  const keys = Object.keys(safe);
  if (!keys.length) return false;
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions').update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', from).not('status', 'in', `(${TERMS.join(',')})`).select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const fields = keys.map((k) => `${k} = ?`).join(', ');
  const res = db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ? AND status = ? AND status NOT IN ('rejected','completed','completed_with_errors','deleted')`)
    .run(...keys.map((k) => safe[k]), id, from);
  return res.changes > 0;
}

// #106: 소프트삭제 전용 — lifecycle terminal(completed 등)에서도 deleted로 전이 허용(visibility 삭제는 별개). 이미 deleted면 no-op.
// resurrection(deleted→다른 status)은 위 CAS들이 deleted를 terminal로 막아 차단.
export async function softDeleteDecision(id: string): Promise<boolean> {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions').update({ status: 'deleted', updated_at: new Date().toISOString() })
      .eq('id', id).neq('status', 'deleted').select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const res = db.prepare("UPDATE decisions SET status = 'deleted', updated_at = datetime('now') WHERE id = ? AND status != 'deleted'").run(id);
  return res.changes > 0;
}

export async function updateDecisionUnlessTerminal(id: string, updates: Record<string, unknown>): Promise<boolean> {
  const TERMS = ['rejected', 'completed', 'completed_with_errors', 'deleted']; // #105: deleted 출발도 차단(부활 방지)
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) if (DECISION_COLUMNS.has(k)) safe[k] = v;
  const keys = Object.keys(safe);
  if (!keys.length) return false;
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions').update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', id).not('status', 'in', `(${TERMS.join(',')})`).select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const fields = keys.map((k) => `${k} = ?`).join(', ');
  const res = db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ? AND status NOT IN ('rejected','completed','completed_with_errors','deleted')`)
    .run(...keys.map((k) => safe[k]), id);
  return res.changes > 0;
}

// #72: UPDATE 절 컬럼명이 raw 보간되므로 허용 컬럼만 통과(임의 key로 SQL 주입·status 가드 우회 차단).
const DECISION_COLUMNS = new Set(['title', 'description', 'type', 'status', 'priority', 'source_agent', 'trigger_source', 'trigger_agent_id', 'trigger_data', 'progress', 'analysis', 'verification', 'counsel_summary', 'final_decision', 'meeting_id', 'delegation_level', 'review_notes']);
function pickDecisionColumns(input: Record<string, unknown>, includeId = false): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if ((includeId && k === 'id') || DECISION_COLUMNS.has(k)) safe[k] = v;
  return safe;
}
function normalizeDecisionJsonFields(row: Record<string, unknown>) {
  for (const key of ['trigger_data', 'progress']) {
    const value = row[key];
    if (value && typeof value === 'object') row[key] = JSON.stringify(value);
  }
}
export async function updateDecision(id: string, updates: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) if (DECISION_COLUMNS.has(k)) safe[k] = v; // 화이트리스트 외 key 폐기
  if (USE_SUPABASE) { const { data } = await getSupabase().from('decisions').update({ ...safe, updated_at: new Date().toISOString() }).eq('id', id).select().single(); return data; }
  const db = getSqlite();
  const keys = Object.keys(safe);
  if (!keys.length) return { id }; // 변경할 허용 컬럼 없음
  const fields = keys.map((k) => `${k} = ?`).join(', ');  // k는 화이트리스트 집합 → 안전
  db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => safe[k]), id);
  return { id, ...safe };
}
// 동시 execute 방지용 원자적 claim: 실행 가능한 상태일 때만 in_progress로 전이.
// true면 이 호출이 선점한 것, false면 이미 진행/완료/확정됨. (동시 2회 호출 시 하나만 true)
const NOT_RESTARTABLE = ['in_progress', 'executing', 'completed', 'completed_with_errors', 'rejected', 'deleted']; // #105: deleted는 실행 재개 금지
export async function tryStartDirective(id: string): Promise<boolean> {
  if (USE_SUPABASE) {
    const { data } = await getSupabase()
      .from('decisions')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', id)
      .not('status', 'in', `(${NOT_RESTARTABLE.join(',')})`)
      .select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const ph = NOT_RESTARTABLE.map(() => '?').join(',');
  const res = db.prepare(
    `UPDATE decisions SET status = 'in_progress', updated_at = datetime('now') WHERE id = ? AND (status IS NULL OR status NOT IN (${ph}))`
  ).run(id, ...NOT_RESTARTABLE);
  return res.changes > 0;
}
// in_progress 상태에서만 전이(progress/status 갱신). 실행 중 결재(reject/approve)가 끼면 false 반환하고 덮지 않음.
export async function transitionFromInProgress(id: string, updates: Record<string, unknown>): Promise<boolean> {
  // #72 대칭: decisions UPDATE 절 컬럼명 raw 보간 → DECISION_COLUMNS allowlist만 통과(임의 key 주입 차단).
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) if (DECISION_COLUMNS.has(k)) safe[k] = v;
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions')
      .update({ ...safe, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'in_progress').select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const keys = Object.keys(safe);
  if (!keys.length) return false;
  const fields = keys.map(k => `${k} = ?`).join(', ');
  const res = db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'`)
    .run(...keys.map(k => safe[k]), id);
  return res.changes > 0;
}
export function getBackendType(): 'sqlite' | 'supabase' {
  return getDbProvider();
}

// Directives
export async function getDirectives(limit = 20) {
  const safeLimit = clampLimit(limit, 20, 200);
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('directives').select('*').order('created_at', { ascending: false }).limit(safeLimit);
    return (data || []).map((r: Record<string, unknown>) => ({ ...r, assignees: safeJsonParse(r.assignees, []) }));
  }
  return (getSqlite().prepare('SELECT * FROM directives ORDER BY created_at DESC LIMIT ?').all(safeLimit) as Record<string, unknown>[]).map((r) => ({ ...r, assignees: safeJsonParse(r.assignees, []) }));
}
export async function saveDirective(title: string, description: string, assignees: unknown[], priority = 'normal') {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('directives').insert({ title, content: description, assignees, priority }).select().single();
    return data;
  }
  const db = getSqlite(); const id = crypto.randomUUID();
  db.prepare('INSERT INTO directives (id, title, content, assignees, priority) VALUES (?, ?, ?, ?, ?)').run(id, title, description, JSON.stringify(assignees), priority);
  return { id, title, content: description, assignees, priority, status: 'pending' };
}
// #72 대칭: directives UPDATE 절 컬럼명 raw 보간 → 허용 컬럼만 통과(임의 key로 SQL 주입 차단).
const DIRECTIVE_COLUMNS = new Set(['title', 'content', 'status', 'priority', 'assignees', 'reviewed_at']);
export async function updateDirective(id: string, updates: Record<string, unknown>) {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) if (DIRECTIVE_COLUMNS.has(k)) safe[k] = v;
  if (USE_SUPABASE) { return getSupabase().from('directives').update(safe).eq('id', id); }
  const db = getSqlite(); const keys = Object.keys(safe);
  if (keys.length) db.prepare(`UPDATE directives SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => safe[k]), id);
  return { id, ...safe };
}

// Reports (additional)
export async function getReports(limit = 20) {
  const safeLimit = clampLimit(limit, 20, 300);
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('reports').select('*').order('created_at', { ascending: false }).limit(safeLimit);
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}
