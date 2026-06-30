/**
 * Quorum Database Abstraction Layer
 * Supports: SQLite (default) | PostgreSQL | Supabase
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
    return process.env.DB_PROVIDER as DbProvider;
  }
  // Legacy detection: if Supabase env vars are set, use supabase
  const hasSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const hasSupabaseKey =
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

// ─── Unified DB Functions (new interface for gradual migration) ───

export async function dbQuery(
  table: string,
  options?: DbQueryOptions
): Promise<unknown[]> {
  // orderBy는 raw SQL에 보간되므로 컬럼명 화이트리스트로 SQL injection 차단(sqlite)
  if (options?.orderBy && !/^[A-Za-z0-9_]+$/.test(options.orderBy)) {
    options = { ...options, orderBy: undefined };
  }
  if (USE_SUPABASE) {
    return supaDb.query(table, options || {});
  }
  // SQLite
  const db = getSqlite();
  let sql = `SELECT * FROM ${table}`;
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
  if (options?.limit) {
    sql += ` LIMIT ${options.limit}`;
  }
  return db.prepare(sql).all(...params);
}

export async function dbInsert(table: string, data: Record<string, unknown>): Promise<unknown> {
  if (USE_SUPABASE) {
    return supaDb.insert(table, data);
  }
  const db = getSqlite();
  const cols = Object.keys(data);
  const vals = Object.values(data).map(sqliteValue);
  const placeholders = cols.map(() => '?');
  const result = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`).run(...vals);
  return { id: result.lastInsertRowid, ...data };
}

export async function dbInsertIdempotent(table: string, data: Record<string, unknown>): Promise<unknown | null> {
  if (USE_SUPABASE) {
    return supaDb.insertIdempotent(table, data);
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
  if (USE_SUPABASE) {
    return supaDb.update(table, id, data);
  }
  const db = getSqlite();
  const entries = Object.entries(data);
  const setClauses = entries.map(([col]) => `${col} = ?`);
  const vals = [...entries.map(([, v]) => sqliteValue(v)), id];
  db.prepare(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = ?`).run(...vals);
  return { id, ...data };
}

export async function dbUpdateWhere(
  table: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<unknown[]> {
  if (USE_SUPABASE) {
    return supaDb.updateWhere(table, where, data);
  }
  const db = getSqlite();
  const updates = Object.entries(data);
  const filters = Object.entries(where);
  const setClauses = updates.map(([col]) => `${col} = ?`);
  const whereClauses = filters.map(([col]) => `${col} = ?`);
  const vals = [...updates.map(([, v]) => sqliteValue(v)), ...filters.map(([, v]) => sqliteValue(v))];
  const res = db.prepare(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')}`).run(...vals);
  return res.changes > 0 ? [{ ...where, ...data }] : [];
}

export async function dbDelete(table: string, id: string): Promise<void> {
  if (USE_SUPABASE) {
    return supaDb.remove(table, id);
  }
  getSqlite().prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
}

export async function dbDeleteWhere(table: string, where: Record<string, unknown>): Promise<void> {
  if (USE_SUPABASE) {
    return supaDb.removeWhere(table, where);
  }
  const db = getSqlite();
  const filters = Object.entries(where);
  const clauses = filters.map(([col]) => `${col} = ?`);
  db.prepare(`DELETE FROM ${table} WHERE ${clauses.join(' AND ')}`).run(...filters.map(([, v]) => v));
}

export async function dbGet(table: string, id: string): Promise<unknown> {
  if (USE_SUPABASE) {
    const client = getSupabase();
    const { data } = await client.from(table).select('*').eq('id', id).single();
    return data;
  }
  return getSqlite().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
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
export async function followupTransition(
  meetingId: string, agents: string[], userMsg: string, finalizeSlots: number[],
  chairman: { agent_name: string; number: string; role: string },
): Promise<void> {
  if (USE_SUPABASE) {
    return supaDb.followupTransition(meetingId, agents, userMsg, finalizeSlots, chairman);
  }
  const db = getSqlite();
  db.transaction(() => {
    db.prepare("DELETE FROM meeting_messages WHERE meeting_id = ? AND type = 'meeting_end'").run(meetingId);
    for (const slot of finalizeSlots) db.prepare('DELETE FROM meeting_messages WHERE meeting_id = ? AND slot = ?').run(meetingId, slot);
    const row = db.prepare('SELECT next_seq, agent_order, version FROM meetings WHERE id = ?').get(meetingId) as { next_seq?: number; agent_order?: string; version?: number } | undefined;
    if (!row) throw new Error(`Meeting not found: ${meetingId}`);
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
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('conversations').select('*').eq('agent_id', agentId).order('created_at', { ascending: false }).limit(limit);
    return (data || []).reverse();
  }
  return getSqlite().prepare('SELECT * FROM conversations WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit).reverse();
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
export async function getPendingReports() {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('reports').select('*').eq('status', 'pending').order('created_at', { ascending: false });
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM reports WHERE status = ? ORDER BY created_at DESC').all('pending');
}
export async function updateReportStatus(reportId: string, status: 'approved' | 'rejected') {
  if (USE_SUPABASE) return getSupabase().from('reports').update({ status, reviewed_at: new Date().toISOString() }).eq('id', reportId);
  return getSqlite().prepare('UPDATE reports SET status = ?, reviewed_at = datetime("now") WHERE id = ?').run(status, reportId);
}
export async function addMemory(agentId: string, memoryType: string, content: string, importance = 5, sourceId?: string) {
  if (USE_SUPABASE) return getSupabase().from('agent_memory').insert({ agent_id: agentId, memory_type: memoryType, content, importance, source_id: sourceId });
  return getSqlite().prepare('INSERT INTO agent_memory (agent_id, memory_type, content, importance, source_id) VALUES (?, ?, ?, ?, ?)').run(agentId, memoryType, content, importance, sourceId || null);
}
export async function getAgentMemories(agentId: string, limit = 10) {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('agent_memory').select('*').eq('agent_id', agentId).order('importance', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM agent_memory WHERE agent_id = ? ORDER BY importance DESC, created_at DESC LIMIT ?').all(agentId, limit);
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
  return getSqlite().prepare('UPDATE chat_queue SET status = ?, response = ?, processed_at = datetime("now") WHERE id = ?').run('done', response, id);
}
export async function getDecisions(status?: string, limit = 20) {
  if (USE_SUPABASE) {
    let q = getSupabase().from('decisions').select('*');
    if (status) q = q.eq('status', status);
    const { data } = await q.order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }
  const db = getSqlite();
  return status ? db.prepare('SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) : db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(limit);
}
export async function saveDecision(decision: Record<string, unknown>) {
  if (USE_SUPABASE) { const { data } = await getSupabase().from('decisions').insert(decision).select().single(); return data; }
  const db = getSqlite(); const id = (decision.id as string) || crypto.randomUUID();
  db.prepare('INSERT INTO decisions (id, title, description, type, status, priority, source_agent, trigger_source, trigger_agent_id, trigger_data, progress, analysis, verification, counsel_summary, final_decision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, decision.title, decision.description || null, decision.type || 'general', decision.status || 'pending', decision.priority || 'normal', decision.source_agent || null, decision.trigger_source || null, decision.trigger_agent_id || null, decision.trigger_data ? JSON.stringify(decision.trigger_data) : null, decision.progress ? JSON.stringify(decision.progress) : null, decision.analysis || null, decision.verification || null, decision.counsel_summary || null, decision.final_decision || null);
  return { id, ...decision };
}
export async function updateDecision(id: string, updates: Record<string, unknown>) {
  if (USE_SUPABASE) { const { data } = await getSupabase().from('decisions').update({ ...updates, updated_at: new Date().toISOString() }).eq('id', id).select().single(); return data; }
  const db = getSqlite(); const fields = Object.keys(updates).map(k => `${k} = ?`).join(', '); const values = Object.values(updates);
  db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
  return { id, ...updates };
}
// 동시 execute 방지용 원자적 claim: 실행 가능한 상태일 때만 in_progress로 전이.
// true면 이 호출이 선점한 것, false면 이미 진행/완료/확정됨. (동시 2회 호출 시 하나만 true)
const NOT_RESTARTABLE = ['in_progress', 'executing', 'completed', 'completed_with_errors', 'rejected'];
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
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('decisions')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id).eq('status', 'in_progress').select('id');
    return !!(data && data.length);
  }
  const db = getSqlite();
  const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const res = db.prepare(`UPDATE decisions SET ${fields}, updated_at = datetime('now') WHERE id = ? AND status = 'in_progress'`)
    .run(...Object.values(updates), id);
  return res.changes > 0;
}
export function getBackendType(): 'sqlite' | 'supabase' {
  return getDbProvider();
}

// Directives
export async function getDirectives(limit = 20) {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('directives').select('*').order('created_at', { ascending: false }).limit(limit);
    return (data || []).map((r: Record<string, unknown>) => ({ ...r, assignees: safeJsonParse(r.assignees, []) }));
  }
  return (getSqlite().prepare('SELECT * FROM directives ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({ ...r, assignees: safeJsonParse(r.assignees, []) }));
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
export async function updateDirective(id: string, updates: Record<string, unknown>) {
  if (USE_SUPABASE) { return getSupabase().from('directives').update(updates).eq('id', id); }
  const db = getSqlite(); const fields = Object.keys(updates).map(k => `${k} = ?`).join(', '); const values = Object.values(updates);
  db.prepare(`UPDATE directives SET ${fields} WHERE id = ?`).run(...values, id);
  return { id, ...updates };
}

// Reports (additional)
export async function getReports(limit = 20) {
  if (USE_SUPABASE) {
    const { data } = await getSupabase().from('reports').select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }
  return getSqlite().prepare('SELECT * FROM reports ORDER BY created_at DESC LIMIT ?').all(limit);
}
