import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbInsert, dbQuery, updateDecision, updateDirective } from '@/lib/db';
import { isTerminal } from '@/lib/decision-status';

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

export async function GET() {
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
  try {
    const body = await req.json();
    const { title, description, assignees, priority, meetingId } = body;
    if (!title) return NextResponse.json({ error: 'Title required' }, { status: 400 });

    const assigneeIds = (assignees || []).map((a: { id?: string } | string) => typeof a === 'string' ? a : a.id).filter(Boolean);
    const decisionType = guessDecisionType(title, description || '');

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
    if (reusable) {
      const updates = {
        description: description || title,
        priority: priority || 'normal',
        status: 'pending',
        trigger_data: JSON.stringify({ assignees: assigneeIds }),
        progress: JSON.stringify({ total: assigneeIds.length, completed: 0, agent_results: {} }),
        ...(meetingId ? { meeting_id: meetingId } : {}),
      };
      await updateDecision(reusable.id, updates);
      await updateDirective(reusable.id, { content: description || '', assignees: JSON.stringify(assignees || []), priority: priority || 'normal' }).catch(() => {});
      return NextResponse.json({
        directive: {
          id: reusable.id, title, description: description || title,
          type: decisionType, status: 'pending', priority: priority || 'normal',
          trigger_source: 'directive', trigger_agent_id: 'chairman',
          trigger_data: { assignees: assigneeIds },
        },
        reused: true,
      });
    }

    const id = crypto.randomUUID();

    await dbInsert('decisions', {
      id,
      type: decisionType,
      title,
      description: description || title,
      priority: priority || 'normal',
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
      content: description || '',
      assignees: JSON.stringify(assignees || []),
      priority: priority || 'normal',
    });

    const directive = {
      id, title, description: description || title,
      type: decisionType, status: 'pending', priority: priority || 'normal',
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
  try {
    const body = await req.json();
    const { id, status } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    if (status) {
      const cur = await dbGet('decisions', id) as { status?: string } | undefined;
      if (cur && isTerminal(cur.status)) {
        return NextResponse.json({ error: 'Directive already finalized', status: cur.status }, { status: 409 });
      }
      await updateDirective(id, { status });
      await updateDecision(id, { status });
    }
    return NextResponse.json({ id, status });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value as T;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
