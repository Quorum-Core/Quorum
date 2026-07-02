'use client';

import { Component, ReactNode, useEffect, useState, CSSProperties } from 'react';
import { LangProvider } from '@/context/LangContext';
import { ReportProvider } from '@/context/ReportContext';
import { AgentRegistryProvider } from '@/context/AgentRegistryContext';
import { useLang } from '@/context/LangContext';
import ChairmanDashboard from '@/components/ChairmanDashboard';
import TimelineView from '@/components/TimelineView';
import { MeetingRoom, type MeetingMessage } from '@/components/MeetingRoom';
import { floors as floorData, Agent } from '@/data/floors';
import { displayName } from '@/data/agent-names';
import { detectTopic, TOPIC_AGENTS } from '@/data/topics';
import { apiFetch } from '@/lib/api-fetch';

// 칩 → Agent 객체. id(부서 slug)와 코드네임 둘 다로 조회 가능(Phase 4 rename 호환).
const AGENT_BY_NAME: Record<string, Agent> = {};
floorData.forEach((fl) => fl.agents.forEach((a) => {
  AGENT_BY_NAME[a.name.toLowerCase()] = a;
  AGENT_BY_NAME[a.id] = a;
}));

// ── 엔터프라이즈 팔레트 (corporate navy + cool slate) ──
const C = {
  bg: '#F6F7F9',          // 페이지/카드 surface (cool off-white)
  ink: '#16203A',         // primary navy (버튼·다크 층·헤드라인)
  accent: '#2B4C7E',      // 라벨·뱃지 (corporate blue)
  working: '#3E6BB0',     // 진행 상태·flow
  done: '#2F7D62',        // 완료 (의미색)
  t: (a: number) => `rgba(22,32,58,${a})`,   // ink 기반 텍스트/라인
  paper: (a: number) => `rgba(255,255,255,${a})`, // 다크 위 텍스트
};

// navy → steel gray 모노 스케일

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ color: C.ink, fontSize: 18, marginBottom: 16 }}>Something went wrong</p>
            <button
              onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
              style={{ padding: '8px 16px', background: C.ink, color: '#fff', borderRadius: 10, border: 'none', fontWeight: 500, cursor: 'pointer' }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── zen 키프레임 (prefers-reduced-motion 시 정지) ──
const ZEN_KEYFRAMES = `
@keyframes quorumBreathe { 0%,100%{opacity:.5;transform:scale(1)} 50%{opacity:1;transform:scale(1.18)} }
@keyframes pulseRing { 0%{box-shadow:0 0 0 0 rgba(62,107,176,0.4)} 100%{box-shadow:0 0 0 6px rgba(62,107,176,0)} }
@media (prefers-reduced-motion: reduce){ .quorum-dot{animation:none !important} }
.quorum-main{ transition:padding-right .3s ease }
@media (min-width:768px){ .quorum-main.quorum-open{ padding-right:420px } }
`;

const FONT =
  "'SUIT', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', sans-serif";

type View = 'onboarding' | 'tower';

interface FloorDef {
  f: string;
  ko: string;
  en: string;
  agents: string[];
}

const FLOORS: FloorDef[] = [
  { f: 'lead', ko: '총괄', en: 'Lead', agents: ['lead'] },
  { f: 'plan', ko: '기획', en: 'Planning', agents: ['strategy', 'finance', 'legal'] },
  { f: 'risk', ko: '리스크/감사', en: 'Risk / Audit', agents: ['risk', 'audit'] },
  { f: 'eng', ko: '엔지니어링', en: 'Engineering', agents: ['design', 'dev', 'qa'] },
  { f: 'content', ko: '콘텐츠', en: 'Content', agents: ['pr', 'copy', 'editor', 'research'] },
  { f: 'mktg', ko: '마케팅', en: 'Marketing', agents: ['growth', 'brand', 'support', 'performance', 'sales'] },
  { f: 'ict', ko: 'ICT', en: 'ICT', agents: ['infra', 'monitoring', 'security'] },
  { f: 'hr', ko: 'HR', en: 'HR', agents: ['recruiting', 'evaluation'] },
  { f: 'capital', ko: '캐피탈', en: 'Capital', agents: ['quant', 'trading', 'global', 'field', 'hedge', 'valuation'] },
  { f: 'ops', ko: '운영', en: 'Operations', agents: ['operations'] },
];

// 종합 슬롯(Counsely) + 부서 카드 구성.
const COUNSELY = FLOORS[0].agents[0];
const DEPARTMENTS = FLOORS.slice(1);

type JobMember = { id: string; name: string; role: 'analysis' | 'verify' | 'synth'; status: 'pending' | 'running' | 'done' | 'error'; reply?: string };
type Job = { id: number; directive: string; at: string; members: JobMember[]; expanded: boolean; meetingId?: string };
// /api/decisions 행(지시) — 회의/작업 변환 입력. 필드는 DB 컬럼명 그대로.
type DbAgentResult = { status?: string; response?: string };
type DbDecision = {
  id?: string | number;
  title?: string;
  status?: string;
  meeting_id?: string | number;
  progress?: string | { agent_results?: Record<string, DbAgentResult> };
  trigger_data?: { assignees?: unknown } | null;
};

const STR = {
  ko: {
    badge: '한 사람 + AI 에이전트', h1a: '조용히', h1b: '통제되는', h1c: '조직',
    sub: '터미널의 카오스 대신, 각 부서에서 일하는 30명의 에이전트를 한눈에. 분석 → 검증 → 종합.',
    cta: '시작하기', modalTitle: '시작합니다',
    modalBody: '30명의 AI 에이전트가 부서별로 독립적으로 분석을 시작합니다.',
    back: '돌아가기', enter: '입장',
    obTitle: 'Quorum에 오신 것을 환영합니다', obSub: '30명의 AI 에이전트가 부서별로 분석·검증·종합을 수행합니다. 바로 시작하세요.',
    next: '시작하기',
    towerTitle: 'Quorum', towerSub: '',
    exit: '나가기', reportLabel: '진행 중 보고', legWorking: '분석 중', legDone: '완료', legIdle: '대기',
  },
  en: {
    badge: 'One human + AI agents', h1a: 'A quietly', h1b: 'governed', h1c: 'organization',
    sub: 'No terminal chaos — see all 30 agents working across departments. Analyze → verify → synthesize.',
    cta: 'Get started', modalTitle: 'Getting started',
    modalBody: '30 AI agents will begin analyzing independently across departments.',
    back: 'Go back', enter: 'Enter',
    obTitle: 'Welcome to Quorum', obSub: '30 AI agents work across departments — analyze, verify, synthesize. Jump right in.',
    next: 'Get started',
    towerTitle: 'Quorum', towerSub: '',
    exit: 'Exit', reportLabel: 'Report in progress', legWorking: 'Analyzing', legDone: 'Done', legIdle: 'Idle',
  },
} as const;

function HomeContent() {
  const { lang, setLang } = useLang();
  const koOn = lang === 'ko';
  const dn = (n: string) => displayName(n, koOn ? 'ko' : 'en');
  const t = STR[koOn ? 'ko' : 'en'];

  const [view, setView] = useState<View>('tower');
  const [team, setTeam] = useState<string[]>([]);
  const [directive, setDirective] = useState('');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dbActiveDirs, setDbActiveDirs] = useState<Job[]>([]); // DB 진행중·미결재 지시 — 작업중에 항상 표시

  // DB의 in_progress·pending 지시를 폴링해 작업중에 합침(세션 jobs에 없어도 무조건 표시)
  useEffect(() => {
    if (view !== 'tower') return;
    const hashId = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
    const parseAssignees = (d: DbDecision): string[] => {
      let a: unknown = d?.trigger_data?.assignees;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = []; } }
      return Array.isArray(a) ? a.filter(Boolean) : [];
    };
    const dbToJob = (d: DbDecision): Job => {
      const ar = (typeof d.progress === 'string' ? (() => { try { return JSON.parse(d.progress); } catch { return {}; } })() : d.progress) || {};
      const results = ar.agent_results || {};
      const assignees = parseAssignees(d);
      return {
        id: hashId(String(d.id)),
        directive: d.title || '',
        at: '',
        expanded: false,
        meetingId: d.meeting_id ? String(d.meeting_id) : undefined,
        members: assignees.map((aid) => {
          const r = results[aid];
          return { id: aid, name: aid, role: 'analysis' as const, status: (r ? (r.status === 'failed' ? 'error' : 'done') : 'pending') as JobMember['status'], reply: r?.response };
        }),
      };
    };
    const load = async () => {
      try {
        const r = await apiFetch('/api/decisions?trigger_source=directive&order=created_at.desc&limit=30');
        const list = await r.json();
        const arr = Array.isArray(list) ? list : (list?.decisions || []);
        const active = arr.filter((d: DbDecision) => d.status === 'in_progress' || d.status === 'pending');
        setDbActiveDirs(active.map(dbToJob));
      } catch { /* noop */ }
    };
    load();
    // 5s 주기 + 숨겨진 탭에선 폴링 생략(백그라운드 부하 제거).
    const iv = setInterval(() => { if (!document.hidden) load(); }, 5000);
    return () => clearInterval(iv);
  }, [view]);


  const addToTeam = (name: string) => {
    setTeam((prev) => (prev.includes(name) ? prev : [...prev, name]));
  };
  const removeFromTeam = (name: string) => setTeam((prev) => prev.filter((n) => n !== name));

  // 홈 TF 지시 = 회의로 처리(회의 로직 통일). 서버 백그라운드 회의 시작 + directive 연결.
  const assignDirective = async () => {
    const title = directive.trim();
    if (!title) return;
    const counselyId = AGENT_BY_NAME[COUNSELY.toLowerCase()]?.id || 'lead';
    const skeptyId = AGENT_BY_NAME['risk']?.id || 'risk';
    // 회의 참석자 = 팀 멤버(종합·검증은 회의 흐름에서 제외)
    let agentIds = team
      .map((n) => AGENT_BY_NAME[n.toLowerCase()]?.id || n.toLowerCase())
      .filter((id) => id !== counselyId && id !== skeptyId);
    // 팀 미구성 → 담당 부서 자동 배치. 1순위 LLM(Counsely)이 안건 분석, 실패 시 키워드(topics.ts) 폴백.
    if (agentIds.length === 0) {
      try {
        const res = await apiFetch('/api/directive/assign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        if (res.ok) {
          const d = await res.json();
          agentIds = (Array.isArray(d?.agents) ? d.agents : [])
            .map((a: { id?: string }) => a?.id)
            .filter((id: unknown): id is string => typeof id === 'string' && id !== counselyId && id !== skeptyId);
        }
      } catch { /* LLM 실패 → 키워드 폴백 */ }
      if (agentIds.length === 0) {
        const topic = detectTopic(title);
        agentIds = (TOPIC_AGENTS[topic] || TOPIC_AGENTS.general || [])
          .filter((id) => id !== counselyId && id !== skeptyId);
      }
    }
    if (agentIds.length === 0) return;
    setDirective('');
    // 낙관적 세션 job 추가 — DB 폴링(5s) 전이라도 "작업 중" 카드·부서 busy dot 즉시 반영.
    // 이후 dbActiveDirs가 같은 title로 들어오면 렌더 단계(작업 중 목록)에서 title 기준 dedup됨.
    setJobs((prev) => {
      const t = title.trim();
      if (prev.some((j) => (j.directive || '').trim() === t)) return prev;
      const optimistic: Job = {
        id: Date.now(),
        directive: title,
        at: '',
        expanded: false,
        members: agentIds.map((aid) => ({ id: aid, name: aid, role: 'analysis' as const, status: 'pending' as const })),
      };
      return [optimistic, ...prev];
    });
    // 1) directive 생성(작업중/대시보드 표시용) — 회의가 발언마다 progress·meeting_id 동기화
    let directiveId: string | undefined;
    try {
      const res = await apiFetch('/api/directives', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: '', assignees: agentIds, priority: 'normal' }),
      });
      if (res.ok) directiveId = (await res.json())?.directive?.id;
    } catch { /* best-effort */ }
    // 2) 회의 시작(서버 백그라운드 + meeting_messages) → 회의실 라이브 구독
    try {
      const res = await apiFetch('/api/meeting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'start', agenda: title, agents: agentIds, directiveId }),
      });
      const d = await res.json();
      if (d?.meetingId) {
        setMeetingFrom(null);
        setMeetingMeetingId(d.meetingId);
        setMeetingAgenda(title);
        setMeetingMessages(null);
        setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
      }
    } catch { /* noop */ }
  };
  const dismissJob = (id: number) => setJobs((prev) => prev.filter((j) => j.id !== id));
  // 현재 작업 중(분석 진행/대기)인 에이전트 이름 집합 — 부서 그리드에서 강조.
  // 세션 jobs는 setJobs 호출 경로가 없어 항상 비어 있으므로(회귀), DB 폴링 결과
  // dbActiveDirs(in_progress·pending 지시)도 함께 반영해 busy dot이 실제로 켜지게 한다.
  const workingNames = new Set<string>();
  [...jobs, ...dbActiveDirs].forEach((j) => {
    const allDone = j.members.length > 0 && j.members.every((m) => m.status === 'done' || m.status === 'error');
    if (!allDone) j.members.forEach((m) => { if (m.status === 'running' || m.status === 'pending') workingNames.add(m.name.toLowerCase()); });
  });
  const [showDashboard, setShowDashboard] = useState(true);
  const [dashTab, setDashTab] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showMeeting, setShowMeeting] = useState(false);
  const [meetingAgenda, setMeetingAgenda] = useState('');
  const [meetingMessages, setMeetingMessages] = useState<MeetingMessage[] | null>(null);
  const [meetingMeetingId, setMeetingMeetingId] = useState<string | null>(null);
  const [meetingFrom, setMeetingFrom] = useState<'timeline' | null>(null);
  const [meetingMin, setMeetingMin] = useState(false);      // 백그라운드(최소화)
  const [, setMeetingRunning] = useState(false); // 회의 진행 중 여부
  const [meetingMode, setMeetingMode] = useState<'meeting' | 'simulation'>('meeting');
  const fullCloseMeeting = () => { setShowMeeting(false); setMeetingMin(false); setMeetingFrom(null); };

  // 홈에서 끝난 작업의 응답을 회의실 메시지로 변환(LLM 재호출 없이 이어보기)
  const jobToMessages = (j: Job): MeetingMessage[] => {
    const roleLabel = (r: JobMember['role']) => r === 'synth' ? (koOn ? '종합' : 'Synth') : r === 'verify' ? (koOn ? '검증' : 'Verify') : (koOn ? '분석' : 'Analysis');
    const withReply = j.members.filter((m) => m.reply);
    const meta = (m: JobMember) => AGENT_BY_NAME[m.name.toLowerCase()];
    const participants = withReply.map((m) => {
      const a = meta(m);
      return { id: m.id, name: m.name, floor: a ? `${a.floor}F` : '', role: roleLabel(m.role), number: a?.number || '' };
    });
    return [
      { type: 'meeting_start', agenda: j.directive, topic: j.directive, participants },
      ...withReply.map((m) => {
        const a = meta(m);
        return { type: 'message' as const, agentId: m.id, agentName: m.name, number: a?.number || '', floor: a ? `${a.floor}F` : '', role: roleLabel(m.role), message: m.reply };
      }),
    ];
  };

  const openMeeting = (agenda = '', job?: Job) => {
    setMeetingMeetingId(null);
    setMeetingAgenda(agenda);
    setMeetingMessages(job ? jobToMessages(job) : null);
    setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
  };

  // 제목으로 저장된 회의(report_type=meeting) 조회 — 있으면 raw content 반환, 없으면 null
  const findSavedMeeting = async (agenda: string): Promise<string | null> => {
    const key = (agenda || '').trim();
    if (!key) return null;
    try {
      const res = await apiFetch('/api/reports?report_type=eq.meeting&limit=200');
      if (!res.ok) return null;
      const list = (await res.json()) as Array<{ title?: string; content?: string }>;
      const strip = (t = '') => t.replace(/^\[회의\]\s*/, '').trim();
      const hit = list.find((r) => strip(r.title) === key)
        || (key.length >= 6 ? list.find((r) => { const s = strip(r.title); return s.length >= 6 && (s.includes(key) || key.includes(s)); }) : undefined);
      return hit?.content || null;
    } catch { return null; }
  };

  // directive(지시) 결과 → 회의 메시지(정적, LLM 호출 없음)
  const directiveToMessages = (agenda: string, dir: DbDecision): MeetingMessage[] | null => {
    let assignees: unknown = dir?.trigger_data?.assignees;
    if (typeof assignees === 'string') { try { assignees = JSON.parse(assignees); } catch { assignees = []; } }
    const ids: string[] = Array.isArray(assignees) ? assignees.filter(Boolean) : [];
    const prog: { agent_results?: Record<string, DbAgentResult> } = typeof dir?.progress === 'string' ? (() => { try { return JSON.parse(dir.progress as string); } catch { return {}; } })() : (dir?.progress || {});
    const ar = prog.agent_results || {};
    const withReply = ids.filter((id) => ar[id]?.response);
    if (withReply.length === 0) return null;
    const parts = ids.map((id) => ({ id, name: dn(id), role: koOn ? '분석' : 'Analysis', number: '', floor: '' }));
    return [
      { type: 'meeting_start', agenda, topic: agenda, participants: parts },
      { type: 'message', agentId: 'chairman', agentName: koOn ? '사용자' : 'You', number: '00', role: koOn ? '사용자' : 'You', message: agenda },
      ...withReply.map((id) => ({ type: 'message' as const, agentId: id, agentName: dn(id), role: koOn ? '분석' : 'Analysis', number: '', floor: '', message: ar[id]?.response })),
    ];
  };

  // 대시보드에서 회의 클릭 — meetingId 있으면 라이브 복원(구독), 없으면 제목 매칭 →
  // 그래도 없으면 directive 결과를 정적 표시(LLM 재호출 금지). 결과조차 없을 때만 새 회의.
  const openMeetingFromDashboard = async (agenda: string, meetingId?: string, dir?: DbDecision) => {
    setShowDashboard(false); setMeetingFrom(null);
    if (meetingId) {
      setMeetingMeetingId(meetingId);
      setMeetingAgenda(agenda);
      setMeetingMessages(null);
      setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
      return;
    }
    const raw = await findSavedMeeting(agenda);
    if (raw) { openSavedMeeting(raw); return; }
    // 회의 기록 없음(홈 TF 지시 등) — directive 결과를 정적 표시(LLM 호출 안 함)
    const dmsgs = dir ? directiveToMessages(agenda, dir) : null;
    if (dmsgs) {
      setMeetingMeetingId(null);
      setMeetingAgenda(agenda);
      setMeetingMessages(dmsgs);
      setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
      return;
    }
    openMeeting(agenda);
  };

  // 저장된 회의 복원 — LLM 재호출 없이 기존 대화·요약을 그대로 표시
  const openSavedMeeting = (raw: string) => {
    setMeetingMeetingId(null);
    let d: { agenda?: string; summary?: string; conversation?: { speaker: string; message: string }[]; messages?: MeetingMessage[]; participants?: MeetingMessage['participants']; meetingId?: string } | null = null;
    try { d = JSON.parse(raw); } catch { d = null; }
    // meetingId가 저장돼 있으면 라이브 구독으로 복원 — 승인 후 지시 분석이 회의 화면에 실시간 표시됨
    if (d?.meetingId) {
      setMeetingMeetingId(d.meetingId);
      setMeetingAgenda(d.agenda || '');
      setMeetingMessages(null);
      setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
      return;
    }
    let msgs: MeetingMessage[];
    if (d && d.messages?.length) {
      // 최신 포맷 — 저장된 풀 메시지(말풍선 그대로) 사용
      msgs = [
        { type: 'meeting_start', agenda: d.agenda, topic: d.agenda, participants: d.participants || [] },
        ...d.messages.filter((m) => m.type !== 'meeting_start' && m.type !== 'meeting_end'),
      ];
      if (d.summary) msgs.push({ type: 'meeting_end', summary: d.summary });
      setMeetingAgenda(d.agenda || '');
    } else if (d && (d.conversation?.length || d.summary)) {
      // 구포맷(대화+요약 JSON)
      msgs = [
        { type: 'meeting_start', agenda: d.agenda, topic: d.agenda, participants: d.participants || [] },
        ...(d.agenda ? [{ type: 'message' as const, agentId: 'chairman', agentName: '사용자', number: '00', floor: '', role: koOn ? '사용자' : 'You', message: d.agenda }] : []),
        ...(d.conversation || []).map((c) => ({ type: 'message' as const, agentName: c.speaker, message: c.message })),
      ];
      if (d.summary) msgs.push({ type: 'meeting_end', summary: d.summary });
      setMeetingAgenda(d.agenda || '');
    } else {
      // 구버전/평문 — 요약 텍스트만 표시
      msgs = [
        { type: 'meeting_start', participants: [] },
        { type: 'meeting_end', summary: raw },
      ];
      setMeetingAgenda('');
    }
    setMeetingMessages(msgs);
    setMeetingMode('meeting'); setMeetingMin(false); setMeetingRunning(false); setShowMeeting(true);
  };

  // 최초 진입: 셋업 전이면 온보딩, 아니면 곧장 홈(랜딩 화면 제거)
  // localStorage는 SSR에서 못 읽으므로 마운트 effect에서 1회 반영(서버/첫 페인트 일관성).
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView(localStorage.getItem('quorum-setup-complete') ? 'tower' : 'onboarding');
    } catch {
      setView('tower');
    }
  }, []);

  const enterTower = () => {
    try {
      localStorage.setItem('quorum-setup-complete', '1');
    } catch {
      /* noop */
    }
    setView('tower');
  };

  // 모달들이 던지는 화면 전환 이벤트 수신 — 대시보드/에이전트 채팅으로 점프
  useEffect(() => {
    const onNav = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      setView('tower');
      if (d.view === 'dashboard') {
        setDashTab(d.tab ?? null);
        setShowDashboard(true);
      }
    };
    window.addEventListener('quorum-navigate', onNav as EventListener);
    return () => window.removeEventListener('quorum-navigate', onNav as EventListener);
  }, []);

  const tab = (on: boolean): CSSProperties => ({
    padding: '5px 11px', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
    background: on ? C.ink : 'transparent',
    color: on ? '#fff' : C.t(0.5),
  });

  const drawerOpen = view === 'tower' && showDashboard;

  return (
    <div
      className={`quorum-main${drawerOpen ? ' quorum-open' : ''}`}
      style={{ minHeight: '100vh', background: C.bg, color: C.ink, fontFamily: FONT, WebkitFontSmoothing: 'antialiased' } as CSSProperties}
    >
      <style>{ZEN_KEYFRAMES}</style>
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '0 28px' }}>

        {/* Header — z-index를 우측 채팅 드로어(z-50) 위로 올려 버튼이 가려지지 않게 */}
        <div style={{ position: 'relative', zIndex: 60, background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '22px 0', borderBottom: `1px solid ${C.t(0.06)}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* 단일 소스(#4 v8): favicon과 동일 파일 사용 → 인라인 복제/색상 drift 제거 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.svg" width={22} height={22} alt="Quorum" style={{ display: 'block', borderRadius: 5 }} />
            <div style={{ fontWeight: 600, fontSize: 15, letterSpacing: '0.04em' }}>Quorum</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            {view === 'tower' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { setShowDashboard(true); }} style={{ padding: '7px 14px', borderRadius: 12, border: 'none', background: C.ink, color: '#fff', fontFamily: 'inherit', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>{koOn ? '대시보드' : 'Dashboard'}</button>
                <button onClick={() => { setShowTimeline(true); }} style={{ padding: '7px 14px', borderRadius: 12, border: `1px solid ${C.t(0.14)}`, background: 'transparent', color: C.ink, fontFamily: 'inherit', fontWeight: 500, fontSize: 13, cursor: 'pointer' }}>{koOn ? '타임라인' : 'Timeline'}</button>
              </div>
            )}
            <div style={{ display: 'flex', fontSize: 11, border: `1px solid ${C.t(0.14)}`, borderRadius: 999, overflow: 'hidden' }}>
              <button onClick={() => setLang('ko')} style={tab(koOn)}>KO</button>
              <button onClick={() => setLang('en')} style={tab(!koOn)}>EN</button>
            </div>
          </div>
        </div>

        {/* Onboarding */}
        {view === 'onboarding' && (
          <div style={{ maxWidth: 520, margin: '0 auto', padding: '80px 0 64px' }}>
            <div style={{ fontWeight: 600, fontSize: 32, lineHeight: 1.25, letterSpacing: '-0.01em' }}>{t.obTitle}</div>
            <div style={{ fontSize: 15, lineHeight: 1.75, color: C.t(0.72), marginTop: 14, textWrap: 'pretty' } as CSSProperties}>{t.obSub}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 36 }}>
              <button onClick={enterTower} style={{ padding: '15px 30px', borderRadius: 18, border: 'none', fontFamily: 'inherit', fontWeight: 500, fontSize: 15, background: C.ink, color: '#fff', cursor: 'pointer', boxShadow: `0 12px 40px ${C.t(0.10)}` }}>{t.next} →</button>
            </div>
          </div>
        )}

        {/* Home */}
        {view === 'tower' && (
          <div style={{ padding: '24px 0 88px' }}>

            {/* 작업 중 — 세션 작업 + DB 진행중·미결재 지시(무조건 표시) */}
            {(() => {
              const jobTitles = new Set(jobs.map((j) => (j.directive || '').trim()));
              const visibleJobs = [...jobs, ...dbActiveDirs.filter((d) => !jobTitles.has((d.directive || '').trim()))];
              return (
            <div style={{ marginBottom: 22, borderRadius: 18, border: `1px solid ${C.t(0.08)}`, background: C.t(0.02), padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: visibleJobs.length > 0 ? 12 : 0 }}>
                  <span className="quorum-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: visibleJobs.length > 0 ? C.working : C.t(0.25), ...(visibleJobs.length > 0 ? { animation: 'pulseRing 2.4s ease-out infinite' } : {}) }} />
                  <span style={{ fontWeight: 600, fontSize: 13, color: C.ink }}>{koOn ? '작업 중' : 'In progress'}</span>
                  <span style={{ fontSize: 11, color: C.t(0.45) }}>{visibleJobs.length}</span>
                </div>
                {visibleJobs.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: C.t(0.4), padding: '8px 2px 2px' }}>{koOn ? '진행 중인 작업이 없습니다. 아래에서 팀을 꾸리고 지시를 내려보세요.' : 'No active work. Build a team below and assign a directive.'}</div>
                ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {visibleJobs.map((j) => {
                    const total = j.members.length;
                    const doneN = j.members.filter((m) => m.status === 'done' || m.status === 'error').length;
                    const pct = total ? Math.round((doneN / total) * 100) : 0;
                    const allDone = doneN >= total;
                    return (
                    <div key={j.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 12px', borderRadius: 12, background: C.bg, border: `1px solid ${C.t(0.06)}` }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: C.ink }}>{j.directive}</span>
                          <span style={{ fontSize: 10, fontWeight: 600, color: allDone ? C.done : C.working, padding: '1px 7px', borderRadius: 999, background: allDone ? `${C.done}1a` : `${C.working}1a` }}>{allDone ? (koOn ? '완료' : 'Done') : (koOn ? '진행 중' : 'Working')} {doneN}/{total}</span>
                          <span style={{ fontSize: 10, color: C.t(0.4) }}>{j.at}</span>
                        </div>
                        {/* 진행 바 */}
                        <div style={{ height: 5, borderRadius: 999, background: C.t(0.08), overflow: 'hidden', marginBottom: 8 }}>
                          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 999, background: allDone ? C.done : C.working, transition: 'width .5s ease' }} />
                        </div>
                        {/* 멤버 상태 */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                          {j.members.map((m, mi) => {
                            const special = m.role !== 'analysis';
                            const roleLabel = m.role === 'synth' ? (koOn ? ' · 종합' : ' · Synth') : m.role === 'verify' ? (koOn ? ' · 검증' : ' · Verify') : '';
                            const dot = m.status === 'done' ? C.done : m.status === 'error' ? '#c0392b' : m.status === 'running' ? C.working : C.t(0.25);
                            return (
                              <span key={m.id + mi} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 500, padding: '2px 8px 2px 3px', borderRadius: 999, color: special ? '#fff' : C.t(0.75), background: special ? C.ink : C.paper(0.95), border: special ? 'none' : `1px solid ${C.t(0.08)}` }}>
                                <span style={{ width: 14, height: 14, borderRadius: '50%', background: dot, display: 'flex', alignItems: 'center', justifyContent: 'center', ...(m.status === 'running' ? { animation: 'pulseRing 2s ease-out infinite' } : {}) }}>
                                  {m.status === 'done' && <span style={{ color: '#fff', fontSize: 8 }}>✓</span>}
                                </span>
                                {dn(m.name)}{roleLabel}
                              </span>
                            );
                          })}
                          {(j.members.some((m) => m.reply) || j.meetingId) && (
                            <span style={{ marginLeft: 'auto', display: 'flex', gap: 12 }}>
                              <button onClick={() => { setMeetingFrom(null); if (j.meetingId) { void openMeetingFromDashboard(j.directive, j.meetingId); } else { openMeeting(j.directive, j); } }} style={{ border: 'none', background: 'transparent', color: C.accent, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>{koOn ? '회의실에서 이어가기' : 'Open in Meeting'}</button>
                            </span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => dismissJob(j.id)} style={{ border: 'none', background: 'transparent', color: C.t(0.35), cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2, flexShrink: 0 }}>×</button>
                    </div>
                    );
                  })}
                </div>
                )}
              </div>
              );
            })()}

            {/* 부서 그리드 (전체 폭) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
              {DEPARTMENTS.map((dept) => (
                  <div key={dept.f} style={{ borderRadius: 18, border: `1px solid ${C.t(0.06)}`, background: C.bg, padding: '14px 16px', boxShadow: `0 4px 16px ${C.t(0.04)}` }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: C.accent, marginBottom: 12 }}>{koOn ? dept.ko : dept.en}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {dept.agents.map((name) => {
                        const busy = workingNames.has(name.toLowerCase());
                        return (
                        <span
                          key={name}
                          draggable
                          onDragStart={(e) => e.dataTransfer.setData('text/plain', name)}
                          title={busy ? (koOn ? '작업 중' : 'Working') : undefined}
                          style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 11, padding: '3px 9px 3px 3px', borderRadius: 999, color: busy ? C.working : C.t(0.72), background: busy ? `${C.working}14` : C.paper(0.92), border: `1px solid ${busy ? `${C.working}55` : C.t(0.05)}`, cursor: 'grab' }}
                        >
                          <span style={{ position: 'relative', width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 9, color: '#fff', background: busy ? C.working : C.ink, flexShrink: 0 }}>
                            {dn(name)[0]}
                            {busy && <span className="quorum-dot" style={{ position: 'absolute', top: -1, right: -1, width: 7, height: 7, borderRadius: '50%', background: C.working, border: `1.5px solid ${C.bg}`, animation: 'pulseRing 2s ease-out infinite' }} />}
                          </span>{dn(name)}
                        </span>
                        );
                      })}
                    </div>
                  </div>
              ))}
            </div>

            {/* 팀 빌더 — 하단 가로 바 */}
            <div style={{ borderRadius: 18, border: `1px solid ${C.t(0.08)}`, background: C.bg, padding: '16px 18px', marginTop: 24, boxShadow: `0 4px 16px ${C.t(0.04)}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: C.ink, flexShrink: 0 }}>{koOn ? 'TF 구성' : 'Task Force'}</div>
                <div style={{ fontSize: 11, color: C.t(0.45), textAlign: 'right' }}>{koOn ? '부서에서 에이전트를 팀으로 드래그해 팀을 꾸리고, 지시를 내려보세요. 클릭하면 대화할 수 있어요.' : 'Drag agents into the team, then assign a directive. Click an agent to chat.'}</div>
              </div>

              {/* 드롭 박스 — 여기에 넣으면 된다 */}
              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); const n = e.dataTransfer.getData('text/plain'); if (n) addToTeam(n); }}
                style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 64, padding: 14, borderRadius: 14, border: `1.5px dashed ${C.t(0.2)}`, background: C.t(0.02) }}
              >
                {/* Counsely 종합 고정 */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px 5px 5px', borderRadius: 999, background: C.ink }}>
                  <span style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 9, color: '#fff', background: C.accent }}>{dn(COUNSELY)[0]}</span>
                  <span style={{ fontSize: 11, fontWeight: 500, color: '#fff' }}>{dn(COUNSELY)}</span>
                  <span style={{ fontSize: 9, color: C.paper(0.5) }}>{koOn ? '종합' : 'Synth'}</span>
                </span>
                {/* 팀 멤버 */}
                {team.length === 0 ? (
                  <span style={{ fontSize: 12.5, color: C.t(0.4), marginLeft: 4 }}>{koOn ? '부서에서 끌어다 놓거나, 안건만 입력하면 자동 배치됩니다' : 'Drag agents here, or just enter an agenda for auto-assignment'}</span>
                ) : team.map((name) => (
                  <span key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, fontSize: 11, padding: '4px 6px 4px 4px', borderRadius: 999, color: C.t(0.78), background: C.paper(0.95), border: `1px solid ${C.t(0.08)}` }}>
                    <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 8, color: '#fff', background: C.ink }}>{dn(name)[0]}</span>{dn(name)}
                    <button onClick={() => removeFromTeam(name)} style={{ border: 'none', background: 'transparent', color: C.t(0.4), cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
              </div>

              {/* 지시 입력 — 하단 전체폭 */}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input
                  value={directive}
                  onChange={(e) => setDirective(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) assignDirective(); }}
                  placeholder={koOn ? '이 팀에 내릴 지시를 입력하세요…' : 'Enter a directive for this team…'}
                  style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', padding: '12px 14px', fontSize: 13, fontFamily: 'inherit', color: C.ink, background: C.bg, border: `1px solid ${C.t(0.12)}`, borderRadius: 12, outline: 'none' }}
                />
                <button
                  onClick={assignDirective}
                  disabled={!directive.trim()}
                  style={{ flexShrink: 0, padding: '12px 22px', borderRadius: 12, border: 'none', background: C.ink, color: '#fff', fontFamily: 'inherit', fontWeight: 500, fontSize: 13, cursor: !directive.trim() ? 'default' : 'pointer', opacity: !directive.trim() ? 0.4 : 1 }}
                >
                  {koOn ? '보내기' : 'Send'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 사용자 대시보드 — 우측 도킹 패널 */}
      {view === 'tower' && (
        <ChairmanDashboard
          open={showDashboard}
          onClose={() => setShowDashboard(false)}
          initialTab={dashTab}
          onOpenMeeting={(agenda, meetingId, dir) => { void openMeetingFromDashboard(agenda, meetingId, dir); }}
          onOpenReports={() => { setShowDashboard(false); setShowTimeline(true); }}
        />
      )}

      {/* 의사결정 타임라인 / 흐름 */}
      {view === 'tower' && (
        <TimelineView open={showTimeline} onClose={() => setShowTimeline(false)} lang={lang} onOpenAgenda={(title) => { setShowTimeline(false); setMeetingFrom('timeline'); openMeeting(title); }} onOpenMeeting={(raw) => { setShowTimeline(false); setMeetingFrom('timeline'); openSavedMeeting(raw); }} />
      )}

      {/* 회의실 — 백그라운드 진행 위해 실행 중엔 언마운트하지 않고 숨김 처리 */}
      {view === 'tower' && showMeeting && (
        <MeetingRoom
          key={meetingMode + ':' + meetingAgenda + (meetingMessages ? ':carry' : '') + (meetingMeetingId ? ':' + meetingMeetingId : '')}
          initialAgenda={meetingAgenda}
          initialMessages={meetingMessages ?? undefined}
          initialMeetingId={meetingMeetingId ?? undefined}
          initialMode={meetingMode}
          hidden={meetingMin}
          onMeetingActive={(active) => setMeetingRunning(active)}
          onClose={() => { fullCloseMeeting(); setShowDashboard(true); }}
          onBack={() => { fullCloseMeeting(); if (meetingFrom === 'timeline') setShowTimeline(true); else setShowDashboard(true); }}
          lang={lang}
        />
      )}

    </div>
  );
}

export default function Home() {
  return (
    <ErrorBoundary>
      <LangProvider>
        <AgentRegistryProvider>
          <ReportProvider>
            <HomeContent />
          </ReportProvider>
        </AgentRegistryProvider>
      </LangProvider>
    </ErrorBoundary>
  );
}
