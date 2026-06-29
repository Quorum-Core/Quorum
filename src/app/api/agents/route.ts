import { NextResponse } from 'next/server';
import { getAgentRegistry } from '@/lib/agent-registry';

// 클라용 에이전트 레지스트리(읽기 전용, public).
// 프롬프트 본문·모델 배정 등 서버 전용/대용량 필드는 제외 — 표시에 필요한 메타만 노출.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    // ?fresh=1 → 서버 TTL 캐시 우회(편집 직후 폴링이 최신 DB 반영). 일반 호출은 캐시 사용.
    const fresh = new URL(req.url).searchParams.get('fresh') === '1';
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
