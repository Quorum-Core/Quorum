import { NextRequest, NextResponse } from 'next/server';
import { authorizedBrowser } from '@/lib/api-guard';
import { dbGet, dbQuery, updateDecisionUnlessTerminal, finalizeDirectiveWithReport } from '@/lib/db';
import { isTerminal } from '@/lib/decision-status';
import { normalizeAssignees } from '@/lib/assignees';

export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'directiveId invalid' }, { status: 400 });
    }
    const { directiveId, force } = body as Record<string, unknown>;
    if (!isSafeDirectiveId(directiveId)) {
      return NextResponse.json({ error: 'directiveId invalid' }, { status: 400 });
    }
    if (force != null && typeof force !== 'boolean') {
      return NextResponse.json({ error: 'force invalid' }, { status: 400 });
    }
    const safeDirectiveId = directiveId.trim();
    const safeForce = force === true;

    // 1. Get the directive
    const directive = await dbGet('decisions', safeDirectiveId) as Record<string, unknown> | undefined;
    if (!directive) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // 이미 확정된 directive(approve/reject/completed)는 complete가 status를 덮지 않도록 차단
    if (isTerminal(directive.status)) {
      return NextResponse.json({ error: 'Directive already finalized', status: directive.status }, { status: 409 });
    }

    // 배정 에이전트 총수 — progress.total 우선, 없으면 trigger_data.assignees
    let expectedTotal = 0;
    try {
      const prog = typeof directive.progress === 'string' ? JSON.parse(directive.progress as string) : directive.progress;
      expectedTotal = Number((prog as { total?: number })?.total) || 0;
    } catch {}
    if (!expectedTotal) {
      try {
        const td = typeof directive.trigger_data === 'string' ? JSON.parse(directive.trigger_data as string) : directive.trigger_data;
        // execute와 동일하게 정규화·중복제거한 수로 비교(어긋남 방지)
        expectedTotal = normalizeAssignees((td as { assignees?: unknown[] })?.assignees).length;
      } catch {}
    }

    // 2. If a worker already created the report, only close the directive.
    const existingReports = await dbQuery('reports', {
      where: { directive_id: safeDirectiveId },
      orderBy: 'created_at',
      ascending: false,
      limit: 1,
    }) as Record<string, unknown>[];

    if (existingReports[0]) {
      // #88: 초기 read 이후 reject/완료가 끼어도 덮지 않도록 CAS(stale read 기반 isTerminal 대신 원자적 전이).
      // CAS 실패(이미 terminal로 전이)면 completed로 못 바꾸므로 success로 위장하지 않고 409.
      const ok = await updateDecisionUnlessTerminal(safeDirectiveId, { status: 'completed' });
      if (!ok) {
        const f = await dbGet('decisions', safeDirectiveId) as { status?: string } | undefined;
        return NextResponse.json({ error: 'Directive already finalized', status: f?.status }, { status: 409 });
      }
      return NextResponse.json({
        success: true,
        report: existingReports[0],
        agentCount: null,
        reused: true,
      });
    }

    // 3. Get agent results — done과 error 모두 "끝남"으로 집계
    const all = await dbQuery('chat_queue', {
      like: { metadata: `%"directive_id":"${safeDirectiveId}"%` },
      orderBy: 'processed_at',
      ascending: true,
    }) as { agent_id: string; response: string; status: string; model: string }[];
    const doneItems = all.filter(q => q.status === 'done');
    const errorItems = all.filter(q => q.status === 'error');
    const finished = doneItems.length + errorItems.length;

    if (finished === 0) {
      return NextResponse.json({ error: 'No completed responses yet' }, { status: 400 });
    }

    // 아직 끝나지 않은 에이전트가 있으면(force 없이) 거부 — done+error로 판정
    if (!safeForce && expectedTotal > 0 && finished < expectedTotal) {
      return NextResponse.json(
        { error: 'Not all agents finished', finished, total: expectedTotal },
        { status: 409 }
      );
    }

    const isPartial = expectedTotal > 0 && finished < expectedTotal;
    const hasErrors = errorItems.length > 0;
    const titleSuffix = isPartial ? ` (부분 ${finished}/${expectedTotal})` : '';
    const nameOf = (a: string) => a.charAt(0).toUpperCase() + a.slice(1);

    // 4. Build report — 실패한 에이전트도 섹션에 명시(보고서 누락 방지)
    const sections = [
      ...doneItems.map(q => `## ${nameOf(q.agent_id)}\n\n${q.response || 'No response'}\n`),
      ...errorItems.map(q => `## ${nameOf(q.agent_id)}\n\n⚠️ 실패: ${q.response || 'error'}\n`),
    ].join('\n---\n\n');
    const reportContent = `# ${directive.title}\n\n${directive.description || ''}\n\n---\n\n${sections}`;

    // #93: status \uc804\uc774 + report\ub97c \ud55c \ud2b8\ub79c\uc7ad\uc158\uc73c\ub85c \u2014 terminal\uc774\uba74 ok:false(report \uc5c6\uc74c), active\uba74 \ub458 \ub2e4 \ucee4\ubc0b(crash\ub85c \uc778\ud55c report \uc720\uc2e4/\ub204\ub77d \ubc29\uc9c0).
    const fin = await finalizeDirectiveWithReport(
      safeDirectiveId, `\ud83d\udccb ${directive.title}${titleSuffix}`, reportContent,
      (isPartial || hasErrors) ? 'completed_with_errors' : 'completed',
    );
    if (!fin.ok) {
      const f = await dbGet('decisions', safeDirectiveId) as { status?: string } | undefined;
      return NextResponse.json({ error: 'Directive already finalized', status: f?.status }, { status: 409 });
    }
    const reportId = fin.reportId;

    return NextResponse.json({
      success: true,
      report: { id: reportId, title: `\ud83d\udccb ${directive.title}${titleSuffix}`, report_type: 'directive_report' },
      agentCount: finished,
      done: doneItems.length,
      errors: errorItems.length,
      partial: isPartial,
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function isSafeDirectiveId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(value.trim());
}
