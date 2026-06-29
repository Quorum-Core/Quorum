'use client';

// 클라 에이전트 레지스트리 — DB 원천(/api/agents)을 1곳에서 fetch해 컨텍스트로 공급.
// Phase 3: 인프라만. 첫 페인트는 정적 fallback(src/data)으로 blank/undefined 방지,
//          마운트 후 /api/agents로 교체. 컴포넌트별 소비 이관은 Phase 4/5에서 동반.
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { AGENT_ROSTER } from '@/data/agent-config';
import { AGENT_DISPLAY, displayName as staticDisplayName, setDisplayCache } from '@/data/agent-names';
import { agentRelationships, type Relationship } from '@/data/relationships';
import { TOPIC_AGENTS } from '@/data/topics';

export type ClientAgent = {
  id: string; legacyId: string; number: string; name: string;
  displayKo: string; displayEn: string; department: string; tier: string;
  role: string; desc: string; color: string; emoji: string; floor: number;
  active: boolean; topics: string[]; relationships: Relationship[];
};

export type AgentRegistryValue = {
  agents: ClientAgent[];
  byId: Record<string, ClientAgent>;
  display: Record<string, { ko: string; en: string }>;
  floors: Record<string, number>;
  loading: boolean;                  // true = fetch 미완료. settle(성공/실패) 시 false.
  source: 'static' | 'remote';       // remote=DB fetch 반영, static=fallback(미완료/실패)
};

function buildMaps(agents: ClientAgent[], loading: boolean, source: 'static' | 'remote'): AgentRegistryValue {
  const byId: Record<string, ClientAgent> = {};
  const display: Record<string, { ko: string; en: string }> = {};
  const floors: Record<string, number> = {};
  for (const a of agents) {
    byId[a.id] = a;
    display[a.id] = { ko: a.displayKo, en: a.displayEn };
    floors[a.id] = a.floor;
  }
  return { agents, byId, display, floors, loading, source };
}

// 정적 fallback — src/data로 동일 shape 조립(서버 fetch 전/실패 시).
function staticAgents(): ClientAgent[] {
  return AGENT_ROSTER.map((a) => {
    const disp = AGENT_DISPLAY[a.id] || { ko: a.name, en: a.name };
    const topics = Object.entries(TOPIC_AGENTS)
      .filter(([, ids]) => ids.includes(a.id))
      .map(([t]) => t);
    return {
      id: a.id, legacyId: a.id, number: a.number, name: a.name,
      displayKo: disp.ko, displayEn: disp.en, department: a.department, tier: a.tier,
      role: a.role, desc: a.desc, color: '', emoji: a.emoji || '', floor: a.floor,
      active: true, topics, relationships: agentRelationships[a.id] || [],
    };
  });
}

const STATIC_VALUE = buildMaps(staticAgents(), true, 'static');

const Ctx = createContext<AgentRegistryValue>(STATIC_VALUE);

export function AgentRegistryProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<AgentRegistryValue>(STATIC_VALUE);

  useEffect(() => {
    let alive = true;
    const load = (fresh = false) => {
      fetch(fresh ? '/api/agents?fresh=1' : '/api/agents')  // 폴링/포커스는 서버 TTL 우회 → 최신 DB
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!alive) return;
          const agents = d?.agents as ClientAgent[] | undefined;
          // 데이터 있을 때만 갱신(transient 빈 응답으로 stale/clear 방지). settle 시 loading 해제.
          if (agents?.length) {
            const reg = buildMaps(agents, false, 'remote');
            setDisplayCache(reg.display);  // 정적 displayName() 호출부도 DB값 사용
            setValue(reg);
          } else setValue((v) => ({ ...v, loading: false }));
        })
        .catch(() => { if (alive) setValue((v) => ({ ...v, loading: false })); });
    };
    load();  // 첫 페인트는 캐시 OK(빠름)
    // DB 편집 반영 — 주기 폴링 + 탭 포커스 복귀 시 fresh(서버 TTL 우회) → 최악 ≈ 폴링 주기(30s).
    const iv = setInterval(() => load(true), 30_000);
    const onVis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAgentRegistry(): AgentRegistryValue {
  return useContext(Ctx);
}

// displayName 이관용 — 레지스트리 우선, 없으면 정적 helper로 폴백(점진 이관 안전).
export function useDisplayName(): (id: string, lang?: 'ko' | 'en') => string {
  const reg = useContext(Ctx);
  return (id: string, lang: 'ko' | 'en' = 'ko') =>
    reg.display[id]?.[lang] || staticDisplayName(id, lang);
}
