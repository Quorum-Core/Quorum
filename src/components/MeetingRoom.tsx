'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Building2, BarChart3, Wrench, AlertTriangle, Coins, Rocket, Users, Lock, FileText, Briefcase, Target, RefreshCw, Zap, CheckCircle2, XCircle, Circle, ClipboardList, MessageSquare, Mic, UserCheck, X, ArrowLeft } from 'lucide-react';
import { Lang } from '@/data/i18n';
import { localizeAgentNames, RenderMarkdown } from '@/lib/format-markdown';
import { displayName } from '@/data/agent-names';
import { floors as floorData } from '@/data/floors';
import { subscribeMeeting, loadMeetingMessages, loadMeetingStatus, type MeetingMsgRow } from '@/lib/meeting-realtime';
import { getSpeechRecognition, type SpeechRecognitionLike } from '@/lib/speech';
import { ReactNode } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { downloadFilenameFromContentDisposition } from '@/lib/content-disposition';

// 회의 참석자 추가용 전체 에이전트 로스터
const ALL_AGENTS = floorData.flatMap((f) => f.agents);

export type VoteTally = {
  weights: { for: number; against: number; conditional: number; abstain: number };
  total: number;
  winner: 'for' | 'against' | 'conditional' | 'abstain';
  winnerShare: number;
  quorum: boolean;
};

export interface MeetingMessage {
  type: 'meeting_start' | 'typing' | 'message' | 'summarizing' | 'meeting_end' | 'vote';
  tally?: VoteTally;
  agentId?: string;
  agentName?: string;
  number?: string;
  floor?: string;
  role?: string;
  message?: string;
  topic?: string;
  agenda?: string;
  participants?: Array<{ id: string; name?: string; floor?: string; role?: string; number?: string }>;
  summary?: string;
  conversation?: Array<{ speaker: string; message: string }>;
  _seq?: number; // 라이브 구독 정렬용(서버 meeting_messages.seq)
}

// Scenario types and icons
const SCENARIO_ICONS: Record<string, ReactNode> = {
  market: <BarChart3 className="w-3.5 h-3.5 inline" />,
  product: <Wrench className="w-3.5 h-3.5 inline" />,
  crisis: <AlertTriangle className="w-3.5 h-3.5 inline" />,
  investment: <Coins className="w-3.5 h-3.5 inline" />,
  launch: <Rocket className="w-3.5 h-3.5 inline" />,
  hiring: <Users className="w-3.5 h-3.5 inline" />,
  security: <Lock className="w-3.5 h-3.5 inline" />,
  content: <FileText className="w-3.5 h-3.5 inline" />,
  general: <Briefcase className="w-3.5 h-3.5 inline" />,
};

const SCENARIO_TYPE_LABELS: Record<string, { ko: string; en: string }> = {
  market: { ko: '시장/경쟁', en: 'Market' },
  product: { ko: '제품/개발', en: 'Product' },
  crisis: { ko: '위기 대응', en: 'Crisis' },
  investment: { ko: '투자', en: 'Investment' },
  launch: { ko: '런칭/마케팅', en: 'Launch' },
  hiring: { ko: '채용/인사', en: 'Hiring' },
  security: { ko: '보안', en: 'Security' },
  content: { ko: '콘텐츠', en: 'Content' },
  general: { ko: '일반', en: 'General' },
};

// Simulation scenarios with agent selection
const SIMULATION_SCENARIOS = [
  {
    type: 'crisis',
    title: { ko: 'Market Crisis', en: 'Market Crisis' },
    description: { ko: '주요 경쟁사가 50% 가격 인하를 단행했습니다', en: 'A major competitor has slashed prices by 50%' },
    scenario: 'A major competitor has suddenly slashed their prices by 50% across all product lines, creating significant market pressure and customer price sensitivity.',
    agents: ['risk', 'quant', 'global', 'hedge', 'trading', 'strategy']
  },
  {
    type: 'launch',
    title: { ko: 'Product Launch', en: 'Product Launch' },
    description: { ko: '신제품 출시 준비 및 마케팅 전략 수립', en: 'New product launch preparation and marketing strategy' },
    scenario: 'We are preparing to launch a revolutionary AI-powered analytics platform. Need comprehensive go-to-market strategy and risk mitigation plans.',
    agents: ['pr', 'copy', 'sales', 'growth', 'research', 'strategy']
  },
  {
    type: 'security',
    title: { ko: 'Security Breach', en: 'Security Breach' },
    description: { ko: '잠재적 보안 취약점 발견 및 대응 방안', en: 'Potential security vulnerability discovered' },
    scenario: 'Our security team has detected unusual network activity suggesting a potential data breach attempt. Immediate response required.',
    agents: ['security', 'infra', 'monitoring', 'audit', 'legal']
  },
  {
    type: 'investment',
    title: { ko: 'Investment Decision', en: 'Investment Decision' },
    description: { ko: '시리즈 A 투자 유치 검토', en: 'Series A funding consideration' },
    scenario: 'Multiple VCs have shown interest in leading our Series A round. Need to evaluate terms, timing, and strategic implications.',
    agents: ['quant', 'valuation', 'field', 'hedge', 'finance', 'risk']
  },
  {
    type: 'hiring',
    title: { ko: 'Hiring Surge', en: 'Hiring Surge' },
    description: { ko: '급속한 조직 확장을 위한 대량 채용', en: 'Rapid organizational expansion plan' },
    scenario: 'Board has approved aggressive hiring plan to scale from 30 to 100 employees in 6 months. Need strategic hiring and retention framework.',
    agents: ['recruiting', 'evaluation', 'strategy', 'finance', 'legal']
  },
  {
    type: 'market',
    title: { ko: 'Competitor Response', en: 'Competitor Response' },
    description: { ko: '경쟁사의 새로운 기능 발표에 대한 대응', en: 'Response to competitor\'s new feature announcement' },
    scenario: 'Key competitor just announced a breakthrough feature that directly challenges our core value proposition. Strategic response needed.',
    agents: ['research', 'quant', 'global', 'risk', 'growth', 'strategy']
  }
];

interface AgentResponse {
  agentId: string;
  agentName: string;
  floor: string;
  role: string;
  response: string;
}

interface SimulationResult {
  scenario: string;
  type: string;
  agentCount: number;
  responses: AgentResponse[];
  summary: string;
}

interface Props {
  onClose: () => void;
  lang: Lang;
  initialAgenda?: string;
  initialMessages?: MeetingMessage[];
  initialMeetingId?: string; // 진행 중 회의 라이브 재진입 — 해당 meetingId 구독
  onMeetingActive?: (active: boolean, floors?: number[]) => void;
  onReportSave?: (report: {
    title: string; department: string; floor: number;
    type: string; priority: 'high' | 'medium' | 'low';
    summary: string; content: string; actions?: string[];
  }) => void;
  onBack?: () => void;
  hidden?: boolean; // 백그라운드 진행 — 마운트 유지하되 화면에서 숨김(루프 계속)
  initialMode?: 'meeting' | 'simulation';
}

export function MeetingRoom({ onClose, lang, initialAgenda, initialMessages, initialMeetingId, onMeetingActive, onReportSave, onBack, hidden, initialMode = 'meeting' }: Props) {
  const [agenda, setAgenda] = useState(initialAgenda || '');
  const [messages, setMessages] = useState<MeetingMessage[]>(initialMessages || []);
  const messagesRef = useRef<MeetingMessage[]>(initialMessages || []);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [isRunning, setIsRunning] = useState(false);
  const [attaching, setAttaching] = useState(!!initialMeetingId); // 재진입 로드 중 — 소집 화면 깜빡임 방지
  const [typingAgent, setTypingAgent] = useState<string | null>(null);
  const [chairmanInput, setChairmanInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // 저장된 회의(initialMessages) 복원 시 종료 상태·요약을 첫 렌더에 바로 반영(마운트 effect 불필요).
  const [meetingEnded, setMeetingEnded] = useState(() => initialMessages?.some((m) => m.type === 'meeting_end') ?? false);
  const [summary, setSummary] = useState(() => initialMessages?.find((m) => m.type === 'meeting_end')?.summary || '');
  const [meetingError, setMeetingError] = useState(false); // 서버 회의가 error 상태(재시도 소진) — 사용자에게 표시
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Simulation mode state
  const [mode, setMode] = useState<'meeting' | 'simulation'>(initialMode);
  const [simulationResult, setSimulationResult] = useState<SimulationResult | null>(null);
  const [visibleResponses, setVisibleResponses] = useState(0);
  const [showSummary, setShowSummary] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<'approved' | 'rejected' | 'completed' | null>(null);
  const [extraDirective, setExtraDirective] = useState('');
  const [downloading, setDownloading] = useState<'docx' | 'md' | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, typingAgent]);

  // 저장된 회의 복원 시 발언을 위에서부터 보이게 상단 스크롤(종료 상태·요약은 위 useState에서 초기화됨)
  useEffect(() => {
    if (initialMessages?.length) setTimeout(() => scrollRef.current?.scrollTo({ top: 0 }), 60);
    // 최초 마운트 1회만 스크롤 — initialMessages 변화에 재실행 의도 없음.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 언마운트 시 구독·폴링만 해제 — 회의는 서버에서 계속 진행(백그라운드).
  useEffect(() => () => { unsubRef.current?.(); if (pollRef.current) clearInterval(pollRef.current); }, []);

  // 진행 중에는 '발언 중' 인디케이터 표시(서버 주도라 다음 발언자는 미상)
  useEffect(() => {
    if (mode !== 'meeting') return;
    // 서버 status 핸들러(attachMeeting)도 typingAgent를 제어 → 렌더 파생값으로 못 바꿈. effect 유지.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTypingAgent(isRunning && !meetingEnded ? (lang === 'ko' ? '에이전트 발언 중...' : 'Agents speaking...') : null);
  }, [isRunning, meetingEnded, mode, lang]);

  // 모달 보일 때만 배경(홈) 스크롤 잠금 — 백그라운드(hidden) 진행 시엔 해제
  useEffect(() => {
    if (hidden) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [hidden]);

  // Simulate response animation for simulation mode
  useEffect(() => {
    if (!simulationResult) return;
    if (visibleResponses < simulationResult.responses.length) {
      const timer = setTimeout(() => {
        setVisibleResponses((v) => v + 1);
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      }, 600);
      return () => clearTimeout(timer);
    } else if (visibleResponses === simulationResult.responses.length && !showSummary) {
      const timer = setTimeout(() => {
        setShowSummary(true);
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });

        // Auto-save simulation result as a report
        if (onReportSave && simulationResult.summary) {
          const typeLabel = SCENARIO_TYPE_LABELS[simulationResult.type] || SCENARIO_TYPE_LABELS.general;
          const priority: 'high' | 'medium' | 'low' =
            simulationResult.type === 'crisis' || simulationResult.type === 'security' ? 'high' :
            simulationResult.type === 'investment' || simulationResult.type === 'market' ? 'medium' : 'low';

          onReportSave({
            title: simulationResult.scenario,
            department: lang === 'ko' ? typeLabel.ko : typeLabel.en,
            floor: 10,
            type: 'simulation',
            priority,
            summary: simulationResult.summary.slice(0, 200) + (simulationResult.summary.length > 200 ? '...' : ''),
            content: simulationResult.responses.map(r => `**${r.agentName}**\n${r.response}`).join('\n\n') + '\n\n---\n\n' + simulationResult.summary,
            actions: simulationResult.summary.match(/[•\-]\s*(.+)/g)?.map(s => s.replace(/^[•\-]\s*/, '')) || undefined,
          });
        }
      }, 800);
      return () => clearTimeout(timer);
    }
  }, [simulationResult, visibleResponses, showSummary, onReportSave, lang]);

  // 백그라운드 회의 — 서버가 진행, 클라는 meeting_messages를 Realtime 구독 + 폴링으로 표시.
  const meetingIdRef = useRef<string | null>(null);
  const unsubRef = useRef<null | (() => void)>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastRtRef = useRef(0); // 마지막 Realtime 발언 수신 시각 — 적응형 폴링용

  const rowToMsg = useCallback((r: MeetingMsgRow): MeetingMessage => {
    if (r.type === 'meeting_start') return { type: 'meeting_start', agenda, participants: (r.payload?.participants as MeetingMessage['participants']) || [] };
    if (r.type === 'meeting_end') return { type: 'meeting_end', summary: r.summary || '' };
    if (r.type === 'vote') return { type: 'vote', tally: (r.payload as { tally?: VoteTally })?.tally, message: r.message };
    return { type: 'message', agentId: r.agent_id, agentName: r.agent_name, number: r.number, floor: r.floor, role: r.role, message: r.message };
  }, [agenda]);

  // seq dedup + seq 정렬 삽입(구독이 SELECT보다 먼저 도착해도 순서 보장)
  const applyRow = useCallback((r: MeetingMsgRow) => {
    if (r.type === 'meeting_end') setSummary(r.summary || '');
    setMessages(prev => {
      // seq 기준 upsert — 스트리밍 UPDATE면 같은 seq 메시지 텍스트 갱신, 신규면 추가
      const idx = prev.findIndex(m => m._seq === r.seq);
      const msg = { ...rowToMsg(r), _seq: r.seq };
      if (idx >= 0) {
        // 내용 동일하면(폴링 재적용 등) 갱신 생략 — 불필요한 리렌더 방지
        const cur = prev[idx];
        if (cur.message === msg.message && cur.summary === msg.summary && cur.type === msg.type) return prev;
        const next = [...prev];
        next[idx] = msg;
        return next;
      }
      const next = [...prev, msg];
      next.sort((a, b) => (a._seq ?? -1) - (b._seq ?? -1));
      return next;
    });
  }, [rowToMsg]);

  // 구독 먼저 → 초기 SELECT(구독 전 INSERT 누락 방지; dedup이 중복 처리). 최초/재진입 공통.
  const attachMeeting = useCallback(async (meetingId: string) => {
    setAttaching(true);
    meetingIdRef.current = meetingId;
    unsubRef.current?.();
    // eslint-disable-next-line react-hooks/immutability
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    setMessages([]);
    setMeetingError(false);
    const stopPoll = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
    // 서버는 매 발언마다 meetings를 UPDATE(next_index) → running 이벤트 빈발. summary는 건드리지 않음(깜빡임 방지).
    const handleStatus = (s: { status?: string; summary?: string }) => {
      if (s.status === 'done') { setIsRunning(false); setMeetingEnded(true); if (s.summary) setSummary(s.summary); setTypingAgent(null); onMeetingActive?.(false); stopPoll(); }
      else if (s.status === 'error') { setIsRunning(false); setMeetingError(true); setTypingAgent(null); onMeetingActive?.(false); stopPoll(); }
      else if (s.status === 'running') { setIsRunning(true); setMeetingEnded(false); setMeetingError(false); }
      // 'finalizing' → 진행중 유지
    };
    // 1) 구독 먼저 확립 — 이후 INSERT는 빠짐없이 수신. ref.current 갱신은 구독 정리용 표준 패턴.
    // 발언 수신 시각 기록 → 폴링이 Realtime 정상일 땐 스스로 비켜남(중복 쿼리 제거).
    const onRtMessage = (r: MeetingMsgRow) => { lastRtRef.current = Date.now(); applyRow(r); };
    // eslint-disable-next-line react-hooks/immutability
    unsubRef.current = subscribeMeeting(meetingId, onRtMessage, handleStatus);
    // 2) 현재 상태·기존 발언 SELECT로 메움(구독과 겹쳐도 seq dedup)
    let initiallyEnded = false;
    try {
      const [status, rows] = await Promise.all([loadMeetingStatus(meetingId), loadMeetingMessages(meetingId)]);
      rows.forEach(applyRow);
      const end = rows.find(r => r.type === 'meeting_end');
      if (end) setSummary(end.summary || '');
      // 구독은 변경분만 받으므로 현재 status로 초기 isRunning/ended 확정
      if (status?.status === 'done') { setIsRunning(false); setMeetingEnded(true); if (status.summary) setSummary(status.summary); initiallyEnded = true; }
      else if (status?.status === 'error') { setIsRunning(false); setMeetingError(true); initiallyEnded = true; }
      else if (status?.status === 'running' || status?.status === 'finalizing') { setIsRunning(true); setMeetingEnded(false); }
      else if (end) { setIsRunning(false); setMeetingEnded(true); initiallyEnded = true; }  // status 미상(null) → 메시지로 추정
    } finally {
      setAttaching(false);
    }
    // 3) 적응형 폴링 fallback — Realtime UPDATE 누락/미설정에도 저장된 발언을 따라잡음(완료 시 중단).
    //    최근 3s 내 Realtime 발언을 받았으면 폴링 생략 → Realtime 정상 시 중복 쿼리 0.
    if (!initiallyEnded) {
      pollRef.current = setInterval(() => {
        if (meetingIdRef.current !== meetingId) { stopPoll(); return; }
        if (document.hidden) return; // 숨겨진 탭 — 폴링 생략(복귀 시 따라잡음)
        if (Date.now() - lastRtRef.current < 3000) return; // Realtime 수신 중 — 폴링 비켜남
        void (async () => {
          try {
            const [st, rows2] = await Promise.all([loadMeetingStatus(meetingId), loadMeetingMessages(meetingId)]);
            rows2.forEach(applyRow);
            if (st) handleStatus(st);
          } catch { /* noop */ }
        })();
      }, 1500);
    }
  }, [applyRow, onMeetingActive]);

  const startMeeting = useCallback(async (meetingAgenda: string) => {
    if (!meetingAgenda.trim()) return;
    setIsRunning(true); setMeetingEnded(false); setSummary(''); setMeetingError(false);
    try {
      const res = await apiFetch('/api/meeting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'start', agenda: meetingAgenda }),
      });
      const d = await res.json();
      if (!res.ok || !d.meetingId) { setIsRunning(false); console.error('start failed:', d); return; }
      if (onMeetingActive) {
        const floors = [...new Set((d.participants || []).map((p: { floor?: string }) => parseInt(p.floor || '')).filter((f: number) => f > 0))] as number[];
        onMeetingActive(true, floors);
      }
      await attachMeeting(d.meetingId);
    } catch (err) {
      setIsRunning(false);
      console.error('Meeting start error:', err);
    }
  }, [attachMeeting, onMeetingActive]);

  // 최초 마운트: 진행 중 회의면 라이브 재진입(구독·복원), 아니면 새 회의 시작.
  // attachMeeting/startMeeting 정의 뒤에 위치 — effect는 렌더 후 실행되므로 순서 무관.
  // 두 함수는 회의 로딩 상태를 setState하는 게 정상 동작(마운트 1회 초기화).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (initialMeetingId) { void attachMeeting(initialMeetingId); return; }
    if (initialAgenda && !initialMessages && !isRunning && messages.length === 0) {
      startMeeting(initialAgenda);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialAgenda, initialMeetingId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const runSimulation = useCallback(async (scenario: string, scenarioType?: string) => {
    if (!scenario.trim() || isRunning) return;
    
    setIsRunning(true);
    setSimulationResult(null);
    setVisibleResponses(0);
    setShowSummary(false);
    setMode('simulation');

    try {
      const res = await apiFetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: scenario.trim(), type: scenarioType, lang }),
      });

      if (!res.ok) throw new Error('Simulation failed');
      const data: SimulationResult = await res.json();
      setSimulationResult(data);
    } catch {
      setSimulationResult(null);
    } finally {
      setIsRunning(false);
    }
  }, [lang, isRunning]);

  const selectScenario = useCallback((scenarioData: typeof SIMULATION_SCENARIOS[0]) => {
    setAgenda(scenarioData.scenario);
    setSelectedScenario(scenarioData.type);
    setMode('simulation');
  }, []);

  const resetToMeeting = useCallback(() => {
    setMode('meeting');
    setSimulationResult(null);
    setVisibleResponses(0);
    setShowSummary(false);
    setSelectedScenario(null);
    setMessages([]);
    setMeetingEnded(false);
    setSummary('');
    setAgenda('');
    setVerdict(null);
    setExtraDirective('');
  }, []);

  // 승인/거절 결재 — 회의 결정을 기록(추가 지시 사항 첨부)
  // 회의록 다운로드 — docgen API로 회의 발언을 DOCX/Markdown 문서로 생성.
  const downloadMinutes = useCallback(async (format: 'docx' | 'md') => {
    const meetingId = meetingIdRef.current;
    if (!meetingId || downloading) return;
    setDownloading(format);
    try {
      const res = await apiFetch('/api/documents/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meetingId, format }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(lang === 'ko' ? `회의록 생성 실패: ${d?.error || res.status}` : `Failed to generate minutes: ${d?.error || res.status}`);
        return;
      }
      const blob = await res.blob();
      const fname = downloadFilenameFromContentDisposition(
        res.headers.get('Content-Disposition'),
        `meeting_minutes.${format}`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(lang === 'ko' ? `회의록 다운로드 오류: ${String(e)}` : `Download error: ${String(e)}`);
    } finally {
      setDownloading(null);
    }
  }, [downloading, lang]);

  const submitVerdict = useCallback(async (decision: 'approved' | 'rejected' | 'completed') => {
    if (verdict) return;
    setVerdict(decision);
    try {
      const startMsg = messagesRef.current.find((m) => m.type === 'meeting_start');
      const firstMsg = messagesRef.current.find((m) => m.type === 'message');
      const title = (agenda || startMsg?.agenda || startMsg?.topic || firstMsg?.message || (lang === 'ko' ? '회의 결정' : 'Meeting decision')).slice(0, 80);
      const directiveNote = extraDirective.trim();
      const desc = directiveNote ? `${summary}\n\n[${lang === 'ko' ? '추가 지시 사항' : 'Additional instructions'}]\n${directiveNote}` : summary;

      // 승인 → 회의 결과를 지시(directive)로 전환하고 참석 에이전트 실행
      if (decision === 'approved') {
        const assignees = (startMsg?.participants || [])
          .map((p) => (p as { id?: string }).id)
          .filter((id): id is string => Boolean(id));
        if (assignees.length === 0) {
          setVerdict(null);
          alert(lang === 'ko' ? '참석 에이전트가 없어 실행할 수 없습니다.' : 'No participating agents to execute.');
          return;
        }
        const dRes = await apiFetch('/api/directives', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, description: desc, assignees, priority: 'high', meetingId: meetingIdRef.current }),
        });
        if (!dRes.ok) {
          setVerdict(null);
          const detail = await dRes.json().catch(() => ({}));
          alert(lang === 'ko' ? `지시 생성 실패: ${detail?.error || dRes.status}` : `Failed to create directive: ${detail?.error || dRes.status}`);
          return;
        }
        const { directive } = await dRes.json();
        const mid = meetingIdRef.current;
        if (mid) {
          // 회의 화면 그대로 — 각 에이전트의 지시 분석을 회의 발언으로 이어붙임(구독이 실시간 표시)
          setMeetingEnded(false); setSummary(''); setIsRunning(true);
          setMessages(prev => prev.filter(m => m.type !== 'meeting_end'));
          apiFetch('/api/meeting', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'execute', meetingId: mid, directiveId: directive.id, title, description: desc, agents: assignees }),
          }).catch(() => {});
          // 회의실 유지(닫지 않음) — verdict='approved'로 결재 UI는 잠금
        } else {
          // meetingId 없으면(구버전) 기존 백그라운드 execute + 대시보드 이동
          apiFetch('/api/directive/execute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ directiveId: directive.id }),
          }).catch(() => {});
          onMeetingActive?.(false); onClose();
          setTimeout(() => window.dispatchEvent(new CustomEvent('quorum-navigate', { detail: { view: 'dashboard', tab: 'active' } })), 300);
        }
        return;
      }

      // 거절/완료 → 추가 실행 없이 결재 기록(status=decision) fire-and-forget + 즉시 회의실 닫기
      apiFetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description: summary.slice(0, 500), type: 'meeting', status: decision, trigger_source: 'meeting', final_decision: desc }),
      }).catch(() => {});
      onMeetingActive?.(false);
      onClose();
      return;
    } catch (e) {
      setVerdict(null);
      alert(lang === 'ko' ? `처리 실패: ${String(e).slice(0, 120)}` : `Failed: ${String(e).slice(0, 120)}`);
      return;
    }
  }, [verdict, agenda, summary, extraDirective, lang, onMeetingActive, onClose]);

  const toggleSTT = () => {
    const SR = getSpeechRecognition();
    if (!SR) { alert(lang === 'ko' ? '음성인식 미지원 브라우저' : 'Speech recognition not supported'); return; }
    if (isListening && recognitionRef.current) {
      recognitionRef.current.stop();
      setIsListening(false);
      return;
    }
    const recognition = new SR();
    recognition.lang = lang === 'ko' ? 'ko-KR' : 'en-US';
    recognition.interimResults = true;
    recognition.continuous = true;
    recognitionRef.current = recognition;
    recognition.onstart = () => setIsListening(true);
    recognition.onend = () => setIsListening(false);
    recognition.onerror = () => setIsListening(false);
    recognition.onresult = (event) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setChairmanInput(transcript);
    };
    recognition.start();
  };

  // 추가 질문 — 서버 followup(같은 회의에 라운드 누적). 구독이 새 발언/상태를 반영.
  const sendChairmanMessage = async () => {
    if (!chairmanInput.trim() || isRunning) return;
    const id = meetingIdRef.current;
    if (!id) return;
    const msg = chairmanInput.trim();
    setChairmanInput('');
    // 새 라운드 — 서버가 이전 meeting_end를 DELETE하므로 클라 배열의 옛 요약 버블도 제거.
    setMessages(prev => prev.filter(m => m.type !== 'meeting_end'));
    setSummary('');
    setIsRunning(true);
    setMeetingEnded(false);
    try {
      const res = await apiFetch('/api/meeting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'followup', meetingId: id, message: msg }),
      });
      if (!res.ok) { console.error('Followup failed:', res.status); setIsRunning(false); } // #134: 403/400도 running 고착 방지
    } catch (err) {
      console.error('Followup error:', err);
      setIsRunning(false);
    }
  };

  const agentMessages = messages.filter(m => m.type === 'message' || m.type === 'vote');
  const participants = messages.find(m => m.type === 'meeting_start')?.participants || [];

  // 회의에 참석자 추가 — 서버 followup으로 해당 에이전트 발언 추가
  const addAgent = async (agent: typeof ALL_AGENTS[number]) => {
    setShowAddMenu(false);
    if (isRunning) return;
    const id = meetingIdRef.current;
    if (!id) return;
    setMessages(prev => prev.filter(m => m.type !== 'meeting_end'));
    setSummary('');
    setIsRunning(true);
    setMeetingEnded(false);
    try {
      const res = await apiFetch('/api/meeting', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'followup', meetingId: id, message: `${agent.name} 참석 요청`, addAgents: [agent.id] }),
      });
      if (!res.ok) { console.error('Add agent failed:', res.status); setIsRunning(false); } // #134
    } catch (err) {
      console.error('Add agent error:', err);
      setIsRunning(false);
    }
  };

  const availableAgents = ALL_AGENTS.filter(a => !participants.some(p => p.id === a.id));

  // 핸드오프 불필요 — 회의는 처음부터 서버 백그라운드에서 진행(탭 닫아도 계속).

  const exampleAgendas = lang === 'ko' ? [
    '경쟁사가 비슷한 AI 제품을 출시했다',
    '주요 고객이 해지 의사를 밝혔다',
    '시리즈 A 투자 유치를 검토하자',
    '신규 콘텐츠 전략을 수립하자',
  ] : [
    'A competitor launched a similar AI product',
    'A major client wants to cancel',
    'Should we pursue Series A funding?',
    'New content strategy needed',
  ];

  return (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm" style={{ display: hidden ? 'none' : undefined }}>
      <div className="relative w-full h-full sm:w-[96vw] sm:h-[94vh] sm:max-w-[1400px] bg-[#FBFBF8]/98 sm:border sm:border-[#16203A]/10 rounded-none sm:rounded-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 sm:px-4 sm:py-3 bg-[#F1F3F6] flex items-center justify-between shrink-0 border-b border-[#16203A]/8">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => { (onBack || onClose)(); }}
            className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg hover:bg-[#16203A]/8 text-[#16203A]/60 hover:text-[#16203A] transition shrink-0"
            title={lang === 'ko' ? '뒤로가기' : 'Back'}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h2 className="text-[#16203A] font-bold text-xs sm:text-sm">
            {mode === 'simulation' 
              ? (isRunning ? (<><Zap className="w-3 h-3 inline text-yellow-400" /> {lang === 'ko' ? '시뮬레이션 실행 중' : 'Simulation Running'}</>) : simulationResult ? (<>{lang === 'ko' ? '시뮬레이션 완료' : 'Simulation Complete'}</>) : (<><Target className="w-3 h-3 inline" /> {lang === 'ko' ? '시나리오 시뮬레이션' : 'Scenario Simulation'}</>))
              : (isRunning ? (<>{lang === 'ko' ? '회의 진행 중' : 'Meeting in Progress'}</>) : meetingError ? (<><AlertTriangle className="w-3 h-3 inline text-red-500" /> {lang === 'ko' ? '회의 오류' : 'Meeting Error'}</>) : meetingEnded ? (<>{lang === 'ko' ? '회의 종료' : 'Meeting Ended'}</>) : (<><ClipboardList className="w-3 h-3 inline" /> {lang === 'ko' ? '새 회의' : 'New Meeting'}</>))
            }
          </h2>
          {participants.length > 0 && (
            <span className="text-[9px] sm:text-[10px] text-[#16203A]/60">
              {lang === 'ko' ? `${participants.length}명 참석` : `${participants.length} attending`}
            </span>
          )}
        </div>
        <button
          onClick={() => { onClose(); }}
          className="w-6 h-6 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg bg-white border border-[#16203A]/10 hover:bg-[#16203A]/8 text-[#16203A]/60 hover:text-[#16203A] transition text-xs sm:text-sm"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Participants bar */}
      {participants.length > 0 && (
        <div className="relative px-3 py-2 sm:px-4 sm:py-2 flex items-center gap-1.5 sm:gap-2 shrink-0 border-b border-[#16203A]/8">
          <div className="flex items-center gap-1.5 sm:gap-2 overflow-x-auto flex-1">
            {participants.map(p => (
              <div key={p.id} className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 sm:px-2 sm:py-1 rounded-lg bg-white border border-[#16203A]/10 shrink-0">
                <div className="w-5 h-5 sm:w-6 sm:h-6 rounded-full flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-white bg-[#16203A]">
                  {(displayName(p.id, lang === 'en' ? 'en' : 'ko') || p.name || p.id || '?').charAt(0).toUpperCase()}
                </div>
                <span className="text-[9px] sm:text-[10px] text-[#16203A]/75">{displayName(p.id, lang === 'en' ? 'en' : 'ko')}</span>
              </div>
            ))}
          </div>
          {/* 참석자 추가 */}
          {mode === 'meeting' && availableAgents.length > 0 && (
            <button
              onClick={() => setShowAddMenu(v => !v)}
              disabled={isRunning}
              title={lang === 'ko' ? '참석자 추가' : 'Add participant'}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg bg-[#2B4C7E] text-white text-[10px] sm:text-xs font-medium hover:bg-[#243f6b] disabled:opacity-40 transition"
            >
              <span className="text-sm leading-none">+</span> {lang === 'ko' ? '추가' : 'Add'}
            </button>
          )}
          {showAddMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowAddMenu(false)} />
              <div className="absolute top-full right-2 mt-1 z-30 w-48 max-h-72 overflow-y-auto bg-white border border-[#16203A]/10 rounded-xl shadow-lg py-1">
                {availableAgents.map(a => (
                  <button
                    key={a.id}
                    onClick={() => addAgent(a)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[#16203A]/5 transition"
                  >
                    <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white bg-[#16203A] shrink-0">
                      {(displayName(a.id, lang === 'en' ? 'en' : 'ko') || a.name).charAt(0).toUpperCase()}
                    </div>
                    <span className="text-xs text-[#16203A]/85">{displayName(a.id, lang === 'en' ? 'en' : 'ko')}</span>
                    <span className="text-[9px] text-[#16203A]/45 ml-auto">{a.role}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 sm:py-4 space-y-2 sm:space-y-3">
        {/* 재진입 로드 중 — 소집 화면 대신 로딩 표시(깜빡임 방지) */}
        {attaching && messages.length === 0 && (
          <div className="flex items-center justify-center pt-16 text-[#16203A]/50 text-sm">
            {lang === 'ko' ? '회의 불러오는 중…' : 'Loading meeting…'}
          </div>
        )}
        {/* No meeting yet */}
        {messages.length === 0 && !simulationResult && !isRunning && !attaching && !meetingError && (
          <div className="max-w-2xl mx-auto pt-8 space-y-6">
            <div className="text-center">
              <Building2 className="w-6 h-6 text-[#16203A]/40 mb-2" />
              <h3 className="text-[#16203A] font-bold text-lg mb-1">
                {lang === 'ko' ? 'Quorum War Room' : 'Quorum War Room'}
              </h3>
              <p className="text-xs text-[#16203A]/60">
                {lang === 'ko' ? '시나리오를 선택하거나 직접 안건을 입력하세요' : 'Select a scenario preset or enter a custom agenda'}
              </p>
            </div>

            {/* Mode Toggle — 시뮬 전용 진입 시 숨김 */}
            {initialMode !== 'simulation' && (
            <div className="flex gap-1 sm:gap-2 p-1 rounded-xl bg-[#16203A]/5">
              <button
                onClick={() => setMode('meeting')}
                className={`flex-1 py-1.5 px-2 sm:py-2 sm:px-3 rounded-lg text-[10px] sm:text-xs font-medium transition ${
                  mode === 'meeting'
                    ? 'bg-[#2B4C7E]/20 text-[#2B4C7E] border border-[#2B4C7E]/20'
                    : 'text-[#16203A]/60 hover:text-[#16203A]/85 hover:bg-[#16203A]/5'
                }`}
              >
                <Users className="w-2.5 h-2.5 sm:w-3 sm:h-3 inline mr-1" />
                {lang === 'ko' ? '회의 모드' : 'Meeting Mode'}
              </button>
              <button
                onClick={() => setMode('simulation')}
                className={`flex-1 py-1.5 px-2 sm:py-2 sm:px-3 rounded-lg text-[10px] sm:text-xs font-medium transition ${
                  mode === 'simulation'
                    ? 'bg-[#2B4C7E]/20 text-[#2B4C7E] border border-[#2B4C7E]/20'
                    : 'text-[#16203A]/60 hover:text-[#16203A]/85 hover:bg-[#16203A]/5'
                }`}
              >
                <Target className="w-2.5 h-2.5 sm:w-3 sm:h-3 inline mr-1" />
                {lang === 'ko' ? '시뮬레이션' : 'Simulation'}
              </button>
            </div>
            )}

            {/* Scenario presets for simulation mode */}
            {mode === 'simulation' && (
              <div className="space-y-3">
                <p className="text-[10px] text-[#16203A]/50 text-center uppercase tracking-wider">
                  {lang === 'ko' ? '시나리오 프리셋' : 'Scenario Presets'}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {SIMULATION_SCENARIOS.map((scenario) => {
                    const typeInfo = SCENARIO_TYPE_LABELS[scenario.type] || SCENARIO_TYPE_LABELS.general;
                    return (
                      <button
                        key={scenario.type + scenario.title.en}
                        onClick={() => selectScenario(scenario)}
                        className="text-left p-2 sm:p-3 rounded-xl bg-white border border-[#16203A]/10 hover:bg-[#16203A]/8 transition space-y-1"
                      >
                        <div className="flex items-center gap-1 sm:gap-2 mb-1">
                          <span className="text-[8px] sm:text-[9px] px-1.5 py-0.5 sm:px-2 sm:py-0.5 rounded-full bg-[#2B4C7E]/10 text-[#2B4C7E]/80 font-medium">
                            {SCENARIO_ICONS[scenario.type]} {lang === 'ko' ? typeInfo.ko : typeInfo.en}
                          </span>
                        </div>
                        <div className="text-[11px] sm:text-xs font-medium text-[#16203A]">
                          {lang === 'ko' ? scenario.title.ko : scenario.title.en}
                        </div>
                        <div className="text-[9px] sm:text-[10px] text-[#16203A]/60 leading-relaxed">
                          {lang === 'ko' ? scenario.description.ko : scenario.description.en}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Input section */}
            <div className="space-y-2">
              <textarea
                value={agenda}
                onChange={(e) => setAgenda(e.target.value)}
                placeholder={
                  mode === 'simulation'
                    ? (lang === 'ko' ? '시나리오를 입력하거나 위의 프리셋을 선택하세요...' : 'Enter a scenario or select a preset above...')
                    : (lang === 'ko' ? '회의 안건을 입력하세요...' : 'Enter meeting agenda...')
                }
                className="w-full bg-white border border-[#16203A]/10 rounded-xl px-3 py-2 sm:px-4 sm:py-3 text-xs sm:text-sm text-[#16203A] placeholder-[#16203A]/40 focus:outline-none focus:ring-1 focus:ring-[#2B4C7E]/30 resize-none h-16 sm:h-20"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    e.preventDefault();
                    if (mode === 'simulation') {
                      runSimulation(agenda, selectedScenario || undefined);
                    } else {
                      startMeeting(agenda);
                    }
                  }
                }}
              />
              <button
                onClick={() => mode === 'simulation' ? runSimulation(agenda, selectedScenario || undefined) : startMeeting(agenda)}
                disabled={!agenda.trim()}
                className={`w-full py-2.5 sm:py-3 rounded-xl disabled:opacity-30 text-xs sm:text-sm font-medium transition border ${
                  mode === 'simulation'
                    ? 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border-blue-400/20'
                    : 'bg-[#2B4C7E]/20 hover:bg-[#2B4C7E]/30 text-[#2B4C7E] border-[#2B4C7E]/20'
                }`}
              >
                {mode === 'simulation'
                  ? (
                    <>
                      <Target className="w-3 h-3 sm:w-4 sm:h-4 inline mr-1" />
                      <Zap className="w-3 h-3 inline text-yellow-400" /> {lang === 'ko' ? '시뮬레이션 실행' : 'Run Simulation'}
                    </>
                  ) : (
                    <>
                      <Users className="w-3 h-3 sm:w-4 sm:h-4 inline mr-1" />
                      <Circle className="w-3 h-3 inline text-red-500 fill-red-500" /> {lang === 'ko' ? '회의 소집' : 'Start Meeting'}
                    </>
                  )
                }
              </button>
            </div>

            {/* Examples for meeting mode */}
            {mode === 'meeting' && (
              <div className="space-y-2">
                <p className="text-[10px] text-[#16203A]/50 text-center">
                  {lang === 'ko' ? '예시 안건' : 'Example agendas'}
                </p>
                {exampleAgendas.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => { setAgenda(ex); startMeeting(ex); }}
                    className="w-full text-left px-4 py-2.5 rounded-xl bg-white border border-[#16203A]/10 hover:bg-[#16203A]/8 text-[#16203A]/75 text-xs transition"
                  >
                    <MessageSquare className="w-3 h-3 inline mr-1 text-[#16203A]/60" /> {ex}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Meeting messages */}
        {agentMessages.map((msg, i) => {
          // 안정 key — 라이브 INSERT가 seq 순으로 재삽입(270행 sort)돼도 인덱스 밀림에 의한
          // 재마운트/애니메이션 튐 방지. _seq 없으면(정적 메시지) 인덱스로 폴백.
          const key = msg._seq ?? i;
          // 가중 투표 결과 — 찬/반/조건부 막대 시각화(#Byzantine 합의).
          if (msg.type === 'vote' && msg.tally) {
            const ko = lang === 'ko';
            const t = msg.tally;
            const bars: Array<['for' | 'against' | 'conditional', string, string]> = [
              ['for', ko ? '찬성' : 'For', '#16a34a'], ['against', ko ? '반대' : 'Against', '#dc2626'], ['conditional', ko ? '조건부' : 'Cond.', '#d97706'],
            ];
            const pct = (v: number) => t.total > 0 ? Math.round((v / t.total) * 100) : 0;
            const winLabel = ({ for: ko ? '찬성' : 'For', against: ko ? '반대' : 'Against', conditional: ko ? '조건부' : 'Cond.', abstain: ko ? '유보' : 'Abstain' })[t.winner];
            return (
              <div key={key} className="mx-auto w-full max-w-[88%] bg-white border border-[#16203A]/10 rounded-2xl p-3 sm:p-4 animate-fadeInUp">
                <div className="flex items-center gap-1.5 mb-2 text-[11px] sm:text-xs font-semibold text-[#16203A]">
                  <BarChart3 className="w-3.5 h-3.5 text-[#2B4C7E]" />
                  {ko ? '가중 투표' : 'Weighted Vote'}
                  <span className={`ml-auto px-1.5 py-0.5 rounded text-[9px] font-medium ${t.quorum ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {t.quorum ? `${winLabel} ${Math.round(t.winnerShare * 100)}%` : (ko ? '정족수 미달' : 'No quorum')}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {bars.map(([k, label, color]) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="w-9 sm:w-10 text-[10px] text-[#16203A]/70 shrink-0">{label}</span>
                      <div className="flex-1 h-3 rounded-full bg-[#16203A]/5 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct(t.weights[k])}%`, background: color }} />
                      </div>
                      <span className="w-8 text-[10px] text-[#16203A]/55 text-right shrink-0">{pct(t.weights[k])}%</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          }
          // 빈 메시지(발언 생성 직전) = 타이핑 표시. 이름/역할+큰 말풍선 대신 아바타+점 컴팩트 행으로.
          const isTyping = !msg.message?.trim();
          if (isTyping && msg.agentId !== 'chairman') {
            return (
              <div key={key} className="flex items-center gap-2 sm:gap-3 animate-fadeInUp">
                <div className="shrink-0 w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white bg-[#16203A]">
                  {(displayName(msg.agentId || '', lang === 'en' ? 'en' : 'ko') || msg.agentName || msg.agentId || '?').charAt(0).toUpperCase()}
                </div>
                <div className="inline-flex items-center gap-1 w-fit h-8 sm:h-10 px-3 rounded-2xl rounded-bl-md bg-white border border-[#16203A]/10">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
                <span className="text-[10px] sm:text-xs text-[#16203A]/55">{displayName(msg.agentId || '', lang === 'en' ? 'en' : 'ko') || msg.agentName}</span>
              </div>
            );
          }
          return (
          <div
            key={key}
            className={`flex ${msg.agentId === 'chairman' ? 'justify-end' : 'justify-start'} animate-fadeInUp`}
          >
            {msg.agentId !== 'chairman' && (
              <div className="shrink-0 mr-2 sm:mr-3 flex flex-col items-center gap-0.5 sm:gap-1">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white bg-[#16203A]">
                  {(displayName(msg.agentId || '', lang === 'en' ? 'en' : 'ko') || msg.agentName || msg.agentId || '?').charAt(0).toUpperCase()}
                </div>
              </div>
            )}

            <div className={`max-w-[80%] sm:max-w-[75%] ${msg.agentId === 'chairman' ? '' : ''}`}>
              {msg.agentId !== 'chairman' && (
                <div className="flex items-center gap-1.5 sm:gap-2 mb-0.5 sm:mb-1">
                  <span className="text-[10px] sm:text-xs font-semibold text-[#16203A]">{displayName(msg.agentId || '', lang === 'en' ? 'en' : 'ko') || msg.agentName}</span>
                  <span className="text-[8px] sm:text-[9px] text-[#16203A]/55">{msg.role}</span>
                </div>
              )}
              <div
                className={`px-3 py-2 sm:px-4 sm:py-3 rounded-2xl text-xs sm:text-sm leading-relaxed ${
                  msg.agentId === 'chairman'
                    ? 'bg-[#2B4C7E]/20 text-[#16203A] border border-[#2B4C7E]/20 rounded-br-md'
                    : 'bg-white border border-[#16203A]/10 text-[#16203A]/85 rounded-bl-md'
                }`}
              >
                {msg.agentId === 'chairman' && (
                  <div className="text-[8px] sm:text-[9px] text-[#2B4C7E]/60 font-medium mb-0.5 sm:mb-1 flex items-center gap-1"><UserCheck className="w-3 h-3" /> {msg.agentName && msg.agentName !== '사용자' ? msg.agentName : (lang === 'ko' ? '사용자' : 'You')}</div>
                )}
                {msg.message?.trim()
                  ? <RenderMarkdown text={localizeAgentNames(msg.message, lang)} />
                  : (
                    <div className="flex gap-1 py-0.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  )}
              </div>
            </div>
          </div>
          );
        })}

        {/* 회의 오류 — 서버 재시도 소진(LLM/DB 장애 등). 사용자에게 명확히 표시. */}
        {meetingError && mode === 'meeting' && (
          <div className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 animate-fadeInUp">
            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
            <div className="text-xs text-[#16203A]/75 leading-relaxed">
              {lang === 'ko'
                ? '회의 진행 중 오류가 발생해 중단되었습니다(LLM/네트워크 일시 장애 가능). 잠시 후 새 회의를 시작해 주세요.'
                : 'The meeting stopped due to an error (possible temporary LLM/network issue). Please start a new meeting shortly.'}
            </div>
          </div>
        )}

        {/* Typing indicator */}
        {/* 발언 말풍선이 이미 떠 있으면(빈 메시지=생성 직전 포함) 그 자체가 진행 표시 → 외부 ••• 인디케이터 중복 숨김 */}
        {typingAgent && mode === 'meeting' && messages[messages.length - 1]?.type !== 'message' && (
          <div className="flex items-center gap-3 animate-fadeInUp">
            <div className="w-10 h-10 rounded-xl bg-white border border-[#16203A]/10 flex items-center justify-center">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/60 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
            <span className="text-xs text-[#16203A]/60">{typingAgent.endsWith('...') ? typingAgent : `${displayName(typingAgent, lang === 'en' ? 'en' : 'ko')}${lang === 'ko' ? ' 발언 중...' : ' is speaking...'}`}</span>
          </div>
        )}

        {/* Simulation loading */}
        {isRunning && mode === 'simulation' && !simulationResult && (
          <div className="flex flex-col items-center justify-center py-12 space-y-4 animate-fadeIn">
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-2 border-blue-400/20 border-t-blue-400 animate-spin" />
              <span className="absolute inset-0 flex items-center justify-center"><Target className="w-5 h-5" /></span>
            </div>
            <div className="text-center">
              <p className="text-sm text-blue-300 font-medium">
                {lang === 'ko' ? '시뮬레이션 실행 중...' : 'Running simulation...'}
              </p>
              <p className="text-[10px] text-[#16203A]/55 mt-1 max-w-xs mx-auto">{agenda}</p>
            </div>
          </div>
        )}

        {/* Simulation Results */}
        {simulationResult && mode === 'simulation' && (
          <div className="space-y-4 animate-fadeIn">
            {/* Scenario header */}
            <div className="bg-white border border-[#16203A]/10 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 mb-1">
                {(() => {
                  const typeInfo = SCENARIO_TYPE_LABELS[simulationResult.type] || SCENARIO_TYPE_LABELS.general;
                  return (
                    <span className="text-[9px] px-2 py-0.5 rounded-full bg-blue-400/10 text-blue-300/80 font-medium">
                      {SCENARIO_ICONS[simulationResult.type]} {lang === 'ko' ? typeInfo.ko : typeInfo.en}
                    </span>
                  );
                })()}
              </div>
              <p className="text-sm text-[#16203A] font-medium">{simulationResult.scenario}</p>
              <p className="text-[10px] text-[#16203A]/55 mt-1">
                {simulationResult.agentCount} {lang === 'ko' ? '명의 에이전트가 분석했습니다' : 'agents analyzed'}
              </p>
            </div>

            {/* Agent responses */}
            <div className="space-y-3">
              {simulationResult.responses.slice(0, visibleResponses).map((r, i) => (
                <div key={i} className="flex gap-3 animate-fadeInUp" style={{ animationDelay: `${i * 100}ms` }}>
                  {/* Agent avatar */}
                  <div className="shrink-0">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-bold text-white bg-[#16203A]">
                      {(displayName(r.agentId, lang === 'en' ? 'en' : 'ko') || r.agentName || r.agentId || '?').charAt(0).toUpperCase()}
                    </div>
                  </div>

                  {/* Response content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-bold text-[#16203A]">{displayName(r.agentId, lang === 'en' ? 'en' : 'ko') || r.agentName}</span>
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#16203A]/5 text-[#16203A]/60">{r.role}</span>
                    </div>
                    <div className="bg-white border border-[#16203A]/10 rounded-xl rounded-tl-md px-3 py-2 text-[13px] text-[#16203A]/85 leading-relaxed">
                      <RenderMarkdown text={localizeAgentNames(r.response, lang)} />
                    </div>
                  </div>
                </div>
              ))}

              {/* Show thinking dots while more responses coming */}
              {visibleResponses < simulationResult.responses.length && (
                <div className="flex gap-3 animate-fadeIn">
                  <div className="w-10 h-10 rounded-xl bg-[#16203A]/8/50 border border-[#16203A]/8 flex items-center justify-center">
                    <div className="flex gap-1">
                      <div className="w-1 h-1 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '0ms' }} />
                      <div className="w-1 h-1 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '150ms' }} />
                      <div className="w-1 h-1 rounded-full bg-blue-400/60 animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                  <div className="flex-1 bg-white border border-[#16203A]/10 rounded-xl px-3 py-3 flex items-center">
                    <span className="text-[11px] text-[#16203A]/55">
                      {displayName(simulationResult.responses[visibleResponses]?.agentId || '', lang === 'en' ? 'en' : 'ko') || simulationResult.responses[visibleResponses]?.agentName} {lang === 'ko' ? '분석 중...' : 'analyzing...'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Executive summary */}
            {showSummary && simulationResult.summary && (
              <div className="animate-fadeInUp">
                <div className="rounded-xl border border-blue-400/20 bg-blue-400/[0.05] px-4 py-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <ClipboardList className="w-4 h-4 text-blue-300" />
                    <h3 className="text-sm font-bold text-blue-300">
                      {lang === 'ko' ? '종합 분석 보고서' : 'Executive Summary'}
                    </h3>
                  </div>
                  <div className="text-[13px] text-[#16203A]/85 leading-relaxed">
                    <RenderMarkdown text={localizeAgentNames(simulationResult.summary, lang)} />
                  </div>
                </div>

                {/* Run another */}
                <button
                  onClick={resetToMeeting}
                  className="w-full mt-3 py-2.5 rounded-xl bg-white border border-[#16203A]/10 hover:bg-[#16203A]/8 text-[#16203A]/60 text-sm transition"
                >
                  <RefreshCw className="w-3 h-3 inline mr-1" /> {lang === 'ko' ? '새 시나리오' : 'New Scenario'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Summary */}
        {meetingEnded && summary && mode === 'meeting' && (
          <div className="mt-6 p-4 rounded-2xl bg-white border border-[#16203A]/10 border border-[#2B4C7E]/20 animate-fadeInUp">
            <h4 className="text-[#2B4C7E] font-bold text-sm mb-2 flex items-center gap-1"><ClipboardList className="w-4 h-4" /> {lang === 'ko' ? '회의 요약 보고서' : 'Meeting Summary'}</h4>
            <div className="text-sm text-[#16203A]/85 leading-relaxed">
              <RenderMarkdown text={localizeAgentNames(summary, lang)} />
            </div>
            {/* 추가 지시 사항 — 승인/거절에 첨부 */}
            <textarea
              value={extraDirective}
              onChange={(e) => setExtraDirective(e.target.value)}
              disabled={!!verdict}
              placeholder={lang === 'ko' ? '추가 지시 사항 (선택)' : 'Additional instructions (optional)'}
              rows={2}
              className="mt-3 w-full px-3 py-2 rounded-xl bg-[#F1F3F6] border border-[#16203A]/10 text-xs text-[#16203A] placeholder:text-[#16203A]/40 resize-none focus:outline-none focus:border-[#2B4C7E]/40 disabled:opacity-60"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                onClick={() => submitVerdict('approved')}
                disabled={!!verdict}
                className={`px-4 py-2 rounded-xl text-xs font-medium border transition ${verdict === 'approved' ? 'bg-[#2F7D62] text-white border-[#2F7D62]' : verdict ? 'bg-white border-[#16203A]/10 text-[#16203A]/40' : 'bg-[#2B4C7E] text-white border-[#2B4C7E] hover:bg-[#243f6b]'}`}
              >
                <CheckCircle2 className="w-3 h-3 inline" /> {verdict === 'approved' ? (lang === 'ko' ? '승인 완료' : 'Approved') : (lang === 'ko' ? '승인' : 'Approve')}
              </button>
              <button
                onClick={() => submitVerdict('completed')}
                disabled={!!verdict}
                className={`px-4 py-2 rounded-xl text-xs font-medium border transition ${verdict === 'completed' ? 'bg-[#2F7D62] text-white border-[#2F7D62]' : verdict ? 'bg-white border-[#16203A]/10 text-[#16203A]/40' : 'bg-white border-[#2F7D62]/40 text-[#2F7D62] hover:bg-[#2F7D62]/8'}`}
              >
                <CheckCircle2 className="w-3 h-3 inline" /> {verdict === 'completed' ? (lang === 'ko' ? '완료됨' : 'Completed') : (lang === 'ko' ? '완료' : 'Complete')}
              </button>
              <button
                onClick={() => submitVerdict('rejected')}
                disabled={!!verdict}
                className={`px-4 py-2 rounded-xl text-xs font-medium border transition ${verdict === 'rejected' ? 'bg-[#B0453E] text-white border-[#B0453E]' : verdict ? 'bg-white border-[#16203A]/10 text-[#16203A]/40' : 'bg-white border-[#B0453E]/30 text-[#B0453E] hover:bg-[#B0453E]/8'}`}
              >
                <XCircle className="w-3 h-3 inline" /> {verdict === 'rejected' ? (lang === 'ko' ? '거절 완료' : 'Rejected') : (lang === 'ko' ? '거절' : 'Reject')}
              </button>
              <button
                onClick={resetToMeeting}
                disabled={!!verdict}
                className="px-4 py-2 rounded-xl bg-white border border-[#16203A]/10 text-[#16203A]/75 text-xs hover:bg-[#16203A]/8 transition disabled:opacity-50"
              >
                <RefreshCw className="w-3 h-3 inline" /> {lang === 'ko' ? '새 회의' : 'New Meeting'}
              </button>
              {/* 회의록 문서 다운로드 — 회의 발언을 DOCX/Markdown으로 생성 */}
              <button
                onClick={() => downloadMinutes('docx')}
                disabled={!!downloading}
                className="px-3 py-2 rounded-xl bg-white border border-[#2B4C7E]/30 text-[#2B4C7E] text-xs font-medium hover:bg-[#2B4C7E]/8 transition disabled:opacity-50"
              >
                <FileText className="w-3 h-3 inline" /> {downloading === 'docx' ? (lang === 'ko' ? '생성 중…' : 'Generating…') : (lang === 'ko' ? '회의록 DOCX' : 'Minutes DOCX')}
              </button>
              <button
                onClick={() => downloadMinutes('md')}
                disabled={!!downloading}
                className="px-3 py-2 rounded-xl bg-white border border-[#16203A]/10 text-[#16203A]/75 text-xs font-medium hover:bg-[#16203A]/8 transition disabled:opacity-50"
              >
                <FileText className="w-3 h-3 inline" /> {downloading === 'md' ? (lang === 'ko' ? '생성 중…' : 'Generating…') : (lang === 'ko' ? '회의록 MD' : 'Minutes MD')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Chairman input — 진행 중 발언 / 종료 후 추가 질문 */}
      {mode === 'meeting' && (isRunning || meetingEnded || messages.length > 0) && (
        <div className="px-3 py-2 sm:px-4 sm:py-3 bg-[#F1F3F6] shrink-0 border-t border-[#16203A]/8">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendChairmanMessage();
            }}
            className="flex gap-1.5 sm:gap-2"
          >
            <input
              type="text"
              value={chairmanInput}
              onChange={(e) => setChairmanInput(e.target.value)}
              placeholder={isListening ? (lang === 'ko' ? '듣고 있어요...' : 'Listening...') : (meetingEnded && !isRunning ? (lang === 'ko' ? '추가 질문하기...' : 'Ask a follow-up...') : (lang === 'ko' ? '사용자로 발언하기...' : 'Speak as User...'))}
              className={`flex-1 bg-white border border-[#16203A]/10 rounded-xl px-3 py-2 sm:px-4 sm:py-2.5 text-xs sm:text-sm text-[#16203A] placeholder-[#16203A]/40 focus:outline-none focus:ring-1 focus:ring-[#2B4C7E]/30 ${isListening ? 'ring-1 ring-red-400/50' : ''}`}
            />
            <button
              type="button"
              onClick={toggleSTT}
              className={`w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl transition text-sm sm:text-lg ${
                isListening 
                  ? 'bg-red-500/30 text-red-300 border border-red-400/40 animate-pulse' 
                  : 'bg-[#16203A]/5 hover:bg-[#16203A]/8 text-[#16203A]/60 hover:text-[#16203A] border border-[#16203A]/10'
              }`}
            >
              <Mic className="w-4 h-4" />
            </button>
            <button
              type="submit"
              disabled={!chairmanInput.trim() || isRunning}
              className="px-3 py-2 sm:px-4 sm:py-2.5 rounded-xl bg-[#2B4C7E]/20 hover:bg-[#2B4C7E]/30 disabled:opacity-30 text-[#2B4C7E] text-xs sm:text-sm font-medium transition border border-[#2B4C7E]/20"
            >
              <UserCheck className="w-4 h-4" />
            </button>
          </form>
        </div>
      )}
      </div>
    </div>
  );
}
