import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbQuery, updateDecision, upsertDirectiveReport } from '@/lib/db';
import { isTerminal } from '@/lib/decision-status';
import { normalizeAssignees } from '@/lib/assignees';

export async function POST(req: NextRequest) {
  try {
    const { directiveId, force } = await req.json();
    if (!directiveId) return NextResponse.json({ error: 'directiveId required' }, { status: 400 });

    // 1. Get the directive
    const directive = await dbGet('decisions', directiveId) as Record<string, unknown> | undefined;
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
      where: { directive_id: directiveId },
      orderBy: 'created_at',
      ascending: false,
      limit: 1,
    }) as Record<string, unknown>[];

    if (existingReports[0]) {
      // 워커가 이미 completed_with_errors 등으로 종결한 경우 completed로 덮어쓰지 않음
      if (!isTerminal(directive.status)) await updateDecision(directiveId, { status: 'completed' });
      return NextResponse.json({
        success: true,
        report: existingReports[0],
        agentCount: null,
        reused: true,
      });
    }

    // 3. Get agent results — done과 error 모두 "끝남"으로 집계
    const all = await dbQuery('chat_queue', {
      like: { metadata: `%"directive_id":"${directiveId}"%` },
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
    if (!force && expectedTotal > 0 && finished < expectedTotal) {
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

    // 5. upsert\ub85c \uc800\uc7a5 \u2014 execute/worker\uc640 \ubcf4\uace0\uc11c \uc911\ubcf5\u00b7race \ubc29\uc9c0
    const reportId = await upsertDirectiveReport(directiveId, `\ud83d\udccb ${directive.title}${titleSuffix}`, reportContent);

    // 6. \ubd80\ubd84\uc774\uac70\ub098 \uc2e4\ud328 \ud3ec\ud568\uc774\uba74 completed_with_errors
    await updateDecision(directiveId, { status: (isPartial || hasErrors) ? 'completed_with_errors' : 'completed' });

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
