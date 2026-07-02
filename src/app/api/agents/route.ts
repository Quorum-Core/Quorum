import { NextResponse } from 'next/server';
import { authorized } from '@/lib/api-guard';
import { getAgentRegistry } from '@/lib/agent-registry';
import { rateLimited } from '@/lib/rate-limit';

// 클라용 에이전트 레지스트리(읽기 전용). same-origin/토큰 가드 — 내부 메타(relationships/topics 등) 익명 노출 차단(#3).
// 프롬프트 본문·모델 배정 등 서버 전용/대용량 필드는 제외 — 표시에 필요한 메타만 노출.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  // #3: 다른 read 라우트와 동일한 same-origin/토큰 가드. UI(same-origin) 통과, 익명 curl/봇 차단.
  if (!authorized(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  try {
    // ?fresh=1 → 서버 TTL 캐시 우회(편집 직후 폴링이 최신 DB 반영). 일반 호출은 캐시 사용.
    const fresh = new URL(req.url).searchParams.get('fresh') === '1';
    // #3: fresh 경로는 TTL 캐시 우회로 DB부하 → IP당 분당 30회 제한(폴링 30s 주기엔 충분).
    if (fresh) { const rl = rateLimited(req, 'agents-fresh', 30); if (rl) return rl; }
    const reg = await getAgentRegistry(fresh);
    const agents = reg.agents.map((a) => ({
      id: a.id,
      legacyId: a.legacyId,
      number: a.number,
      name: a.name,
      displayKo: a.displayKo,
      displayEn: a.displayEn,
      department: a.department,
      tier: a.tier,
      role: a.role,
      desc: a.desc,
      color: a.color,
      emoji: a.emoji,
      floor: a.floor,
      active: a.active,
      topics: a.topics,
      relationships: a.relationships,
    }));
    return NextResponse.json({ agents });
  } catch (e) {
    // 실패 시 빈 배열 — 클라는 정적 fallback 사용. 단 운영 탐지 위해 서버 로그 남김.
    console.error('/api/agents failed:', e);
    return NextResponse.json({ agents: [] });
  }
}
