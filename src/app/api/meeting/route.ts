import { NextRequest } from 'next/server';
import { authorizedBrowser, authorized } from '@/lib/api-guard';
import { rateLimited } from '@/lib/rate-limit';
import { startMeeting, followupMeeting, executeDirectiveInMeeting } from '@/lib/meeting-runner';
import { dbGet, dbQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  // 보안 모델 = "public-by-ID(capability)": meetingId는 추측 불가한 UUID이며, 그것을 아는 자에게 트랜스크립트 공개.
  //   meetings·meeting_messages는 Realtime 구독 위해 anon SELECT 정책이 있어 공개 anon 키로 supabase 직접 조회도 가능(#112).
  //   따라서 이 API 가드는 비공개 보장이 아니라 same-origin 편의/남용 완화(defense-in-depth)일 뿐.
  //   진짜 per-user 비공개가 필요하면 Supabase Auth + meeting_members/owner_id RLS(authorized Realtime channel) 필요 — 로그인 도입 시 후속.
  if (!authorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 });
  try {
    const meetingId = req.nextUrl.searchParams.get('meetingId') || req.nextUrl.searchParams.get('id');
    const scope = req.nextUrl.searchParams.get('scope') || 'all';
    if (!meetingId) return Response.json({ error: 'Missing meetingId' }, { status: 400 });
    const safeMeetingId = normalizeLookupId(meetingId);
    if (!safeMeetingId) return Response.json({ error: 'meetingId invalid' }, { status: 400 });

    const meeting = await dbGet('meetings', safeMeetingId) as { id?: string | number; status?: string; summary?: string } | undefined;
    if (!meeting) return Response.json({ error: 'Meeting not found' }, { status: 404 });

    const status = { id: String(meeting.id ?? safeMeetingId), status: meeting.status, summary: meeting.summary };
    if (scope === 'status') return Response.json({ meeting: status });

    const rows = await dbQuery('meeting_messages', {
      where: { meeting_id: safeMeetingId },
      orderBy: 'seq',
      ascending: true,
      limit: 1000,
    });
    const messages = rows.map((row) => {
      const r = row as Record<string, unknown>;
      let payload = r.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch {}
      }
      return { ...r, meeting_id: String(r.meeting_id ?? safeMeetingId), payload };
    });
    if (scope === 'messages') return Response.json({ messages });
    return Response.json({ meeting: status, messages });
  } catch (error) {
    console.error('Meeting API GET error:', error);
    return Response.json({ error: 'Meeting load failed' }, { status: 500 });
  }
}

// 백그라운드 회의 — 서버(Render persistent Node)가 끝까지 진행, 발언은 meeting_messages에 단계 저장.
// 클라는 meetingId로 Supabase Realtime 구독. 탭 닫아도 서버 계속.
export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return Response.json({ error: 'forbidden' }, { status: 403 }); // #73
  { const rl = rateLimited(req, 'meeting', 5); if (rl) return rl; }  // 비용 가드(DoW): IP당 분당 5회
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'invalid body' }, { status: 400 });
    const { agenda, mode } = body;
    const row = body as Record<string, unknown>;

    // 회의 시작 — meetingId 즉시 반환, 백그라운드 루프 기동
    if (mode === 'start') {
      if (typeof agenda !== 'string' || !agenda.trim() || agenda.length > 2000) return Response.json({ error: 'agenda too long' }, { status: 400 });
      const agents = sanitizeAgentIds(row.agents, 'agents');
      if ('error' in agents) return Response.json({ error: agents.error }, { status: 400 });
      let safeDirectiveId: string | undefined;
      if (row.directiveId != null) {
        const normalizedDirectiveId = normalizeDirectiveId(row.directiveId);
        if (!normalizedDirectiveId) return Response.json({ error: 'directiveId invalid' }, { status: 400 });
        safeDirectiveId = normalizedDirectiveId;
      }
      try {
        const { meetingId, participants, topic } = await startMeeting(agenda.trim(), agents.value, safeDirectiveId);
        return Response.json({ meetingId, participants, topic });
      } catch (e) {
        const message = safeRunnerError(e);
        if (!message) console.error('Meeting start failed:', e);
        return Response.json({ error: message || 'Meeting start failed' }, { status: message ? 400 : 500 });
      }
    }

    // 추가 질문/참석자 추가 — 같은 회의에 라운드 누적
    if (mode === 'followup') {
      const { meetingId, message, addAgents } = body;
      const safeMeetingId = normalizeLookupId(meetingId);
      if (!safeMeetingId) return Response.json({ error: 'meetingId invalid' }, { status: 400 });
      if (typeof message !== 'string' || !message.trim() || message.length > 2000) return Response.json({ error: 'message too long' }, { status: 400 });
      const agents = sanitizeAgentIds(addAgents, 'addAgents');
      if ('error' in agents) return Response.json({ error: agents.error }, { status: 400 });
      try {
        await followupMeeting(safeMeetingId, message.trim(), agents.value);
      } catch (e) {
        const message = safeRunnerError(e);
        if (!message) console.error('Meeting followup failed:', e);
        return Response.json({ error: message || 'Meeting followup failed' }, { status: message ? 400 : 500 });
      }
      return Response.json({ ok: true }, { status: 202 });
    }

    // 승인된 회의에서 지시 실행 — 각 에이전트 분석을 회의 발언으로 이어붙임(같은 화면 실시간)
    if (mode === 'execute') {
      const { meetingId, directiveId, title, description, agents } = body;
      const safeMeetingId = normalizeLookupId(meetingId);
      if (!safeMeetingId) return Response.json({ error: 'meetingId invalid' }, { status: 400 });
      const safeDirectiveId = normalizeDirectiveId(directiveId);
      if (!safeDirectiveId) return Response.json({ error: 'directiveId invalid' }, { status: 400 });
      // start(agenda)·followup(message)과 동일하게 길이 제한 — 무제한 입력으로 인한 저장·LLM 남용 차단.
      if (typeof title !== 'string' || !title.trim() || title.length > 200) return Response.json({ error: 'title invalid' }, { status: 400 });
      if (description != null && (typeof description !== 'string' || description.length > 5000)) return Response.json({ error: 'description too long' }, { status: 400 });
      const safeAgents = sanitizeAgentIds(agents, 'agents');
      if ('error' in safeAgents) return Response.json({ error: safeAgents.error }, { status: 400 });
      void executeDirectiveInMeeting(safeMeetingId, safeDirectiveId, title.trim(), typeof description === 'string' ? description : '', safeAgents.value);
      return Response.json({ started: true }, { status: 202 });
    }

    return Response.json({ error: 'Missing mode' }, { status: 400 });
  } catch (error) {
    console.error('Meeting API error:', error);
    return Response.json({ error: 'Meeting failed' }, { status: 500 });
  }
}

function sanitizeAgentIds(raw: unknown, name: string): { value: string[] } | { error: string } {
  if (raw == null) return { value: [] };
  if (!Array.isArray(raw)) return { error: `${name} invalid` };
  if (raw.length > 30) return { error: `${name} too many` };
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string' || !isSafeAgentId(item.trim())) return { error: `${name} invalid` };
    const id = item.trim();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { value: ids };
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

function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function safeRunnerError(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error || '');
  return new Set(['Missing agenda', 'No valid participants', 'Meeting not found', 'Meeting in error state']).has(message)
    ? message
    : null;
}
