import { NextRequest } from 'next/server';
import { startMeeting, followupMeeting, executeDirectiveInMeeting } from '@/lib/meeting-runner';
import { dbGet, dbQuery } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const meetingId = req.nextUrl.searchParams.get('meetingId') || req.nextUrl.searchParams.get('id');
    const scope = req.nextUrl.searchParams.get('scope') || 'all';
    if (!meetingId) return Response.json({ error: 'Missing meetingId' }, { status: 400 });

    const meeting = await dbGet('meetings', meetingId) as { id?: string | number; status?: string; summary?: string } | undefined;
    if (!meeting) return Response.json({ error: 'Meeting not found' }, { status: 404 });

    const status = { id: String(meeting.id ?? meetingId), status: meeting.status, summary: meeting.summary };
    if (scope === 'status') return Response.json({ meeting: status });

    const rows = await dbQuery('meeting_messages', {
      where: { meeting_id: meetingId },
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
      return { ...r, meeting_id: String(r.meeting_id ?? meetingId), payload };
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
  try {
    const body = await req.json();
    const { agenda, mode } = body;

    // 회의 시작 — meetingId 즉시 반환, 백그라운드 루프 기동
    if (mode === 'start') {
      if (!agenda) return Response.json({ error: 'Missing agenda' }, { status: 400 });
      if (typeof agenda !== 'string' || agenda.length > 2000) return Response.json({ error: 'agenda too long' }, { status: 400 });
      try {
        const { meetingId, participants, topic } = await startMeeting(agenda, body.agents, body.directiveId);
        return Response.json({ meetingId, participants, topic });
      } catch (e) {
        return Response.json({ error: String((e as Error).message || e) }, { status: 400 });
      }
    }

    // 추가 질문/참석자 추가 — 같은 회의에 라운드 누적
    if (mode === 'followup') {
      const { meetingId, message, addAgents } = body;
      if (!meetingId || !message) return Response.json({ error: 'Missing meetingId or message' }, { status: 400 });
      if (typeof message !== 'string' || message.length > 2000) return Response.json({ error: 'message too long' }, { status: 400 });
      try {
        await followupMeeting(meetingId, message, Array.isArray(addAgents) ? addAgents : []);
      } catch (e) {
        return Response.json({ error: String((e as Error).message || e) }, { status: 400 });
      }
      return Response.json({ ok: true }, { status: 202 });
    }

    // 승인된 회의에서 지시 실행 — 각 에이전트 분석을 회의 발언으로 이어붙임(같은 화면 실시간)
    if (mode === 'execute') {
      const { meetingId, directiveId, title, description, agents } = body;
      if (!meetingId || !directiveId || !title) return Response.json({ error: 'Missing meetingId/directiveId/title' }, { status: 400 });
      void executeDirectiveInMeeting(meetingId, directiveId, title, String(description || ''), Array.isArray(agents) ? agents : []);
      return Response.json({ started: true }, { status: 202 });
    }

    return Response.json({ error: 'Missing mode' }, { status: 400 });
  } catch (error) {
    console.error('Meeting API error:', error);
    return Response.json({ error: 'Meeting failed' }, { status: 500 });
  }
}
