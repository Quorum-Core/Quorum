import { NextRequest, NextResponse } from 'next/server';
import { authorizedBrowser, authorized } from '@/lib/api-guard';
import { dbGet, dbInsert, dbQuery, updateDecisionUnlessTerminal, transitionDecisionStatus, softDeleteDecision, updateDirective } from '@/lib/db';
import { isTerminal, canTransition } from '@/lib/decision-status';

const DIRECTIVE_PRIORITIES = new Set(['low', 'medium', 'normal', 'high', 'urgent']);
type StoredAssignee = string | { id: string; task?: string };

// Guess decision type from directive content
function guessDecisionType(title: string, desc: string): string {
  const text = `${title} ${desc}`.toLowerCase();
  if (/\ud22c\uc790|\ub9e4\ub9e4|\ud3ec\uc9c0\uc158|\ub9e4\uc218|\ub9e4\ub3c4|trading/.test(text)) return 'investment';
  if (/\uac1c\ubc1c|\ube4c\ub4dc|\ubc30\ud3ec|\ucf54\ub4dc|ui|api|\ubc84\uadf8/.test(text)) return 'product_development';
  if (/\ucf58\ud150\uce20|\uae00|\ud3ec\uc2a4\ud2b8|sns|x|\ud2b8\uc704\ud130|\ube14\ub85c\uadf8/.test(text)) return 'content_publish';
  if (/\ub9c8\ucf00\ud305|\ud64d\ubcf4|seo|\uad11\uace0/.test(text)) return 'content_publish';
  if (/\ucc44\uc6a9|\uc778\uc7ac|\uc678\uc8fc/.test(text)) return 'hiring';
  if (/\uc7a5\uc560|\uc11c\ubc84|\ubaa8\ub2c8\ud130\ub9c1|\ubcf4\uc548/.test(text)) return 'ops_incident';
  if (/\ub9ac\uc2a4\ud06c|\uc704\ud5d8|\uac10\uc0ac/.test(text)) return 'risk_alert';
  if (/\uc2dc\uc7a5|\ub274\uc2a4|\ud2b8\ub80c\ub4dc|\uacbd\uc7c1/.test(text)) return 'market_response';
  return 'strategy';
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #107: 민감 read 가드
  try {
    const directives = await dbQuery('directives', { orderBy: 'created_at', ascending: false, limit: 50 }) as Record<string, unknown>[];

    const parsed = directives.map(d => ({
      ...d,
      assignees: parseJson(d.assignees, []),
      parsed: {
        description: d.content || '',
        assignees: parseJson(d.assignees, []),
      },
    }));

    const decisions = await dbQuery('decisions', {
      where: { trigger_source: 'directive' },
      orderBy: 'created_at',
      ascending: false,
      limit: 50,
    });

    return NextResponse.json({ directives: parsed, decisions });
  } catch {
    return NextResponse.json({ directives: [], decisions: [] });
  }
}

export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  try {
    const body = await req.json().catch(() => null);
    const input = sanitizeDirectiveCreate(body);
    if ('error' in input) return NextResponse.json({ error: input.error }, { status: 400 });
    const { title, description, assignees, priority, meetingId } = input.value;
    const assigneeInput = sanitizeDirectiveAssignees(assignees);
    if ('error' in assigneeInput) return NextResponse.json({ error: assigneeInput.error }, { status: 400 });
    const { ids: assigneeIds, stored: storedAssignees } = assigneeInput.value;

    const decisionType = guessDecisionType(title, description);

    // 같은 회의(meeting_id)면 status 무관하게 재사용 — 회의당 지시 1개(중복 방지)
    let reusable: { id: string; status?: string } | null = null;
    if (meetingId) {
      const byMeeting = await dbQuery('decisions', {
        where: { meeting_id: meetingId, trigger_source: 'directive' },
        orderBy: 'created_at', ascending: false, limit: 1,
      }) as Array<{ id: string; status?: string }>;
      if (byMeeting[0]) reusable = byMeeting[0];
    }
    // meeting_id 매칭 없으면(구버전 회의) 같은 제목 지시 재사용 — status 무관(완료된 것 재실행 시도 포함, 중복 방지)
    if (!reusable) {
      const existing = await dbQuery('decisions', {
        where: { trigger_source: 'directive', title },
        orderBy: 'created_at', ascending: false, limit: 1,
      }) as Array<{ id: string; status?: string }>;
      reusable = existing[0] || null;
    }
    // #76: 종결(completed/rejected 등)된 지시는 재사용으로 pending 회귀 금지 → 새 decision 생성(reusable 해제).
    // deleted(soft delete)는 terminal 집합엔 없지만 재사용으로 부활하면 안 되므로 함께 제외.
    if (reusable && (isTerminal(reusable.status) || reusable.status === 'deleted')) reusable = null;
    if (reusable) {
      const updates = {
        description: description || title,
        priority,
        status: 'pending',
        trigger_data: JSON.stringify({ assignees: assigneeIds }),
        progress: JSON.stringify({ total: assigneeIds.length, completed: 0, agent_results: {} }),
        ...(meetingId ? { meeting_id: meetingId } : {}),
      };
      // #94: 재사용 갱신도 CAS — read↔write 사이 reject/완료 끼면 terminal→pending 회귀 금지. 실패 시 새 decision 생성으로 폴백.
      const reusedOk = await updateDecisionUnlessTerminal(reusable.id, updates);
      if (reusedOk) {
        await updateDirective(reusable.id, { content: description, assignees: JSON.stringify(storedAssignees), priority }).catch(() => {});
        return NextResponse.json({
          directive: {
            id: reusable.id, title, description: description || title,
            type: decisionType, status: 'pending', priority,
            trigger_source: 'directive', trigger_agent_id: 'chairman',
            trigger_data: { assignees: assigneeIds },
          },
          reused: true,
        });
      }
      // CAS 실패(경합으로 terminal) → 재사용 포기, 아래 새 decision 생성
    }

    const id = crypto.randomUUID();

    await dbInsert('decisions', {
      id,
      type: decisionType,
      title,
      description: description || title,
      priority,
      status: 'pending',
      trigger_source: 'directive',
      trigger_agent_id: 'chairman',
      trigger_data: JSON.stringify({ assignees: assigneeIds }),
      progress: JSON.stringify({ total: assigneeIds.length, completed: 0, agent_results: {} }),
      ...(meetingId ? { meeting_id: meetingId } : {}),
    });

    await dbInsert('directives', {
      id,
      title,
      content: description,
      assignees: JSON.stringify(storedAssignees),
      priority,
    });

    const directive = {
      id, title, description: description || title,
      type: decisionType, status: 'pending', priority,
      trigger_source: 'directive', trigger_agent_id: 'chairman',
      trigger_data: { assignees: assigneeIds },
    };

    return NextResponse.json({ directive });
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
    const { id, status } = body as Record<string, unknown>;
    const safeId = normalizeDirectiveId(id);
    if (!safeId) return NextResponse.json({ error: 'id invalid' }, { status: 400 });

    if (status) {
      // #93/#100: 허용 status만(임의 값 주입 차단). approval_requested·deleted 포함(실제 UI 사용).
      const ALLOWED = new Set(['pending', 'approval_requested', 'approved', 'rejected', 'in_progress', 'executing', 'completed', 'completed_with_errors', 'deleted']);
      if (typeof status !== 'string' || !ALLOWED.has(status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 });
      // #106: 소프트삭제는 terminal 출발도 허용 — 전용 경로.
      if (status === 'deleted') {
        const ok = await softDeleteDecision(safeId);
        if (!ok) return NextResponse.json({ error: 'already deleted or not found' }, { status: 409 });
        await updateDirective(safeId, { status: 'deleted' }).catch(() => {});
        return NextResponse.json({ id: safeId, status });
      }
      // #102: 비정상 전이 차단(pending→completed 점프·approved→pending 역행 등).
      const curD = await dbGet('decisions', safeId) as { status?: string } | undefined;
      if (curD && !canTransition(curD.status, status)) {
        return NextResponse.json({ error: 'invalid transition', from: curD.status, to: status }, { status: 409 });
      }
      // #101: from CAS — read→write 사이 status 변경 시 패배(stale 전이 차단). terminal 출발도 차단.
      const ok = await transitionDecisionStatus(safeId, String(curD?.status ?? ''), { status });
      if (!ok) {
        const f = await dbGet('decisions', safeId) as { status?: string } | undefined;
        return NextResponse.json({ error: 'status changed or finalized', status: f?.status }, { status: 409 });
      }
      await updateDirective(safeId, { status }).catch(() => {});
    }
    return NextResponse.json({ id: safeId, status });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function sanitizeDirectiveAssignees(raw: unknown): { value: { ids: string[]; stored: StoredAssignee[] } } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'assignees invalid' };
  if (raw.length === 0) return { error: 'assignees required' };
  if (raw.length > 30) return { error: 'assignees too many' };
  const ids: string[] = [];
  const stored: StoredAssignee[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    let id = '';
    let task: string | undefined;
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>;
      if (typeof row.id !== 'string') return { error: 'assignees invalid' };
      id = row.id.trim();
      if (row.task != null) {
        if (typeof row.task !== 'string' || row.task.length > 200) return { error: 'assignee task invalid' };
        task = row.task.trim();
      }
    } else {
      return { error: 'assignees invalid' };
    }
    if (!isSafeAgentId(id)) return { error: 'assignees invalid' };
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    stored.push(task ? { id, task } : id);
  }

  if (ids.length === 0) return { error: 'assignees required' };
  return { value: { ids, stored } };
}

function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function normalizeLookupId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(trimmed) ? trimmed : null;
}

function normalizeDirectiveId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9-]{1,100}$/.test(trimmed) ? trimmed : null;
}

function sanitizeDirectiveCreate(body: unknown): {
  value: { title: string; description: string; assignees: unknown; priority: string; meetingId?: string };
} | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid body' };
  const row = body as Record<string, unknown>;
  if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200) return { error: 'title invalid' };
  if (row.description != null && (typeof row.description !== 'string' || row.description.length > 5000)) return { error: 'description too long' };
  if (row.priority != null && (typeof row.priority !== 'string' || !DIRECTIVE_PRIORITIES.has(row.priority))) return { error: 'priority invalid' };
  const meetingId = row.meetingId == null ? undefined : normalizeLookupId(row.meetingId);
  if (row.meetingId != null && !meetingId) return { error: 'meetingId invalid' };
  const description = typeof row.description === 'string' ? row.description : '';
  const priority = typeof row.priority === 'string' ? row.priority : 'normal';
  return {
    value: {
      title: row.title.trim(),
      description,
      assignees: row.assignees,
      priority,
      ...(meetingId ? { meetingId } : {}),
    },
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
