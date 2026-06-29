import { isDemoMode, DEMO_DECISIONS } from '../../../lib/demo-data';
import { NextRequest, NextResponse } from 'next/server';
import { dbDelete, dbGet, dbQuery, getDecisions, saveDecision, updateDecision } from '@/lib/db';
import { isTerminal } from '@/lib/decision-status';

export async function GET(req: NextRequest) {
  if (isDemoMode()) return Response.json(DEMO_DECISIONS);
  const status = stripEq(req.nextUrl.searchParams.get('status'));
  const triggerSource = stripEq(req.nextUrl.searchParams.get('trigger_source'));
  const agentId = stripEq(req.nextUrl.searchParams.get('agent_id'));
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '20');
  const order = req.nextUrl.searchParams.get('order');
  const fetchLimit = agentId ? Math.max(limit * 5, 50) : limit;

  const decisions = triggerSource
    ? await dbQuery('decisions', {
        where: { trigger_source: triggerSource, ...(status ? { status } : {}) },
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
  try {
    const body = await req.json();
    const decision = await saveDecision(body);
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
  const body = await req.json();
  const rawId = body.id || req.nextUrl.searchParams.get('id');
  const id = typeof rawId === 'string' ? stripEq(rawId) : rawId;
  const updates = { ...body };
  delete updates.id;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  // 확정된 의사결정의 status를 raw PATCH로 되돌리지 못하게 차단(status 외 필드 갱신은 허용)
  if (updates.status !== undefined) {
    const cur = await dbGet('decisions', id) as { status?: string } | undefined;
    if (cur && isTerminal(cur.status)) {
      return NextResponse.json({ error: 'Decision already finalized', status: cur.status }, { status: 409 });
    }
  }
  const result = await updateDecision(id, serializeJsonFields(updates));
  return NextResponse.json(result);
}

export async function DELETE(req: NextRequest) {
  try {
    let id = stripEq(req.nextUrl.searchParams.get('id'));
    if (!id) {
      try {
        const body = await req.json();
        id = typeof body.id === 'string' ? stripEq(body.id) : body.id;
      } catch {}
    }
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await dbDelete('decisions', id);
    await dbDelete('directives', id);
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

function parseOrderColumn(order: string | null): string | undefined {
  return order?.split('.')[0] || undefined;
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
