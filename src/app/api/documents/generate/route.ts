// 회의 → 문서 생성 API. POST { meetingId, format?, type? }.
// format: 'json'(기본, 미리보기 {document, markdown}) | 'md'(다운로드) | 'docx'(다운로드)
import { NextRequest, NextResponse } from 'next/server';
import { dbGet, dbQuery } from '@/lib/db';
import {
  buildMeetingMinutes,
  toMarkdown,
  toDocxBuffer,
  type MeetingRow,
  type MeetingMessageRow,
} from '@/lib/docgen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// 파일명 안전화(헤더 인젝션/특수문자 방지). 한글 등 유지 — 헤더엔 인코딩해 넣음.
function safeName(s: string): string {
  return (s || 'document').replace(/[^\w가-힣\- ]+/g, '_').trim().slice(0, 60) || 'document';
}

// Content-Disposition 값 — 양쪽 다 한글 파일명 표시되게.
// filename*: RFC 5987(Chrome/Firefox/최신 Safari가 우선 사용).
// filename: filename* 미지원 브라우저(일부 Safari)용 — UTF-8 바이트를 latin1 문자열로 넣으면(헤더는 바이트값 보존)
//   브라우저가 UTF-8로 디코드해 한글 표시. 따옴표/제어문자만 치환.
function contentDisposition(stem: string, ext: string): string {
  const name = (stem + ext).replace(/[\\/:*?"<>|\r\n]/g, '_');
  const latin1 = Buffer.from(name, 'utf8').toString('latin1');
  const utf8 = encodeURIComponent(name);
  return `attachment; filename="${latin1}"; filename*=UTF-8''${utf8}`;
}

export async function POST(req: NextRequest) {
  try {
    const { meetingId, format = 'json' } = await req.json();
    if (!meetingId) return NextResponse.json({ error: 'Missing meetingId' }, { status: 400 });
    if (!['json', 'md', 'docx'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format' }, { status: 400 });
    }

    const meeting = (await dbGet('meetings', String(meetingId))) as MeetingRow | undefined;
    if (!meeting) return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });

    const messages = (await dbQuery('meeting_messages', {
      where: { meeting_id: meetingId },
      orderBy: 'seq',
      ascending: true,
    })) as MeetingMessageRow[];

    const document = buildMeetingMinutes(meeting, messages);
    const base = safeName(document.title);

    if (format === 'md') {
      return new NextResponse(toMarkdown(document), {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': contentDisposition(base, '.md'),
        },
      });
    }
    if (format === 'docx') {
      const buf = await toDocxBuffer(document);
      return new NextResponse(buf as unknown as BodyInit, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'Content-Disposition': contentDisposition(base, '.docx'),
        },
      });
    }
    // json: 미리보기 — 구조화 문서 + 마크다운 동시 반환
    return NextResponse.json({ document, markdown: toMarkdown(document) });
  } catch (error) {
    console.error('Document generate error:', error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: `문서 생성 오류: ${detail}` }, { status: 500 });
  }
}
