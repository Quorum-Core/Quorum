'use client';
import { useState, useEffect, useCallback } from 'react';
import { X, Clock, CheckCircle2, Zap, Send, FileText, Activity, Users, Trash2, AlertTriangle, RefreshCw, Play, Building2, Circle, XCircle, Timer, Check } from 'lucide-react';

import { useLang } from '@/context/LangContext';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cleanMarkdown, localizeText, RenderMarkdown } from '@/lib/format-markdown';
import { AGENT_ROSTER } from '@/data/agent-config';
import UserCompanyDashboard from './UserCompanyDashboard';
import { useCompanies } from '@/hooks/useCompanies';
import { displayName } from '@/data/agent-names';

interface AgentInfo {
  status: 'working' | 'idle' | 'resting';
  lastTask: string; lastActive: string; tasksToday: number;
}
type JsonRecord = Record<string, unknown>;
type AgentProgress = { status?: string; completed_at?: string };
interface Decision {
  id: string; type: string; title: string; title_en?: string; description: string; description_en?: string;
  status: string; priority: string; current_assignee: string;
  participants: JsonRecord | null; artifacts: ({ analysis_by?: string } & JsonRecord) | null; trigger_agent_id: string;
  trigger_data: { title_ko?: string; title_en?: string; assignees?: string[]; [key: string]: unknown } | null;
  analysis?: string; delegation_level?: number; review_notes?: string;
  created_at: string; updated_at: string;
  assignees?: string[] | string; // JSON array or string of agent IDs
  progress?: { total: number; completed: number; agent_results: Record<string, AgentProgress> };
  meeting_id?: string; // 회의 매핑 — 클릭 시 해당 회의 복원(AI 재호출 없음)
}
interface MonitoringData {
  server: string; responseMs: number; users: number; sessions: number;
  bids: number; newBids: number; feedback: number; tickets: number;
  checkedAt: string;
}
interface DirectiveResponseTask { agent_id: string; response?: string; model?: string }
interface Props { 
  open: boolean; 
  onClose: () => void;
  onOpenReports?: () => void;
  onOpenMeeting?: (agenda: string, meetingId?: string, dir?: Decision) => void;
  initialTab?: string | null;
}

// Build AG from AGENT_ROSTER
const AG: Record<string, { name: string; dept: string; image: string; floor: number }> = {
  chairman: { name: '사용자', dept: '경영', image: '', floor: 10 },
};
AGENT_ROSTER.forEach(a => {
  AG[a.id] = { name: a.name, dept: a.department, image: '', floor: a.floor };
});
const AgentAvatar = ({ id, size = 'sm' }: { id: string; size?: 'xs' | 'sm' | 'md' }) => {
  const s = size === 'xs' ? 'w-4 h-4 text-[8px]' : size === 'md' ? 'w-7 h-7 text-xs' : 'w-5 h-5 text-[10px]';
  const initial = (displayName(id, 'ko') || id || '?').charAt(0).toUpperCase();
  return (
    <span className={`${s} rounded-full bg-[#16203A] text-white font-bold inline-flex items-center justify-center align-middle`}>
      {initial}
    </span>
  );
};

// Scheduled Operations data (initial — mirrors actual OpenClaw cron jobs)
const INITIAL_SCHEDULED_OPS: { id:string; name:string; agent:string|null; schedule:string; channel:string; status:string; hour:number }[] = [];

const SCHEDULE_GROUPS = [
  { key: 'morning', label: 'Morning', labelKo: '오전', range: '06-12', min: 6, max: 12 },
  { key: 'afternoon', label: 'Afternoon', labelKo: '오후', range: '12-18', min: 12, max: 18 },
  { key: 'evening', label: 'Evening', labelKo: '저녁', range: '18-24', min: 18, max: 24 },
  { key: 'night', label: 'Night', labelKo: '심야', range: '00-06', min: 0, max: 6 },
];

const ALL_IDS = Object.keys(AG);

export default function ChairmanDashboard({ open, onClose, onOpenMeeting, initialTab }: Props) {
  const { lang } = useLang();
  const ko = lang === 'ko';
  const [directives, setDirectives] = useState<Decision[]>([]);
  const { companies: COMPANIES, isMulti: isMultiCompany, defaultId } = useCompanies();
  const [, setAgents] = useState<Record<string, AgentInfo>>({});
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showNewForm, setShowNewForm] = useState(false);
  const [submitFeedback, setSubmitFeedback] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState('normal');
  const [newAssignees, setNewAssignees] = useState<{ id: string; task: string }[]>([]);
  const [assigneeSearch, setAssigneeSearch] = useState('');

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [statusRes, monRes] = await Promise.all([
        fetch('/api/agent-status'),
        fetch('/api/reports?report_type=eq.health_check&order=created_at.desc&limit=1'),
      ]);
      
      // Fetch directives from decisions table.
      const directiveRes = await fetch('/api/decisions?trigger_source=directive&order=created_at.desc&limit=50');
      if (directiveRes.ok) {
        const directivePayload = await directiveRes.json();
        const dirs: Decision[] = Array.isArray(directivePayload) ? directivePayload : directivePayload.decisions || [];
        // Live progress: check directive status route for in_progress directives
        for (const dir of dirs) {
          // 폴백: 진행률은 완료인데 status가 in_progress로 고착된 지시(완료 PATCH 유실 등) → 직접 완료 처리
          const prog = dir.progress;
          if (dir.status === 'in_progress' && prog && prog.total > 0 && prog.completed >= prog.total) {
            await fetch('/api/decisions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dir.id, status: 'completed' }) }).catch(() => {});
            dir.status = 'completed';
            continue;
          }
          // 인라인 모드 고착 보정(최후 수단): 실행이 서버 중단으로 멈추면 status route로 안 풀림.
          // updated_at(실행 시작 시 갱신) 기준 30분 초과 시에만 pending으로 되돌려 재실행 가능하게 함.
          // created_at 대신 updated_at → 묵은 pending 재실행을 즉시 끊는 race 방지.
          // 30분 임계 + completed 자동전환 안 함 → 정상 진행(큐 포함) 작업 미차단·거짓 완료 방지.
          {
            const stuckRef = dir.updated_at || dir.created_at;
            const elapsedStuck = stuckRef ? Date.now() - new Date(stuckRef).getTime() : 0;
            if (dir.status === 'in_progress' && elapsedStuck > 30 * 60 * 1000) {
              await fetch('/api/decisions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: dir.id, status: 'pending' }) }).catch(() => {});
              dir.status = 'pending';
              continue;
            }
          }
          if (dir.status === 'in_progress' && dir.trigger_data?.assignees) {
            try {
              const statusRes = await fetch(`/api/directive/status?id=${encodeURIComponent(dir.id)}`);
              if (!statusRes.ok) continue;
              const statusPayload = await statusRes.json();
              if (statusPayload.directive?.progress) dir.progress = statusPayload.directive.progress;

              const completed = statusPayload.summary?.completed || 0;
              const dirCreated = new Date(dir.created_at).getTime();
              const elapsed = Date.now() - dirCreated;
              const TIMEOUT_MS = 10 * 60 * 1000;
              const shouldComplete = statusPayload.allDone ||
                (statusPayload.allFinished && completed > 0) ||
                (elapsed > TIMEOUT_MS && completed > 0);
              if (shouldComplete) {
                const completeRes = await fetch('/api/directive/complete', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ directiveId: dir.id }),
                });
                if (completeRes.ok) {
                  dir.status = 'completed';
                  // 폴링 중 사용자가 보던 탭을 강제로 done으로 옮기지 않음(탭 튐 방지)
                }
              }
            } catch {}
          }
        }
        // 같은 회의(meeting_id) 또는 같은 제목 지시는 최근 1개만 표시 — 중복(완료+진행중) 제거
        // meeting_id와 title을 동시에 추적: 한 레코드만 meeting_id 보유(완료본)하고 다른 건
        // meeting_id 없음/다름(진행중본)이어도 같은 제목이면 묶어서 1개만 노출(불일치 키 버그 방지).
        const seenMeeting = new Set<string>();
        const seenTitle = new Set<string>();
        const deduped = dirs.filter((d) => {
          const mid = d.meeting_id ? String(d.meeting_id) : '';
          const titleKey = `t:${cleanMarkdown(d.title || '').trim()}`;
          if ((mid && seenMeeting.has(mid)) || seenTitle.has(titleKey)) return false;
          if (mid) seenMeeting.add(mid);
          seenTitle.add(titleKey);
          return true;
        });
        setDirectives(deduped);
      } else {
        setDirectives([]);
      }
      if (statusRes.ok) setAgents((await statusRes.json()).agents || {});

      if (monRes.ok) {
        const monData = await monRes.json();
        if (monData.length > 0) {
          const content = monData[0].content || '';
          // Parse key metrics from report content
          const usersMatch = content.match(/총 가입자: (\d+)명/);
          const sessionsMatch = content.match(/오늘 세션: (\d+)건/);
          const bidsMatch = content.match(/총 공고: ([\d,]+)건/);
          const newBidsMatch = content.match(/오늘 신규: (\d+)건/);
          const feedbackMatch = content.match(/총 피드백: (\d+)건/);
          const ticketsMatch = content.match(/미해결 티켓: (\d+)건/);
          const serverMatch = content.match(/메인: (\d+) \((\d+)ms/);
          // Only show monitoring bar if we got a valid server response
          if (serverMatch && serverMatch[1] === '200') {
            setMonitoring({
              server: serverMatch[1],
              responseMs: parseInt(serverMatch[2]),
              users: usersMatch ? parseInt(usersMatch[1]) : 0,
              sessions: sessionsMatch ? parseInt(sessionsMatch[1]) : 0,
              bids: bidsMatch ? parseInt(bidsMatch[1].replace(/,/g, '')) : 0,
              newBids: newBidsMatch ? parseInt(newBidsMatch[1]) : 0,
              feedback: feedbackMatch ? parseInt(feedbackMatch[1]) : 0,
              tickets: ticketsMatch ? parseInt(ticketsMatch[1]) : 0,
              checkedAt: monData[0].created_at,
            });
          }
        }
      }
    } catch { /* */ }
    if (!silent) setLoading(false);
  }, []);

  const [refreshing, setRefreshing] = useState(false);
  const [activeCompany, setActiveCompany] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = sessionStorage.getItem('quorum-active-company');
      if (saved) {
        sessionStorage.removeItem('quorum-active-company');
        return saved;
      }
    }
    return defaultId;
  });

  const [showScheduled, setShowScheduled] = useState(false);
  const [scheduledOps, setScheduledOps] = useState(INITIAL_SCHEDULED_OPS);
  const removeScheduledOp = (id: string) => setScheduledOps(prev => prev.filter(op => op.id !== id));
  useEffect(() => { if (open) fetchData(); }, [open, fetchData]);

  const [expandedDecision, setExpandedDecision] = useState<string | null>(null);

  // Auto-poll when directives are in progress
  useEffect(() => {
    const hasActive = directives.some(d => d.status === 'in_progress');
    if (!hasActive || !open) return;
    // 진행중엔 5초 폴링 + 숨겨진 탭 생략 — 에이전트별 진행 반영(부하 완화).
    const interval = setInterval(() => {
      if (!document.hidden) fetchData(true);
    }, 5000);
    return () => clearInterval(interval);
  }, [directives, open, fetchData]);
  // No auto-refresh — manual refresh button instead
  const handleRefresh = async () => { setRefreshing(true); await fetchData(); setRefreshing(false); };

  // 정적 client autoAssign 제거 — assignee 배정은 서버 /api/directive/assign(DB registry 검증)이 단독 담당.

  const handleSubmit = async () => {
    if (!newTitle.trim()) return;
    setSubmitFeedback(ko ? 'Counsely 배정 중...' : 'Counsely assigning agents...');
    // Use manual assignees if set, otherwise ask Counsely
    let finalAssignees = newAssignees;
    if (newAssignees.length === 0) {
      try {
        const assignRes = await fetch('/api/directive/assign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle, description: newDesc }),
        });
        if (assignRes.ok) {
          const { agents } = await assignRes.json();
          finalAssignees = Array.isArray(agents) ? agents : [];
        }
      } catch {}
      // 정적 client fallback 제거 — assignee는 서버(/api/directive/assign, DB registry 검증)만 신뢰.
      if (finalAssignees.length === 0) {
        setSubmitFeedback(ko ? '담당 에이전트를 정하지 못했습니다. 잠시 후 다시 시도하세요.' : 'Could not assign agents. Try again.');
        setTimeout(() => setSubmitFeedback(null), 3000);
        return;
      }
    }
    const res = await fetch('/api/directives', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle, description: newDesc, assignees: finalAssignees, priority: newPriority }),
    });
    if (res.ok) {
      setNewTitle(''); setNewDesc(''); setNewAssignees([]); setShowNewForm(false);
      setSubmitFeedback(ko ? '지시사항이 등록되었습니다' : 'Directive submitted successfully');
      setTimeout(() => setSubmitFeedback(null), 3000);
      fetchData();
    } else {
      setSubmitFeedback(ko ? '등록 실패' : 'Failed to submit');
      setTimeout(() => setSubmitFeedback(null), 3000);
    }
  };

  const [advancing, setAdvancing] = useState<string | null>(null);
  const [decisionNotes] = useState<Record<string, string>>({});
  const [dirTab, setDirTab] = useState<'pending'|'active'|'done'>(initialTab === 'done' ? 'done' : initialTab === 'active' ? 'active' : 'pending');

  // Update tab when initialTab changes (e.g., from workflow completion)
  useEffect(() => {
    if (initialTab === 'done') setDirTab('done');
    else if (initialTab === 'active') setDirTab('active');
  }, [initialTab]);
  const [directiveResponses, setDirectiveResponses] = useState<Record<string, { agent_id: string; message: string; elapsed_ms?: number; llm_model?: string }[]>>({});

  const loadDirectiveResponses = async (directiveId: string) => {
    try {
      const statusRes = await fetch(`/api/directive/status?id=${encodeURIComponent(directiveId)}`);
      if (statusRes.ok) {
        const payload = await statusRes.json();
        const items = (payload.tasks || []) as DirectiveResponseTask[];
        let responses = items.map((q) => ({ agent_id: q.agent_id, message: q.response || '', llm_model: q.model }));
        // 큐를 쓰지 않는 경로(홈 작업)는 tasks가 비어 있음 → progress.agent_results를 fallback으로 사용
        if (responses.length === 0) {
          const ar = (payload.directive?.progress?.agent_results || {}) as Record<string, { response?: string }>;
          responses = Object.entries(ar).filter(([, v]) => v && v.response)
            .map(([id, v]) => ({ agent_id: id, message: v.response || '', llm_model: undefined }));
        }
        setDirectiveResponses(prev => ({ ...prev, [directiveId]: responses }));
      }
    } catch {}
  };

  // #3: initialTab='done' + done 디렉티브 로드 완료 시 최신 항목 auto-expand. directives(async) 의존 → race 방지.
  const doneTopId = directives.find(d => d.status === 'done' || d.status === 'completed' || d.status === 'completed_with_errors')?.id;
  useEffect(() => {
    if (open && initialTab === 'done' && doneTopId) {
      setExpandedDecision(`dir-${doneTopId}`);
      void loadDirectiveResponses(doneTopId);
    }
  }, [open, initialTab, doneTopId]);

  const executeDirective = async (directiveId: string) => {
    setAdvancing(directiveId);
    try {
      const chairmanNote = decisionNotes[directiveId]?.trim();
      const res = await fetch('/api/directive/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          directiveId,
          ...(chairmanNote ? { chairmanNote } : {})
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        console.log(`[check] Directive executed: ${data.tasksCreated} tasks created`);
        // 진행 상황은 대시보드 진행중(active) 탭에서 확인
        onClose();
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('quorum-navigate', { detail: { view: 'dashboard', tab: 'active' } }));
        }, 300);
      } else {
        const error = await res.json();
        console.error('Failed to execute directive:', error);
      }
    } catch (error) {
      console.error('Execute directive error:', error);
    } finally { 
      setAdvancing(null); 
    }
    fetchData();
  };

  const deleteDecision = async (id: string) => {
    setAdvancing(id);
    try {
      await fetch(`/api/decisions?id=eq.${id}`, { method: 'DELETE' });
    } finally { setAdvancing(null); }
    fetchData();
  };

  const DirectiveCard = ({ d, done }: { d: Decision; done?: boolean }) => {
    const rawTitle = ((!ko && d.title_en) ? d.title_en : d.title) || '';
    const prio = parsePrio(rawTitle);
    const title = localizeText(cleanTitle(rawTitle), lang);
    const isExpanded = expandedDecision === `dir-${d.id}`;
    
    // Get assignees from trigger_data.assignees or assignees array
    let assignees: string[] = [];
    if (d.trigger_data?.assignees && Array.isArray(d.trigger_data.assignees)) {
      assignees = d.trigger_data.assignees;
    } else if (d.assignees && Array.isArray(d.assignees)) {
      assignees = d.assignees;
    } else if (typeof d.assignees === 'string') {
      try {
        const parsed = JSON.parse(d.assignees);
        assignees = Array.isArray(parsed) ? parsed : [];
      } catch {}
    }

    // Progress display
    const progress = d.progress || { total: 0, completed: 0, agent_results: {} };
    const progressPercent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
    
    return (
      <div 
        className={`rounded-xl border p-2.5 cursor-pointer transition-colors ${done ? 'border-[#2F7D62]/20 bg-[#2F7D62]/[0.05] hover:bg-[#2F7D62]/[0.08]' : 'border-[#16203A]/8 bg-white hover:bg-[#16203A]/[0.02] shadow-[0_2px_8px_rgba(22,32,58,0.03)]'}`}
        onClick={() => onOpenMeeting?.(cleanMarkdown(title), d.meeting_id, d)}
      >
        <div className="flex items-center gap-1.5 mb-1">
          {done && <CheckCircle2 className="w-3.5 h-3.5 text-[#2F7D62] shrink-0" />}
          <span className="text-[#16203A] text-[13px] font-medium flex-1 truncate">{title}</span>
          <PrioDot prio={prio} />
        </div>
        {done && !isExpanded && (
          <p className="text-[#2F7D62]/70 text-[11px] mt-0.5">{ko ? '클릭하여 회의실 열기' : 'Click to open meeting room'}</p>
        )}
        {d.description && (
          <p className="text-[12px] text-[#16203A]/55 mb-1.5 line-clamp-2">{localizeText(cleanMarkdown(d.description), lang)}</p>
        )}
        
        {/* Progress display for in_progress directives */}
        {d.status === 'in_progress' && progress.total > 0 && (
          <div className="mb-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] text-[#3E6BB0]">{ko ? '진행률' : 'Progress'}</span>
              <span className="text-[11px] text-[#16203A] font-medium">{progress.completed}/{progress.total} agents</span>
              <span className="text-[11px] text-[#16203A]/55">({progressPercent}%)</span>
            </div>
            <div className="w-full bg-[#16203A]/8 rounded-full h-1.5">
              <div
                className="bg-[#3E6BB0] h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {assignees.length > 0 && (() => {
          // 순차 실행: agent_results에 없는 첫 번째 = 현재 작업중(진행중 directive 한정)
          const workingId = d.status === 'in_progress'
            ? assignees.find(id => !(progress.agent_results?.[id]))
            : undefined;
          return (
          <div className="space-y-1 mb-1.5">
            {assignees.map(agentId => {
              const agentResult = progress.agent_results?.[agentId] as ({ status?: string; completed_at?: string; response?: string }) | undefined;
              const isCompleted = agentResult?.status === 'completed' || !!agentResult?.completed_at;
              const isFailed = agentResult?.status === 'failed';
              const isWorking = agentId === workingId;
              return (
                <div key={agentId} className="bg-[#16203A]/[0.03] rounded-lg px-2 py-1">
                  <div className="flex items-center gap-1.5">
                    <AgentAvatar id={agentId} size="xs" />
                    <span className="text-[#16203A] text-[12px] font-medium">{displayName(agentId, ko ? 'ko' : 'en')}</span>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      isCompleted ? 'bg-[#2F7D62]' : isFailed ? 'bg-[#B0453E]' : isWorking ? 'bg-[#3E6BB0] animate-pulse' : 'bg-[#16203A]/25'
                    }`} />
                    {isCompleted && <Check className="w-3 h-3 text-[#2F7D62] inline" />}
                    {isWorking && <span className="text-[10px] text-[#3E6BB0]">{ko ? '분석 중…' : 'working…'}</span>}
                    {isFailed && <span className="text-[10px] text-[#B0453E]">{ko ? '실패' : 'failed'}</span>}
                  </div>
                  {isCompleted && agentResult?.response && (
                    <p className="text-[11px] text-[#16203A]/60 mt-1 line-clamp-2 pl-6">{cleanMarkdown(agentResult.response).slice(0, 120)}</p>
                  )}
                </div>
              );
            })}
          </div>
          );
        })()}

        <div className="flex items-center justify-between mt-2">
          <span className="text-[11px] text-[#16203A]/80">{timeAgo(d.created_at)}</span>
          <div className="flex gap-1">
            {!done && (d.status === 'pending' || d.status === 'approval_requested' || d.status === 'approved') && (
              <button
                onClick={(e) => { e.stopPropagation(); executeDirective(d.id); }}
                disabled={!!advancing}
                className="text-[12px] bg-[#16203A] text-white px-2.5 py-1 rounded-lg hover:bg-[#16203A]/90 disabled:opacity-50 flex items-center gap-1"
              >
                {advancing === d.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                {ko ? '승인 & 실행' : 'Approve & Execute'}
              </button>
            )}
            {!done && d.status === 'in_progress' && progress.total > 0 && progress.completed >= progress.total && (
              <button 
                onClick={async (e) => {
                  e.stopPropagation();
                  setAdvancing(d.id);
                  try {
                    await fetch('/api/directive/complete', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ directiveId: d.id }),
                    });
                  } finally { setAdvancing(null); }
                  fetchData();
                }} 
                disabled={advancing === d.id}
                className="text-[12px] bg-[#2F7D62]/10 text-[#2F7D62] px-2.5 py-1 rounded-lg hover:bg-[#2F7D62]/20 disabled:opacity-50 flex items-center gap-1"
              >
                {advancing === d.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
                {ko ? '완료 처리' : 'Mark Done'}
              </button>
            )}
            {done && (
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(ko ? '삭제하시겠습니까?' : 'Delete?')) deleteDecision(d.id); }}
                className="text-[12px] bg-[#16203A]/[0.06] text-[#16203A]/55 px-2 py-1 rounded-lg hover:bg-red-500/10 hover:text-red-500 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Agent responses panel */}
        {isExpanded && (
          <div className="mt-2 pt-2 border-t border-[#16203A]/8 space-y-2">
            <span className="text-[11px] text-[#16203A]/55 uppercase tracking-wider">{ko ? '에이전트 응답' : 'Agent Responses'}</span>
            {(directiveResponses[d.id] || []).length === 0 ? (
              <p className="text-[12px] text-[#16203A]/50">{ko ? '응답 없음' : 'No responses yet'}</p>
            ) : (
              (directiveResponses[d.id] || []).map((r, i) => (
                <div key={i} className="bg-[#16203A]/[0.03] rounded-xl p-2.5 border border-[#16203A]/8">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <AgentAvatar id={r.agent_id} size="xs" />
                    <span className="text-[12px] text-[#2B4C7E] font-medium">{displayName(r.agent_id, ko ? 'ko' : 'en') || r.agent_id}</span>
                    {r.elapsed_ms && <span className="text-[10px] text-[#16203A]/50"><Timer className="w-3 h-3 inline" /> {(r.elapsed_ms / 1000).toFixed(1)}s</span>}
                    {r.llm_model && <span className="text-[10px] text-[#16203A]/80">{r.llm_model.split(':').pop()}</span>}
                  </div>
                  <div className="text-[12px] text-[#16203A]/75 max-h-[60vh] sm:max-h-[400px] overflow-y-auto leading-relaxed overscroll-contain">
                    {r.message ? <RenderMarkdown text={localizeText(r.message.slice(0, 3000), lang)} /> : (ko ? '처리 중...' : 'Processing...')}
                    {r.message && r.message.length > 3000 && <span className="text-[#16203A]/50">...</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  const timeAgo = (d: string) => {
    if (!d) return '-';
    const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
    if (m < 1) return ko ? '방금' : 'now';
    if (m < 60) return `${m}${ko ? '분' : 'm'}`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}${ko ? '시간' : 'h'}`;
    return `${Math.floor(h / 24)}${ko ? '일' : 'd'}`;
  };

  const parsePrio = (t: string) => (t.match(/^\[(URGENT|HIGH|NORMAL|LOW)\]/i)?.[1]?.toLowerCase() || 'normal');
  const cleanTitle = (t: string) => t.replace(/^\[(URGENT|HIGH|NORMAL|LOW)\]\s*/i, '');
  const PrioDot = ({ prio }: { prio: string }) => {
    const colors: Record<string, string> = { urgent: 'text-red-500 fill-red-500', high: 'text-amber-500 fill-amber-500', normal: 'text-[#2B4C7E] fill-[#2B4C7E]', low: 'text-[#16203A]/40 fill-[#16203A]/40' };
    return <Circle className={`w-2.5 h-2.5 ${colors[prio] || colors.normal}`} />;
  };

  const pendingDirs = directives.filter(d => d.status === 'pending' || d.status === 'approval_requested' || d.status === 'approved');
  const activeDirs = directives.filter(d => d.status === 'in_progress' || d.status === 'executing');
  const doneDirs = directives.filter(d => d.status === 'done' || d.status === 'completed' || d.status === 'completed_with_errors');

  const filteredAg = assigneeSearch.trim()
    ? ALL_IDS.filter(id => (id.includes(assigneeSearch.toLowerCase()) || AG[id]?.name.toLowerCase().includes(assigneeSearch.toLowerCase())) && !newAssignees.find(a => a.id === id))
    : [];

  return (
    <div className="fixed inset-0 md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[420px] z-50 bg-[#F6F7F9] backdrop-blur-xl border-0 md:border-l md:border-[#16203A]/10 overflow-hidden flex flex-col shadow-[0_0_40px_rgba(22,32,58,0.08)] animate-slideIn">

        {/* HEADER */}
        {/* HEADER */}
        <div className="p-4 sm:px-6 sm:py-4 border-b border-[#16203A]/8 shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="text-[#16203A] font-bold text-base sm:text-lg"><Building2 className="w-4 h-4 inline" /> {ko ? '사용자 대시보드' : 'Your Dashboard'}</h2>
            <div className="flex items-center gap-1">
              <button onClick={handleRefresh} disabled={refreshing} title={ko ? '새로고침' : 'Refresh'}
                className="p-1.5 rounded-full text-[#16203A]/60 hover:bg-[#16203A]/8 disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
              <button onClick={onClose} className="p-1.5 rounded-full hover:bg-[#16203A]/8"><X className="w-5 h-5 text-[#16203A]/60" /></button>
            </div>
          </div>
        </div>


        {/* COMPANY TABS — only shown when 2+ companies */}
        {isMultiCompany && (
          <div className="px-3 sm:px-5 py-1.5 border-b border-[#16203A]/8 shrink-0 flex gap-1 overflow-x-auto">
            {COMPANIES.map(c => {
              const active = activeCompany === c.id;
              // Dynamic color classes (tailwind needs full strings for JIT)
              const colorMap: Record<string, string> = {
                amber: active ? 'bg-[#2B4C7E]/15 text-[#2B4C7E] border border-[#2B4C7E]/30' : '',
                emerald: active ? 'bg-emerald-400/15 text-emerald-400 border border-emerald-400/30' : '',
                cyan: active ? 'bg-cyan-400/15 text-cyan-400 border border-cyan-400/30' : '',
                blue: active ? 'bg-blue-400/15 text-blue-400 border border-blue-400/30' : '',
                pink: active ? 'bg-pink-400/15 text-pink-400 border border-pink-400/30' : '',
                orange: active ? 'bg-orange-400/15 text-orange-400 border border-orange-400/30' : '',
                violet: active ? 'bg-violet-400/15 text-violet-400 border border-violet-400/30' : '',
                slate: active ? 'bg-slate-400/15 text-slate-400 border border-slate-400/30' : '',
                teal: active ? 'bg-teal-400/15 text-teal-400 border border-teal-400/30' : '',
                purple: active ? 'bg-[#2B4C7E]/10 text-[#2B4C7E] border border-[#2B4C7E]/25' : '',
                yellow: active ? 'bg-yellow-400/15 text-yellow-400 border border-yellow-400/30' : '',
                rose: active ? 'bg-rose-400/15 text-rose-400 border border-rose-400/30' : '',
                indigo: active ? 'bg-indigo-400/15 text-indigo-400 border border-indigo-400/30' : '',
                green: active ? 'bg-green-400/15 text-green-400 border border-green-400/30' : '',
                fuchsia: active ? 'bg-fuchsia-400/15 text-fuchsia-400 border border-fuchsia-400/30' : '',
                gray: active ? 'bg-[#16203A]/10 text-[#16203A]/60 border border-[#16203A]/20' : '',
                zinc: active ? 'bg-zinc-400/15 text-zinc-400 border border-zinc-400/30' : '',
              };
              return (
                <button key={c.id} onClick={() => setActiveCompany(c.id)}
                  className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition flex items-center gap-1.5 ${
                    active ? colorMap[c.color] || 'bg-[#16203A]/8 text-[#16203A] border border-[#16203A]/15' : 'text-[#16203A]/55 hover:text-[#16203A]/75 hover:bg-[#16203A]/5'
                  }`}>
                  <span>{c.icon}</span> {ko ? c.nameKo : c.name}
                </button>
              );
            })}
          </div>
        )}

        {/* MONITORING BAR */}
        {monitoring && (
          <div className="border-b border-[#16203A]/8 shrink-0">
            <div className="w-full px-3 sm:px-5 py-1.5">
              <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto text-[11px] sm:text-[12px]">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[#16203A]/55 font-medium hidden sm:inline">Product Dashboard</span>
                  <span className="text-[#16203A]/55 font-medium sm:hidden">MBW</span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] sm:text-[11px] font-medium ${monitoring.server === '200' ? 'bg-green-400/10 text-green-400' : 'bg-red-400/10 text-red-400'}`}>
                    {monitoring.server === '200' ? <CheckCircle2 className="w-3 h-3 inline text-green-400" /> : <XCircle className="w-3 h-3 inline text-red-400" />} {monitoring.responseMs}ms
                  </span>
                </div>
                <span className="text-[#16203A]/20 hidden sm:inline">│</span>
                <div className="flex items-center gap-1 shrink-0">
                  <Users className="w-3 h-3 text-blue-400/60" />
                  <span className="text-[#16203A]/60">{monitoring.users}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Activity className="w-3 h-3 text-cyan-400/60" />
                  <span className="text-[#16203A]/60">{monitoring.sessions}<span className="hidden sm:inline">{ko ? '세션' : ' ses'}</span></span>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <FileText className="w-3 h-3 text-[#2B4C7E]/60" />
                  <span className="text-[#16203A]/60">{monitoring.bids.toLocaleString()}<span className="hidden sm:inline">{ko ? '건' : ''}</span></span>
                </div>
                {monitoring.tickets > 0 && (
                  <div className="flex items-center gap-1 shrink-0">
                    <AlertTriangle className="w-3 h-3 text-red-400/60" />
                    <span className="text-red-400">{monitoring.tickets}<span className="hidden sm:inline">{ko ? '티켓' : ' tix'}</span></span>
                  </div>
                )}
                <span className="text-[#16203A]/20 hidden sm:inline">│</span>
                <span className="text-[#16203A]/50 shrink-0 hidden sm:inline">{timeAgo(monitoring.checkedAt)}</span>
              </div>
            </div>
          </div>
        )}

        {/* Submit Feedback Toast */}
        {submitFeedback && (
          <div className="mx-3 sm:mx-5 mb-2 px-4 py-2.5 rounded-xl bg-[#2F7D62]/10 border border-[#2F7D62]/25 text-[#2F7D62] text-sm font-medium animate-pulse">
            {submitFeedback}
          </div>
        )}

        {/* NEW DIRECTIVE FORM */}
        {showNewForm && (
          <div className="px-3 sm:px-5 py-3 border-b border-[#16203A]/8 bg-[#2B4C7E]/[0.02] shrink-0">
            <div className="flex gap-2 mb-2">
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder={ko ? '지시 제목' : 'Title'}
                className="flex-1 bg-[#16203A]/5 text-[#16203A] text-base px-4 py-2.5 rounded-lg border border-[#16203A]/10 outline-none focus:border-[#2B4C7E]/50 focus:ring-1 focus:ring-[#2B4C7E]/20 transition-colors" autoFocus />
              <select value={newPriority} onChange={e => setNewPriority(e.target.value)}
                className="bg-[#16203A]/5 text-[#16203A] text-[17px] px-2 py-2 rounded-lg border border-[#16203A]/10 outline-none">
                <option value="urgent">● Urgent</option><option value="high">● High</option><option value="normal">● Normal</option><option value="low">○ Low</option>
              </select>
            </div>
            <textarea value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder={ko ? '상세 내용' : 'Details'} rows={2}
              className="w-full bg-[#16203A]/5 text-[#16203A] text-sm px-4 py-2.5 rounded-lg border border-[#16203A]/10 outline-none focus:border-[#2B4C7E]/50 focus:ring-1 focus:ring-[#2B4C7E]/20 resize-none mb-2 transition-colors" />
            {newAssignees.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {newAssignees.map(a => (
                  <span key={a.id} className="flex items-center gap-1 bg-[#16203A]/5 rounded px-2 py-1 text-[17px]">
                    <AgentAvatar id={a.id} /> {displayName(a.id, ko ? 'ko' : 'en')}
                    <input value={a.task} onChange={e => setNewAssignees(newAssignees.map(x => x.id === a.id ? { ...x, task: e.target.value } : x))}
                      placeholder={ko ? '업무' : 'task'} className="bg-transparent text-[#2B4C7E] text-[16px] w-16 outline-none" />
                    <button onClick={() => setNewAssignees(newAssignees.filter(x => x.id !== a.id))} className="text-[#16203A]/50 hover:text-red-400">×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2 items-center">
              <div className="relative flex-1">
                <input value={assigneeSearch} onChange={e => setAssigneeSearch(e.target.value)} placeholder={ko ? '+ 담당자 검색' : '+ Search agent'}
                  className="w-full bg-[#16203A]/5 text-[#16203A] text-[17px] px-3 py-1.5 rounded-lg border border-[#16203A]/10 outline-none" />
                {filteredAg.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[#FBFBF8] border border-[#16203A]/10 rounded-lg max-h-24 overflow-y-auto z-10">
                    {filteredAg.slice(0, 5).map(id => (
                      <button key={id} onClick={() => { setNewAssignees([...newAssignees, { id, task: '' }]); setAssigneeSearch(''); }}
                        className="w-full flex items-center gap-2 px-3 py-1 hover:bg-[#16203A]/5 text-left text-[17px]">
                        <AgentAvatar id={id} /> <span className="text-[#16203A]">{displayName(id, ko ? 'ko' : 'en')}</span> <span className="text-[#16203A]/55">{AG[id].dept}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => { setShowNewForm(false); setNewAssignees([]); }} className="text-sm text-[#16203A]/60 hover:text-[#16203A] px-3 py-2 rounded-lg hover:bg-[#16203A]/8 transition-all">{ko ? '취소' : 'Cancel'}</button>
              <button onClick={handleSubmit} disabled={!newTitle.trim()}
                className="px-5 py-2 text-sm bg-[#16203A] hover:bg-[#16203A]/90 active:scale-95 text-white font-bold rounded-xl disabled:opacity-30 disabled:hover:bg-[#16203A] flex items-center gap-1.5 transition-all duration-150 shadow-[0_4px_16px_rgba(22,32,58,0.18)]">
                <Send className="w-3.5 h-3.5" /> {ko ? '지시' : 'Submit'}
              </button>
            </div>
          </div>
        )}

        {/* SCHEDULED OPERATIONS PANEL */}
        {showScheduled && (() => {
          const now = new Date();
          const currentHour = now.getHours();
          const currentMin = now.getMinutes();

          // Find next operation
          const sortedByHour = [...scheduledOps].sort((a, b) => a.hour - b.hour);
          const upcoming = sortedByHour.find(op => op.hour > currentHour || (op.hour === currentHour && parseInt(op.schedule.match(/:(\d{2})/)?.[1] || '0') > currentMin));
          const nextOp = upcoming || sortedByHour[0];
          const nextHour = nextOp?.hour ?? 0;
          const nextMinStr = nextOp?.schedule.match(/:(\d{2})/)?.[1] || '00';
          const nextMin = parseInt(nextMinStr);
          let diffMin = (nextHour * 60 + nextMin) - (currentHour * 60 + currentMin);
          if (diffMin <= 0) diffMin += 24 * 60;
          const diffH = Math.floor(diffMin / 60);
          const diffM = diffMin % 60;
          const nextLabel = nextOp ? `${nextOp.name} in ${diffH}h ${diffM}m` : '';

          const channelColor = (ch: string) => {
            if (ch === 'Telegram') return 'text-blue-400';
            if (ch === 'silent') return 'text-[#16203A]/50';
            if (ch.includes('trading')) return 'text-green-400';
            if (ch.includes('product')) return 'text-cyan-400';
            if (ch.includes('knowledge')) return 'text-[#2B4C7E]';
            if (ch.includes('ai-papers')) return 'text-pink-400';
            if (ch.includes('daily-tracker')) return 'text-orange-400';
            if (ch.includes('strategy')) return 'text-red-400';
            return 'text-[#16203A]/60';
          };

          return (
            <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-[#16203A] font-bold text-sm sm:text-base flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#2B4C7E]" />
                    {ko ? '예약 작업' : 'Scheduled Operations'}
                    <span className="text-[11px] bg-[#2B4C7E]/10 text-[#2B4C7E] px-2 py-0.5 rounded-full font-medium">{scheduledOps.length} {ko ? '활성' : 'active'}</span>
                  </h3>
                  {nextOp && (
                    <p className="text-[11px] sm:text-[12px] text-[#16203A]/55 mt-1">
                      {ko ? '다음' : 'Next'}: <span className="text-[#2B4C7E] font-medium">{nextLabel}</span>
                    </p>
                  )}
                </div>
                <button onClick={() => setShowScheduled(false)} className="text-[#16203A]/55 hover:text-[#16203A] p-1 rounded hover:bg-[#16203A]/8">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4">
                {SCHEDULE_GROUPS.map(group => {
                  const ops = scheduledOps.filter(op => op.hour >= group.min && op.hour < group.max).sort((a, b) => a.hour - b.hour);
                  if (ops.length === 0) return null;
                  return (
                    <div key={group.key}>
                      <h4 className="text-[11px] sm:text-[12px] text-[#16203A]/55 font-medium uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#2B4C7E]/50" />
                        {ko ? group.labelKo : group.label} ({group.range})
                        <span className="text-[#16203A]/50 font-normal">· {ops.length}</span>
                      </h4>
                      <div className="space-y-1">
                        {ops.map(op => (
                          <div key={op.id} className="group/op flex items-center gap-2 sm:gap-3 bg-white border border-[#16203A]/8 rounded-xl px-2.5 sm:px-3 py-2 hover:bg-[#16203A]/[0.02] transition-colors">
                            <div className="shrink-0">
                              {op.agent ? (
                                <AgentAvatar id={op.agent} size="sm" />
                              ) : (
                                <div className="w-5 h-5 rounded-full bg-[#16203A]/10 border border-[#16203A]/10 flex items-center justify-center">
                                  <Clock className="w-3 h-3 text-[#16203A]/60" />
                                </div>
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="text-[#16203A] text-[12px] sm:text-[13px] font-medium truncate">{op.name}</div>
                              <div className="text-[#16203A]/55 text-[10px] sm:text-[11px]">{op.schedule}</div>
                            </div>
                            <span className={`text-[10px] sm:text-[11px] shrink-0 ${channelColor(op.channel)}`}>{op.channel}</span>
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${op.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                            <button onClick={(e) => { e.stopPropagation(); removeScheduledOp(op.id); }}
                              className="shrink-0 text-[#16203A]/50 hover:text-red-400 p-0.5 rounded hover:bg-red-400/10 opacity-0 group-hover/op:opacity-100 transition-opacity"
                              title={ko ? '삭제' : 'Remove'}>
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* MAIN GRID — company-specific content */}
        {!showScheduled && <div className="flex-1 overflow-y-auto px-3 sm:px-5 py-3">
          {activeCompany === 'capital' ? (
            <div className="p-6 text-center text-[#16203A]/55 text-sm">{ko ? '트레이딩 데이터 연동 예정' : 'Trading data integration coming soon'}</div>
          ) : activeCompany === 'saas' ? (
            <div className="p-6 text-center text-[#16203A]/55 text-sm">Connect your SaaS product to see metrics here</div>
          ) : activeCompany.startsWith('user-') ? (
            (() => {
              const uc = COMPANIES.find(c => c.id === activeCompany);
              return uc ? <UserCompanyDashboard company={uc} lang={lang} onClose={onClose} /> : null;
            })()
          ) : loading ? <div className="text-center text-[#16203A]/55 py-10">Loading...</div> : (
            <div className="flex flex-col gap-2 sm:gap-3">

              {/* ROW 1: 지시사항 칸반 보드 — 대기 → 진행 → 완료 */}
              {directives.length > 0 && (
              <div id="directive-pipeline" className="bg-white rounded-2xl border border-[#16203A]/8 p-3 shrink-0 shadow-[0_4px_16px_rgba(22,32,58,0.04)]">
                <h3 className="text-[14px] text-[#2B4C7E] font-bold uppercase tracking-wider mb-3 flex items-center gap-1">
                  <Zap className="w-3 h-3 text-[#2B4C7E]" /> {ko ? '지시사항 진행현황' : 'Directive Pipeline'}
                </h3>

                {/* Mobile: tabs */}
                <div className="sm:hidden">
                  <Tabs value={dirTab} onValueChange={(v) => setDirTab(v as 'pending'|'active'|'done')} className="mb-3">
                    <TabsList className="w-full bg-[#16203A]/5 border border-[#16203A]/8">
                      <TabsTrigger value="pending" className="flex-1 text-[13px] data-[state=active]:bg-amber-500/12 data-[state=active]:text-amber-600">
                        {ko ? '대기' : 'Pending'} {pendingDirs.length}
                      </TabsTrigger>
                      <TabsTrigger value="active" className="flex-1 text-[13px] data-[state=active]:bg-[#3E6BB0]/12 data-[state=active]:text-[#3E6BB0]">
                        {ko ? '진행중' : 'Active'} {activeDirs.length}
                      </TabsTrigger>
                      <TabsTrigger value="done" className="flex-1 text-[13px] data-[state=active]:bg-[#2F7D62]/12 data-[state=active]:text-[#2F7D62]">
                        {ko ? '완료' : 'Done'} {doneDirs.length}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <ScrollArea className="max-h-[40vh]"><div className="space-y-2">
                    {dirTab === 'pending' && (pendingDirs.length === 0
                      ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p>
                      : pendingDirs.map(d => <DirectiveCard key={d.id} d={d} />))}
                    {dirTab === 'active' && (activeDirs.length === 0
                      ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p>
                      : activeDirs.map(d => <DirectiveCard key={d.id} d={d} />))}
                    {dirTab === 'done' && (doneDirs.length === 0
                      ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p>
                      : doneDirs.map(d => <DirectiveCard key={d.id} d={d} done />))}
                  </div></ScrollArea>
                </div>

                {/* Desktop: 3 columns */}
                <div className="hidden sm:grid grid-cols-1 gap-3">
                  <div className="flex flex-col min-h-0">
                    <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-amber-500/20">
                      <span className="w-2 h-2 rounded-full bg-amber-500" />
                      <span className="text-amber-600 text-[15px] font-bold">{ko ? '대기' : 'Pending'}</span>
                      <span className="text-[#16203A]/50 text-[14px]">{pendingDirs.length}</span>
                    </div>
                    <div className="space-y-2 overflow-y-auto flex-1">
                      {pendingDirs.length === 0 ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p> : pendingDirs.map(d => <DirectiveCard key={d.id} d={d} />)}
                    </div>
                  </div>
                  <div className="flex flex-col min-h-0">
                    <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-[#3E6BB0]/20">
                      <span className="w-2 h-2 rounded-full bg-[#3E6BB0] animate-pulse" />
                      <span className="text-[#3E6BB0] text-[15px] font-bold">{ko ? '진행중' : 'In Progress'}</span>
                      <span className="text-[#16203A]/50 text-[14px]">{activeDirs.length}</span>
                    </div>
                    <div className="space-y-2 overflow-y-auto flex-1">
                      {activeDirs.length === 0 ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p> : activeDirs.map(d => <DirectiveCard key={d.id} d={d} />)}
                    </div>
                  </div>
                  <div className="flex flex-col min-h-0">
                    <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-[#2F7D62]/20">
                      <span className="w-2 h-2 rounded-full bg-[#2F7D62]" />
                      <span className="text-[#2F7D62] text-[15px] font-bold">{ko ? '완료' : 'Done'}</span>
                      <span className="text-[#16203A]/50 text-[14px]">{doneDirs.length}</span>
                    </div>
                    <div className="space-y-2 overflow-y-auto flex-1">
                      {doneDirs.length === 0 ? <p className="text-[#16203A]/80 text-[14px] text-center py-4">{ko ? '없음' : 'Empty'}</p> : doneDirs.map(d => <DirectiveCard key={d.id} d={d} done />)}
                    </div>
                  </div>
                </div>
              </div>
              )}

            </div>
          )}
        </div>}


      </div>
  );
}
