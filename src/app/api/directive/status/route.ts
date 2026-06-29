import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbQuery } from '@/lib/db';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const directiveId = searchParams.get('id');
    if (!directiveId) return NextResponse.json({ error: 'id required' }, { status: 400 });

    // Get directive
    const directive = await dbGet('decisions', directiveId) as Record<string, unknown> | undefined;
    if (!directive) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Get chat_queue tasks for this directive
    const tasks = await dbQuery('chat_queue', {
      like: { metadata: `%"directive_id":"${directiveId}"%` },
      orderBy: 'created_at',
      ascending: true,
    }) as Record<string, unknown>[];

    const total = tasks.length;
    const completed = tasks.filter(t => t.status === 'done').length;
    const processing = tasks.filter(t => t.status === 'processing').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const errors = tasks.filter(t => t.status === 'error').length;
    const finished = completed + errors;

    return NextResponse.json({
      directive: {
        id: directive.id,
        title: directive.title,
        status: directive.status,
        progress: parseJson(directive.progress, null),
      },
      tasks: tasks.map(t => ({
        id: t.id,
        agent_id: t.agent_id,
        status: t.status,
        model: t.model,
        message: t.message,
        response: t.response,
        processed_at: t.processed_at,
      })),
      summary: { total, completed, processing, pending, errors, finished },
      allDone: total > 0 && completed === total,
      allFinished: total > 0 && finished === total,
    });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
