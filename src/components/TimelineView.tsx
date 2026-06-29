'use client';

import { useState, useEffect, useMemo, ReactNode } from 'react';
import { Zap, FileText, TrendingUp, ClipboardList, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { AGENT_ROSTER } from '@/data/agent-config';
import { Lang } from '@/data/i18n';
import { cleanMarkdown, localizeText, RenderMarkdown } from '@/lib/format-markdown';
import { displayName } from '@/data/agent-names';

interface TimelineEvent {
  id: string;
  time: string;
  type: 'decision' | 'report' | 'meeting' | 'directive';
  agentId: string;
  title: string;
  detail?: string;
  status?: string;
  priority?: string;
  raw?: string; // 회의 복원용 — 저장된 대화 JSON
}

type DecisionRow = {
  id: string;
  title: string;
  updated_at?: string;
  created_at: string;
  current_assignee?: string;
  status?: string;
  priority?: string;
};
type ReportRow = {
  id: string;
  agent_id: string;
  title: string;
  report_type?: string;
  status?: string;
  created_at: string;
  content?: string;
};
const TYPE_STYLE: Record<string, { icon: string; color: string; border: string }> = {
  decision: { icon: 'zap', color: 'text-[#2B4C7E]', border: 'border-[#2B4C7E]/30' },
  report: { icon: 'file', color: 'text-blue-400', border: 'border-blue-400/30' },
  meeting: { icon: 'users', color: 'text-purple-400', border: 'border-purple-400/30' },
  directive: { icon: 'clipboard', color: 'text-red-400', border: 'border-red-400/30' },
};

import { Users } from 'lucide-react';

const ICON_MAP: Record<string, ReactNode> = {
  zap: <Zap className="w-3 h-3 inline" />,
  file: <FileText className="w-3 h-3 inline" />,
  users: <Users className="w-3 h-3 inline" />,
  clipboard: <ClipboardList className="w-3 h-3 inline" />,
  trending: <TrendingUp className="w-3 h-3 inline" />,
};
const renderIcon = (key: string) => ICON_MAP[key] || null;

const AG: Record<string, { image: string; name: string }> = {};
AGENT_ROSTER.forEach(a => { AG[a.id] = { image: '', name: a.name }; });
AG['chairman'] = { image: '', name: '사용자' };


function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate(ts: string, ko: boolean): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (d.toDateString() === today.toDateString()) return ko ? '오늘' : 'Today';
  if (d.toDateString() === yesterday.toDateString()) return ko ? '어제' : 'Yesterday';
  return d.toLocaleDateString(ko ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric' });
}

interface Props {
  open: boolean;
  onClose: () => void;
  lang?: Lang;
  onOpenAgenda?: (title: string) => void;
  onOpenMeeting?: (raw: string) => void; // 저장된 회의 복원(LLM 재호출 없음)
}

export default function TimelineView({ open, onClose, lang = 'ko', onOpenAgenda, onOpenMeeting }: Props) {
  const ko = lang === 'ko';

  const deleteEvent = async (id: string) => {
    const m = id.match(/^(dir|d|r|m)-(.+)$/);
    if (!m) return;
    const [, prefix, raw] = m;
    setEvents((prev) => prev.filter((e) => e.id !== id)); // 낙관적 제거
    try {
      if (prefix === 'd') {
        // decision — 소프트 딜리트(status='deleted', 로드 시 필터)
        await fetch('/api/decisions', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: raw, status: 'deleted' }),
        });
      } else {
        // report/meeting/directive — reports 테이블 행 삭제(status CHECK 제약으로 소프트딜리트 불가)
        await fetch(`/api/reports?id=${encodeURIComponent(raw)}`, { method: 'DELETE' });
      }
    } catch { /* noop */ }
  };
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [reportView, setReportView] = useState<{ title: string; content: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadTimeline = async () => {
      await Promise.resolve();
      if (cancelled) return;
      setLoading(true);
    

      Promise.all([
      // Decisions
      fetch('/api/decisions?select=id,title,status,type,priority,current_assignee,created_at,updated_at&order=updated_at.desc&limit=50')
        .then(r => r.json()).catch(() => []),
      // Reports
      fetch('/api/reports?report_type=neq.health_check&select=id,agent_id,title,report_type,status,content,created_at&order=created_at.desc&limit=50')
        .then(r => r.json()).catch(() => []),
      ]).then(([decisionPayload, reports]) => {
        if (cancelled) return;
      const allEvents: TimelineEvent[] = [];
      // Ensure arrays (API might return error objects)
      const decisions = Array.isArray(decisionPayload) ? decisionPayload : decisionPayload?.decisions;
      const safeDecisions = (Array.isArray(decisions) ? decisions : []) as DecisionRow[];
      const safeReports = (Array.isArray(reports) ? reports : []) as ReportRow[];

      safeDecisions.forEach((d) => {
        if (d.status === 'deleted') return; // 소프트 딜리트 제외
        allEvents.push({
          id: `d-${d.id}`,
          time: d.updated_at || d.created_at,
          type: 'decision',
          agentId: d.current_assignee || 'strategy',
          title: d.title,
          status: d.status,
          priority: d.priority,
        });
      });

      safeReports.forEach((r) => {
        if (r.report_type === 'directive') {
          allEvents.push({
            id: `dir-${r.id}`,
            time: r.created_at,
            type: 'directive',
            agentId: r.agent_id || 'chairman',
            title: r.title,
            status: r.status,
          });
        } else if (r.report_type === 'meeting') {
          allEvents.push({
            id: `m-${r.id}`,
            time: r.created_at,
            type: 'meeting',
            agentId: r.agent_id || 'lead',
            title: r.title,
            raw: r.content,
          });
        } else {
          allEvents.push({
            id: `r-${r.id}`,
            time: r.created_at,
            type: 'report',
            agentId: r.agent_id,
            title: r.title,
            raw: r.content, // 보고서 내용 — 클릭 시 모달 표시
          });
        }
      });

      allEvents.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setEvents(allEvents);
      setLoading(false);
      }).catch((err) => {
        if (cancelled) return;
        console.error('Timeline fetch error:', err);
        setLoading(false);
      });
    };
    loadTimeline();
    return () => { cancelled = true; };
  }, [open]);

  // Group by date
  const grouped = useMemo(() => {
    const groups: Record<string, TimelineEvent[]> = {};
    events.forEach(e => {
      const date = formatDate(e.time, ko);
      if (!groups[date]) groups[date] = [];
      groups[date].push(e);
    });
    return groups;
  }, [events, ko]);

  // 저장된 회의 lookup — 안건 정규화 후 부분일치(접두 흔한 어미 차이 허용). 회의 외 항목도 매칭 시 복원.
  const normAgenda = (s: string) => cleanMarkdown(s || '').replace(/^\[회의\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const savedMeetings = useMemo(() => {
    const list: { key: string; raw: string }[] = [];
    events.forEach(e => { if (e.type === 'meeting' && e.raw) { const k = normAgenda(e.title); if (k) list.push({ key: k, raw: e.raw }); } });
    return list;
  }, [events]);
  const findSavedMeeting = (title: string): string | null => {
    const k = normAgenda(title);
    if (!k) return null;
    // 정확 일치 우선, 없으면 한쪽이 다른 쪽을 포함(4자 이상)할 때 매칭
    const exact = savedMeetings.find(m => m.key === k);
    if (exact) return exact.raw;
    const part = savedMeetings.find(m => (m.key.length >= 4 && k.includes(m.key)) || (k.length >= 4 && m.key.includes(k)));
    return part ? part.raw : null;
  };
  const openEvent = (event: TimelineEvent) => {
    // 보고서(directive 실행 결과 등) — 내용을 모달로 표시
    if (event.type === 'report' && event.raw) { setReportView({ title: event.title, content: event.raw }); return; }
    // 타임라인은 열람 전용 — 저장된 회의만 복원하고 LLM을 새로 호출하지 않음
    if (event.type === 'meeting' && event.raw && onOpenMeeting) { onOpenMeeting(event.raw); return; }
    const saved = onOpenMeeting ? findSavedMeeting(event.title) : null;
    if (saved && onOpenMeeting) { onOpenMeeting(saved); return; }
    // 저장본 없음: 새 회의를 LLM으로 실행하던 폴백 제거(원치 않는 재호출 방지)
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#16203A]/8 backdrop-blur-sm">
      <div className="relative w-full h-full sm:w-[96vw] sm:h-[94vh] sm:max-w-[1400px] bg-[#FBFBF8]/98 sm:border sm:border-[#16203A]/10 rounded-none sm:rounded-2xl overflow-hidden flex flex-col">
        
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3 border-b border-[#16203A]/8">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="text-base sm:text-lg"></span>
            <h2 className="text-[#16203A]/90 text-xs sm:text-[15px] font-medium">{ko ? '활동 타임라인' : 'Activity Timeline'}</h2>
            <Badge variant="outline" className="text-[8px] sm:text-[10px] border-[#16203A]/10 text-[#16203A]/40">
              {events.length} {ko ? '건' : 'events'}
            </Badge>
          </div>
          <button onClick={onClose} className="text-[#16203A]/40 hover:text-[#16203A] text-lg sm:text-xl"><X className="w-5 h-5" /></button>
        </div>

        {/* Timeline content */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-3 py-3 sm:px-4 sm:py-4 w-full">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <div className="animate-spin w-6 h-6 border-2 border-[#16203A]/15 border-t-[#2B4C7E] rounded-full" />
              </div>
            ) : Object.entries(grouped).length === 0 ? (
              <p className="text-center text-[#16203A]/30 py-20">{ko ? '이벤트가 없습니다' : 'No events found'}</p>
            ) : (
              Object.entries(grouped).map(([date, dayEvents]) => (
                <div key={date} className="mb-4 sm:mb-6">
                  {/* Date header */}
                  <div className="flex items-center gap-2 sm:gap-3 mb-2 sm:mb-3">
                    <span className="text-xs sm:text-[13px] font-bold text-[#16203A]/60">{date}</span>
                    <div className="flex-1 h-px bg-[#16203A]/5" />
                    <Badge variant="outline" className="text-[8px] sm:text-[10px] border-[#16203A]/10 text-[#16203A]/30">
                      {dayEvents.length}
                    </Badge>
                  </div>

                  {/* Events */}
                  <div className="relative ml-2 sm:ml-4 border-l border-[#16203A]/10">
                    {dayEvents.map((event) => {
                      const style = TYPE_STYLE[event.type] || TYPE_STYLE.report;

                      return (
                        <div key={event.id} className="relative pl-4 sm:pl-6 pb-3 sm:pb-4 last:pb-0 group">
                          {/* Timeline dot */}
                          <div className={`absolute -left-[4px] sm:-left-[5px] top-1 sm:top-1.5 w-[8px] h-[8px] sm:w-[10px] sm:h-[10px] rounded-full border-2 ${style.border} bg-[#FBFBF8] group-hover:scale-125 transition-transform`} />
                          
                          {/* 삭제 — 항상 표시, 우측 세로 중앙 */}
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteEvent(event.id); }}
                            className="absolute right-2.5 sm:right-3 top-2 sm:top-2.5 z-10 w-6 h-6 flex items-center justify-center rounded-full text-[#16203A]/25 opacity-0 group-hover:opacity-100 hover:text-[#c0392b] hover:bg-[#16203A]/5 transition"
                            title={ko ? '삭제' : 'Delete'}
                          >
                            <X className="w-4 h-4" />
                          </button>
                          {/* Event card */}
                          <Card
                            onClick={() => openEvent(event)}
                            className={`bg-white/[0.02] border-[#16203A]/8 hover:border-[#16203A]/10 hover:bg-white/[0.04] transition-all p-2 sm:p-3 ${onOpenAgenda ? 'cursor-pointer' : ''}`}
                          >
                            <div className="flex items-start gap-2 sm:gap-3 pr-7 sm:pr-8">
                              {/* Agent avatar */}
                              <div className="w-6 h-6 sm:w-8 sm:h-8 rounded-full shrink-0 flex items-center justify-center text-[10px] sm:text-xs font-bold text-white bg-[#16203A]">{displayName(event.agentId, lang === 'en' ? 'en' : 'ko')?.[0] || '?'}</div>
                              
                              <div className="flex-1 min-w-0">
                                {/* Top row: agent + type + time */}
                                <div className="flex items-center gap-1.5 sm:gap-2 mb-0.5 sm:mb-1">
                                  <span className="text-[10px] sm:text-[12px] font-medium text-[#16203A]/70">{displayName(event.agentId, lang === 'en' ? 'en' : 'ko')}</span>
                                  <Badge variant="outline" className={`text-[7px] sm:text-[9px] px-1 py-0 sm:px-1.5 sm:py-0 border-0 ${style.color} bg-[#16203A]/5`}>
                                    {renderIcon(style.icon)} {event.type}
                                  </Badge>
                                  {event.status && (
                                    <Badge variant="outline" className="text-[7px] sm:text-[9px] px-1 py-0 sm:px-1.5 sm:py-0 border-[#16203A]/10 text-[#16203A]/40">
                                      {event.status}
                                    </Badge>
                                  )}
                                  <span className="text-[8px] sm:text-[10px] text-[#16203A]/30 ml-auto shrink-0">{formatTime(event.time)}</span>
                                </div>
                                
                                {/* Title */}
                                <p className="text-[11px] sm:text-[13px] text-[#16203A]/80 leading-snug line-clamp-2">{localizeText(cleanMarkdown(event.title), lang)}</p>
                                
                                {event.detail && (
                                  <p className="text-[9px] sm:text-[11px] text-[#16203A]/30 mt-0.5 sm:mt-1">{event.detail}</p>
                                )}
                              </div>
                            </div>
                          </Card>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* 보고서 내용 모달 */}
      {reportView && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setReportView(null)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-[#16203A]/8 flex items-center justify-between shrink-0">
              <h3 className="text-[#16203A] font-bold text-sm truncate">{localizeText(cleanMarkdown(reportView.title), lang)}</h3>
              <button onClick={() => setReportView(null)} className="text-[#16203A]/40 hover:text-[#16203A] p-1"><X className="w-5 h-5" /></button>
            </div>
            <div className="overflow-y-auto px-4 py-3 text-[13px] text-[#16203A]/85 leading-relaxed">
              <RenderMarkdown text={localizeText(reportView.content || '', lang)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
