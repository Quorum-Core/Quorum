import { isDemoMode, DEMO_REPORTS } from '../../../lib/demo-data';
import { NextRequest, NextResponse } from 'next/server';
import { dbDelete, getReports, saveReport, updateReportStatus } from '@/lib/db';

export async function GET(req: NextRequest) {
  if (isDemoMode()) return Response.json(DEMO_REPORTS);
  try {
    const url = new URL(req.url);
    const agentParam = url.searchParams.get('agent_id');
    const typeParams = url.searchParams.getAll('report_type');
    const limit = parseInt(url.searchParams.get('limit') || '50');

    // PostgREST 스타일 eq./neq. 접두 파싱(프론트 쿼리 계약과 일치)
    const parseCond = (v: string): { op: 'eq' | 'neq'; val: string } =>
      v.startsWith('neq.') ? { op: 'neq', val: v.slice(4) }
      : v.startsWith('eq.') ? { op: 'eq', val: v.slice(3) }
      : { op: 'eq', val: v };

    // 필터 후 limit이 모자라지 않도록 넉넉히 가져와 거른 뒤 slice
    const pool = await getReports(Math.max(limit, 50) * 3) as Array<Record<string, unknown>>;
    let filtered = pool;
    if (agentParam) {
      const c = parseCond(agentParam);
      filtered = filtered.filter((r) => c.op === 'neq' ? r.agent_id !== c.val : r.agent_id === c.val);
    }
    for (const tp of typeParams) {
      const c = parseCond(tp);
      filtered = filtered.filter((r) => c.op === 'neq' ? r.report_type !== c.val : r.report_type === c.val);
    }
    // 명시적 필터가 없을 때만 기본 제외(health_check/directive/chairman)
    if (!agentParam && typeParams.length === 0) {
      filtered = filtered.filter((r) => r.report_type !== 'health_check' && r.report_type !== 'directive' && r.agent_id !== 'chairman');
    }
    return NextResponse.json(filtered.slice(0, limit));
  } catch (error) {
    console.error('Reports API error:', error);
    return NextResponse.json({ error: 'Failed to fetch reports' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { agent_id, title, content, report_type = 'general', meeting_id } = body;
    if (!agent_id || !title) {
      return NextResponse.json({ error: 'Missing agent_id or title' }, { status: 400 });
    }
    await saveReport(agent_id, title, content || '', report_type, meeting_id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Reports POST error:', error);
    return NextResponse.json({ error: 'Failed to save report' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id, status } = await req.json();
    if (!id || !status) return NextResponse.json({ error: 'Missing id or status' }, { status: 400 });
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }
    await updateReportStatus(id, status);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Failed to update report' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let id = req.nextUrl.searchParams.get('id') || undefined;
    if (!id) {
      try { id = (await req.json()).id; } catch {}
    }
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
    await dbDelete('reports', id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
