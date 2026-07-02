import { NextRequest, NextResponse } from 'next/server';
import { getConversationHistory } from '@/lib/db';
import { authorized } from '@/lib/api-guard';

export async function GET(req: NextRequest) {
  // 대화 이력 읽기 — agent_id가 추측 쉬운 고정값이라 무가드 시 누구나 조회. same-origin/토큰만 허용.
  if (!authorized(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    const url = new URL(req.url);
    const agentId = url.searchParams.get('agent_id');
    const limit = parseLimit(url.searchParams.get('limit'), 10, 100);
    if (!agentId) return NextResponse.json({ error: 'Missing agent_id' }, { status: 400 });
    const safeAgentId = agentId.trim();
    if (!isSafeAgentId(safeAgentId)) return NextResponse.json({ error: 'agent_id invalid' }, { status: 400 });
    const history = await getConversationHistory(safeAgentId, limit);
    return NextResponse.json(history);
  } catch (error) {
    console.error('Conversations API error:', error);
    return NextResponse.json({ error: 'Failed to fetch conversations' }, { status: 500 });
  }
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}
