import { isDemoMode, DEMO_DECISIONS } from '../../../lib/demo-data';
import { NextRequest, NextResponse } from 'next/server';
import { authorizedBrowser, authorized } from '@/lib/api-guard';
import { dbDelete, dbGet, dbQuery, getDecisions, saveDecision, updateDecision, transitionDecisionStatus, softDeleteDecision } from '@/lib/db';
import { canTransition } from '@/lib/decision-status';

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #107: 민감 read 가드(same-origin/token)
  if (isDemoMode()) return Response.json(DEMO_DECISIONS);
  const status = stripEq(req.nextUrl.searchParams.get('status'));
  const triggerSource = stripEq(req.nextUrl.searchParams.get('trigger_source'));
  const agentId = stripEq(req.nextUrl.searchParams.get('agent_id'));
  const limit = parseLimit(req.nextUrl.searchParams.get('limit'), 20, 100);
  const order = req.nextUrl.searchParams.get('order');
  if (status && !DECISION_GET_STATUSES.has(status)) return NextResponse.json({ error: 'status invalid' }, { status: 400 });
  if (triggerSource && !isSafeFilterValue(triggerSource)) return NextResponse.json({ error: 'trigger_source invalid' }, { status: 400 });
  if (agentId && !isSafeFilterValue(agentId)) return NextResponse.json({ error: 'agent_id invalid' }, { status: 400 });
  const fetchLimit = agentId ? Math.min(Math.max(limit * 5, 50), 500) : limit;

  const useDbQuery = triggerSource || parseOrderColumn(order);
  const decisions = useDbQuery
    ? await dbQuery('decisions', {
        where: { ...(triggerSource ? { trigger_source: triggerSource } : {}), ...(status ? { status } : {}) },
        orderBy: parseOrderColumn(order) || 'created_at',
        ascending: parseOrderAscending(order) ?? false,
        limit: fetchLimit,
      })
    : await getDecisions(status, fetchLimit);

  const normalized = decisions.map(normalizeDecision);
  const filtered = agentId
    ? normalized.filter((decision) => matchesAgent(decision, agentId))
    : normalized;
  return NextResponse.json({ decisions: filtered.slice(0, limit) });
}

export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    const input = sanitizeDecisionCreate(body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const decision = await saveDecision(input.value);
    if (!decision) {
      return NextResponse.json({ error: 'DB insert returned no row (check table columns/RLS)' }, { status: 500 });
    }
    return NextResponse.json(decision, { status: 201 });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    const row = body as Record<string, unknown>;
    const queryId = stripEq(req.nextUrl.searchParams.get('id'));
    const bodyId = typeof row.id === 'string' ? stripEq(row.id) : undefined;
    const id = normalizeDecisionId(bodyId || queryId);
    if (!id) return NextResponse.json({ error: 'id invalid' }, { status: 400 });
    const input = sanitizeDecisionUpdate(row);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const updates = input.value;
    // #95: status PATCH는 CAS(terminal이면 거부) + allowlist. read-then-write race로 종결상태 덮어쓰기 차단.
    if (updates.status !== undefined) {
      // #100: 실제 사용 status 전부 — approval_requested(결재요청)·deleted(소프트딜리트) 누락 회귀 복구.
      if (typeof updates.status !== 'string' || !DECISION_PATCH_STATUSES.has(updates.status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 });
      // #106: 소프트삭제는 terminal(완료/거절) 출발도 허용해야 함(숨김). 전용 경로로 — transition CAS는 terminal 출발을 막으므로.
      if (updates.status === 'deleted') {
        const ok = await softDeleteDecision(id);
        if (!ok) return NextResponse.json({ error: 'already deleted or not found' }, { status: 409 });
        return NextResponse.json(await dbGet('decisions', id));
      }
      // #102: 비정상 전이 차단(pending→completed 점프·approved→pending 역행 등).
      const curD = await dbGet('decisions', id) as { status?: string } | undefined;
      if (curD && !canTransition(curD.status, updates.status)) {
        return NextResponse.json({ error: 'invalid transition', from: curD.status, to: updates.status }, { status: 409 });
      }
      // #101: from을 CAS로 고정 — read→write 사이 status가 바뀌면 패배(stale 전이 차단). terminal 출발도 차단.
      const ok = await transitionDecisionStatus(id, String(curD?.status ?? ''), serializeJsonFields(updates));
      if (!ok) {
        const f = await dbGet('decisions', id) as { status?: string } | undefined;
        return NextResponse.json({ error: 'status changed or finalized', status: f?.status }, { status: 409 });
      }
      return NextResponse.json(await dbGet('decisions', id));
    }
    const result = await updateDecision(id, serializeJsonFields(updates));
    return NextResponse.json(result);
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    let id = stripEq(req.nextUrl.searchParams.get('id'));
    if (!id) {
      try {
        const body = await req.json();
        id = body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' ? stripEq(body.id) : undefined;
      } catch {}
    }
    const safeId = normalizeDecisionId(id);
    if (!safeId) return NextResponse.json({ error: 'id invalid' }, { status: 400 });
    await dbDelete('decisions', safeId);
    await dbDelete('directives', safeId);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function stripEq(value: string | null): string | undefined {
  if (!value) return undefined;
  return value.startsWith('eq.') ? value.slice(3) : value;
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeDecisionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9-]{1,100}$/.test(trimmed) ? trimmed : null;
}

function isSafeFilterValue(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function parseOrderColumn(order: string | null): string | undefined {
  const col = order?.split('.')[0];
  return col && DECISION_ORDER_COLUMNS.has(col) ? col : undefined;
}

function parseOrderAscending(order: string | null): boolean | undefined {
  if (!order) return undefined;
  if (order.endsWith('.asc')) return true;
  if (order.endsWith('.desc')) return false;
  return undefined;
}

function normalizeDecision(decision: unknown): unknown {
  if (!decision || typeof decision !== 'object') return decision;
  const row = decision as Record<string, unknown>;
  return {
    ...row,
    trigger_data: parseJson(row.trigger_data, row.trigger_data),
    progress: parseJson(row.progress, row.progress),
  };
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serializeJsonFields(updates: Record<string, unknown>): Record<string, unknown> {
  const next = { ...updates };
  for (const key of ['trigger_data', 'progress']) {
    if (next[key] && typeof next[key] === 'object') {
      next[key] = JSON.stringify(next[key]);
    }
  }
  return next;
}

const DECISION_CREATE_STATUSES = new Set(['pending', 'approved', 'rejected', 'completed', 'completed_with_errors']);
const DECISION_PATCH_STATUSES = new Set(['pending', 'approval_requested', 'approved', 'rejected', 'in_progress', 'executing', 'completed', 'completed_with_errors', 'deleted']);
const DECISION_CREATE_PRIORITIES = new Set(['low', 'medium', 'normal', 'high', 'urgent']);
const DECISION_GET_STATUSES = new Set(['pending', 'approval_requested', 'approved', 'rejected', 'in_progress', 'executing', 'completed', 'completed_with_errors', 'deleted']);
const DECISION_TEXT_LIMITS: Record<string, number> = {
  title: 200,
  description: 5000,
  source_agent: 100,
  trigger_source: 100,
  trigger_agent_id: 100,
  analysis: 10000,
  verification: 10000,
  counsel_summary: 10000,
  final_decision: 20000,
  meeting_id: 100,
  review_notes: 5000,
};
const DECISION_SAFE_ID_FIELDS = new Set(['source_agent', 'trigger_source', 'trigger_agent_id', 'meeting_id']);
const DECISION_ORDER_COLUMNS = new Set([
  'id',
  'title',
  'type',
  'status',
  'priority',
  'source_agent',
  'trigger_source',
  'trigger_agent_id',
  'created_at',
  'updated_at',
]);

function sanitizeDecisionCreate(body: unknown): { value: Record<string, unknown> } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid body' };
  const row = body as Record<string, unknown>;
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) return { error: 'title invalid' };

  const out: Record<string, unknown> = { title: row.title.trim() };
  const copyText = (key: string, limit: number): string | undefined => {
    const value = row[key];
    if (value == null) return undefined;
    if (typeof value !== 'string' || value.length > limit) return `${key} invalid`;
    const normalized = DECISION_SAFE_ID_FIELDS.has(key) ? normalizeLookupId(value) : value;
    if (normalized == null) return `${key} invalid`;
    out[key] = normalized;
    return undefined;
  };

  for (const [key, limit] of Object.entries(DECISION_TEXT_LIMITS)) {
    if (key === 'title') continue;
    const error = copyText(key, limit);
    if (error) return { error };
  }

  if (row.type != null) {
    if (typeof row.type !== 'string' || row.type.length > 50 || !/^[\w-]+$/.test(row.type)) return { error: 'type invalid' };
    out.type = row.type;
  }
  if (row.status != null) {
    if (typeof row.status !== 'string' || !DECISION_CREATE_STATUSES.has(row.status)) return { error: 'invalid status' };
    out.status = row.status;
  }
  if (row.priority != null) {
    if (typeof row.priority !== 'string' || !DECISION_CREATE_PRIORITIES.has(row.priority)) return { error: 'priority invalid' };
    out.priority = row.priority;
  }
  if (row.delegation_level != null) {
    if (typeof row.delegation_level !== 'number' || !Number.isInteger(row.delegation_level) || row.delegation_level < 1 || row.delegation_level > 5) return { error: 'delegation_level invalid' };
    out.delegation_level = row.delegation_level;
  }

  for (const key of ['trigger_data', 'progress']) {
    const value = row[key];
    if (value == null) continue;
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (encoded.length > 20000) return { error: `${key} too long` };
    out[key] = encoded;
  }

  return { value: out };
}

function sanitizeDecisionUpdate(row: Record<string, unknown>): { value: Record<string, unknown> } | { error: string } {
  const out: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(DECISION_TEXT_LIMITS)) {
    if (!(key in row)) continue;
    const value = row[key];
    if (typeof value !== 'string' || value.length > limit) return { error: key === 'title' ? 'title invalid' : `${key} invalid` };
    const trimmed = key === 'title' ? value.trim() : value;
    if (key === 'title' && !trimmed) return { error: 'title invalid' };
    const normalized = DECISION_SAFE_ID_FIELDS.has(key) ? normalizeLookupId(trimmed) : trimmed;
    if (normalized == null) return { error: `${key} invalid` };
    out[key] = normalized;
  }
  if ('type' in row) {
    if (typeof row.type !== 'string' || row.type.length > 50 || !/^[\w-]+$/.test(row.type)) return { error: 'type invalid' };
    out.type = row.type;
  }
  if ('status' in row) {
    if (typeof row.status !== 'string' || !DECISION_PATCH_STATUSES.has(row.status)) return { error: 'invalid status' };
    out.status = row.status;
  }
  if ('priority' in row) {
    if (typeof row.priority !== 'string' || !DECISION_CREATE_PRIORITIES.has(row.priority)) return { error: 'priority invalid' };
    out.priority = row.priority;
  }
  if ('delegation_level' in row) {
    if (typeof row.delegation_level !== 'number' || !Number.isInteger(row.delegation_level) || row.delegation_level < 1 || row.delegation_level > 5) return { error: 'delegation_level invalid' };
    out.delegation_level = row.delegation_level;
  }
  for (const key of ['trigger_data', 'progress']) {
    if (!(key in row)) continue;
    const value = row[key];
    if (value == null) continue;
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (encoded.length > 20000) return { error: `${key} too long` };
    out[key] = encoded;
  }
  return { value: out };
}

function normalizeLookupId(value: string): string | null {
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(trimmed) ? trimmed : null;
}

function matchesAgent(decision: unknown, agentId: string): boolean {
  if (!decision || typeof decision !== 'object') return false;
  const row = decision as Record<string, unknown>;
  if (
    row.source_agent === agentId ||
    row.trigger_agent_id === agentId ||
    row.current_assignee === agentId ||
    row.proposed_by === agentId
  ) {
    return true;
  }
  const triggerData = parseJson(row.trigger_data, {}) as Record<string, unknown>;
  const assignees = triggerData.assignees;
  if (!Array.isArray(assignees)) return false;
  return assignees.some((assignee) => {
    if (assignee === agentId) return true;
    if (!assignee || typeof assignee !== 'object') return false;
    const item = assignee as Record<string, unknown>;
    return item.id === agentId || item.agent_id === agentId;
  });
}
