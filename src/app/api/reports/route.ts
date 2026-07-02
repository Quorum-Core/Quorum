import { isDemoMode, DEMO_REPORTS } from '../../../lib/demo-data';
import { NextRequest, NextResponse } from 'next/server';
import { authorizedBrowser, authorized } from '@/lib/api-guard';
import { dbDelete, getReports, saveReport, updateReportStatus } from '@/lib/db';

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #107: 민감 read 가드
  if (isDemoMode()) return Response.json(DEMO_REPORTS);
  try {
    const url = new URL(req.url);
    const agentParam = url.searchParams.get('agent_id');
    const typeParams = url.searchParams.getAll('report_type');
    const limit = parseLimit(url.searchParams.get('limit'), 50, 100);
    const agentCond = agentParam ? parseReportFilter(agentParam) : null;
    if (agentCond && 'error' in agentCond) return NextResponse.json({ error: 'agent_id invalid' }, { status: 400 });
    if (typeParams.length > 20) return NextResponse.json({ error: 'report_type invalid' }, { status: 400 });
    const typeConds = typeParams.map(parseReportFilter);
    if (typeConds.some((c) => 'error' in c)) return NextResponse.json({ error: 'report_type invalid' }, { status: 400 });

    // 필터 후 limit이 모자라지 않도록 넉넉히 가져와 거른 뒤 slice
    const pool = await getReports(Math.max(limit, 50) * 3) as Array<Record<string, unknown>>;
    let filtered = pool;
    if (agentCond) {
      filtered = filtered.filter((r) => agentCond.op === 'neq' ? r.agent_id !== agentCond.val : r.agent_id === agentCond.val);
    }
    for (const c of typeConds.filter(isParsedReportFilter)) {
      filtered = filtered.filter((r) => c.op === 'neq' ? r.report_type !== c.val : r.report_type === c.val);
    }
    // 명시적 필터가 없을 때만 기본 제외(health_check/directive_report/chairman)
    if (!agentParam && typeParams.length === 0) {
      filtered = filtered.filter((r) => r.report_type !== 'health_check' && r.report_type !== 'directive' && r.report_type !== 'directive_report' && r.agent_id !== 'chairman');
    }
    return NextResponse.json(filtered.slice(0, limit));
  } catch (error) {
    console.error('Reports API error:', error);
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 });
  }
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

type ParsedReportFilter = { op: 'eq' | 'neq'; val: string };

function parseReportFilter(raw: string): ParsedReportFilter | { error: string } {
  const op = raw.startsWith('neq.') ? 'neq' : 'eq';
  const val = raw.startsWith('neq.') ? raw.slice(4) : raw.startsWith('eq.') ? raw.slice(3) : raw;
  return /^[A-Za-z0-9_-]{1,100}$/.test(val) ? { op, val } : { error: 'invalid' };
}

function isParsedReportFilter(value: ParsedReportFilter | { error: string }): value is ParsedReportFilter {
  return !('error' in value);
}

export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    const input = sanitizeReportCreate(body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const { agent_id, title, content, report_type, meeting_id } = input.value;
    await saveReport(agent_id, title, content, report_type, meeting_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Reports POST error:', error);
    return NextResponse.json({ error: 'Failed to save report' }, { status: 500 });
  }
}

function sanitizeReportCreate(body: unknown): {
  value: { agent_id: string; title: string; content: string; report_type: string; meeting_id?: string };
} | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid body' };
  const row = body as Record<string, unknown>;
  const agentId = typeof row.agent_id === 'string' ? row.agent_id.trim() : '';
  if (!isSafeReportId(agentId)) return { error: 'agent_id invalid' };
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) return { error: 'title invalid' };
  if (row.content != null && (typeof row.content !== 'string' || row.content.length > 50_000)) return { error: 'content invalid' };
  if (row.report_type != null && (typeof row.report_type !== 'string' || row.report_type.length > 100 || !/^[\w-]+$/.test(row.report_type))) return { error: 'report_type invalid' };
  let meetingId: string | undefined;
  if (row.meeting_id != null) {
    if (typeof row.meeting_id !== 'string') return { error: 'meeting_id invalid' };
    const trimmed = row.meeting_id.trim();
    if (trimmed && !isSafeReportId(trimmed)) return { error: 'meeting_id invalid' };
    meetingId = trimmed || undefined;
  }
  return {
    value: {
      agent_id: agentId,
      title: row.title.trim(),
      content: typeof row.content === 'string' ? row.content : '',
      report_type: typeof row.report_type === 'string' ? row.report_type : 'general',
      ...(meetingId ? { meeting_id: meetingId } : {}),
    },
  };
}

function isSafeReportId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

export async function PATCH(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    const { id, status } = body as Record<string, unknown>;
    const safeId = typeof id === 'string' ? id.trim() : '';
    if (!isSafeReportId(safeId)) return NextResponse.json({ error: 'id invalid' }, { status: 400 });
    if (typeof status !== 'string') return NextResponse.json({ error: 'status invalid' }, { status: 400 });
    if (status !== 'approved' && status !== 'rejected') {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    await updateReportStatus(safeId, status);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    let id = req.nextUrl.searchParams.get('id') || undefined;
    if (!id) {
      try {
        const body = await req.json();
        id = body && typeof body === 'object' && !Array.isArray(body) && typeof body.id === 'string' ? body.id : undefined;
      } catch {}
    }
    const safeId = typeof id === 'string' ? id.trim() : '';
    if (!isSafeReportId(safeId)) return NextResponse.json({ error: 'id invalid' }, { status: 400 });
    await dbDelete('reports', safeId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
