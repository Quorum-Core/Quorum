/**
 * Supabase database adapter for Quorum Company
 * Uses @supabase/supabase-js (already installed)
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    // 서버 어댑터는 service_role 전용 — anon fallback 금지(RLS로 agent_configs 등 차단돼 빈 결과로 조용히 깨짐).
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY (service_role) required — anon key는 서버에서 사용 불가');
    }
    _client = createClient(url, key);
  }
  return _client;
}

export async function query(
  table: string,
  options: { where?: Record<string, unknown>; like?: Record<string, string>; orderBy?: string; ascending?: boolean; limit?: number } = {}
): Promise<unknown[]> {
  const client = getSupabaseClient();
  let q = client.from(table).select('*');
  if (options.where) {
    for (const [col, val] of Object.entries(options.where)) {
      q = q.eq(col, val);
    }
  }
  if (options.like) {
    for (const [col, val] of Object.entries(options.like)) {
      q = q.like(col, val);
    }
  }
  if (options.orderBy) {
    q = q.order(options.orderBy, { ascending: options.ascending ?? false });
  }
  if (options.limit) {
    q = q.limit(options.limit);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function insert(table: string, data: Record<string, unknown>): Promise<unknown> {
  const client = getSupabaseClient();
  const { data: result, error } = await client.from(table).insert(data).select().single();
  if (error) throw error;
  return result;
}

export async function insertIdempotent(table: string, data: Record<string, unknown>): Promise<unknown | null> {
  const client = getSupabaseClient();
  const { data: result, error } = await client.from(table).insert(data).select().maybeSingle();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return result;
}

export async function update(table: string, id: string, data: Record<string, unknown>): Promise<unknown> {
  const client = getSupabaseClient();
  const { data: result, error } = await client.from(table).update(data).eq('id', id).select().single();
  if (error) throw error;
  return result;
}

export async function updateWhere(
  table: string,
  where: Record<string, unknown>,
  data: Record<string, unknown>
): Promise<unknown[]> {
  const client = getSupabaseClient();
  let q = client.from(table).update(data);
  for (const [col, val] of Object.entries(where)) {
    q = q.eq(col, val);
  }
  const { data: result, error } = await q.select();
  if (error) throw error;
  return result || [];
}

export async function remove(table: string, id: string): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.from(table).delete().eq('id', id);
  if (error) throw error;
}

export async function removeWhere(table: string, where: Record<string, unknown>): Promise<void> {
  const client = getSupabaseClient();
  let q = client.from(table).delete();
  for (const [col, val] of Object.entries(where)) {
    q = q.eq(col, val);
  }
  const { error } = await q;
  if (error) throw error;
}

export async function allocateMeetingSeq(meetingId: string): Promise<number> {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('allocate_meeting_seq', { p_meeting_id: meetingId });
  if (error) throw error;
  return Number(data);
}

// followup 에이전트 추가 원자화(agent_order||추가 + version++ + status='running'). 새 version 반환.
export async function appendMeetingAgents(meetingId: string, agents: string[]): Promise<number> {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc('append_meeting_agents', { p_id: meetingId, p_agents: agents });
  if (error) throw error;
  return Number(data);
}

// #61: followup 전환 원자화 RPC(삭제+chairman insert+append+version++ 단일 트랜잭션).
export async function followupTransition(
  meetingId: string, agents: string[], userMsg: string, finalizeSlots: number[],
  chairman: { agent_name: string; number: string; role: string },
): Promise<void> {
  const client = getSupabaseClient();
  const { error } = await client.rpc('followup_transition', {
    p_id: meetingId, p_agents: agents, p_msg: userMsg, p_slots: finalizeSlots,
    p_name: chairman.agent_name, p_number: chairman.number, p_role: chairman.role,
  });
  if (error) throw error;
}
