'use client';

import { useState, useEffect } from 'react';
import { Building2, Users, Activity, FileText, MessageSquare, Clock, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Company } from '@/lib/company-registry';
import { displayName } from '@/data/agent-names';

interface Report {
  id: string;
  title: string;
  content: string;
  agent_id: string;
  report_type: string;
  status: string;
  created_at: string;
}

interface Props {
  company: Company;
  lang: 'ko' | 'en';
  onClose?: () => void;
}

const AGENT_META: Record<string, { label: string; labelKo: string }> = {
  lead: { label: 'Strategic Advisory', labelKo: '전략 자문' },
  risk: { label: 'Risk Assessment', labelKo: '리스크 평가' },
  operations: { label: 'Operations', labelKo: '운영 관리' },
  quant: { label: 'Data Analytics', labelKo: '데이터 분석' },
  sales: { label: 'Sales', labelKo: '영업 관리' },
  pr: { label: 'Marketing', labelKo: '마케팅' },
  research: { label: 'SEO & Research', labelKo: 'SEO/리서치' },
  infra: { label: 'Tech Stack', labelKo: '기술 스택' },
  security: { label: 'Security', labelKo: '보안' },
  dev: { label: 'Development', labelKo: '개발' },
  qa: { label: 'QA Testing', labelKo: 'QA 테스트' },
  design: { label: 'Design', labelKo: '디자인' },
  copy: { label: 'Content', labelKo: '콘텐츠' },
  growth: { label: 'Growth', labelKo: '그로스' },
  brand: { label: 'Branding', labelKo: '브랜딩' },
  global: { label: 'Global', labelKo: '글로벌' },
  recruiting: { label: 'HR', labelKo: '인사' },
  monitoring: { label: 'Monitoring', labelKo: '모니터링' },
  trading: { label: 'Trading', labelKo: '트레이딩' },
  hedge: { label: 'Risk Mgmt', labelKo: '리스크 관리' },
  valuation: { label: 'Valuation', labelKo: '기업가치' },
  finance: { label: 'Finance', labelKo: '재무' },
  evaluation: { label: 'Evaluation', labelKo: '평가' },
};

const AGENT_FLOOR: Record<string, number> = {
  lead: 10, strategy: 9, finance: 9, legal: 9, risk: 8, audit: 8,
  design: 7, dev: 7, qa: 7, pr: 6, copy: 6, editor: 6, research: 6,
  growth: 5, brand: 5, support: 5, performance: 5, sales: 5,
  infra: 4, monitoring: 4, security: 4, recruiting: 3, evaluation: 3,
  quant: 2, trading: 2, global: 2, field: 2, hedge: 2, valuation: 2, operations: 1,
};

export default function UserCompanyDashboard({ company, lang, onClose }: Props) {
  const ko = lang === 'ko';
  const [reports, setReports] = useState<Report[]>([]);
  const [chatAgent, setChatAgent] = useState<string | null>(null);

  // Load reports for this company's agents
  useEffect(() => {
    const loadReports = async () => {
                  
      try {
        // reports 라우트는 or= 미지원 → 전체 조회 후 회사 에이전트·연결일 기준 클라이언트 필터
        const res = await fetch('/api/reports?limit=50');
        if (res.ok) {
          const all = await res.json();
          const agentSet = new Set(company.agents);
          const since = company.connectedAt ? new Date(company.connectedAt).getTime() : 0;
          const filtered = (Array.isArray(all) ? all : []).filter((r: { agent_id?: string; created_at?: string }) =>
            agentSet.has(r.agent_id || '') && (!since || new Date(r.created_at || 0).getTime() >= since)
          );
          setReports(filtered.slice(0, 10));
        }
      } catch { /* */ }
    };
    loadReports();
  }, [company.agents, company.connectedAt]);

  // 연결 경과일(표시용 근사값) — 실시간 갱신 불필요. Date.now()는 렌더 시 1회 읽음.
  const nowMs = Date.now(); // eslint-disable-line react-hooks/purity
  const connectedDays = company.connectedAt
    ? Math.floor((nowMs - new Date(company.connectedAt).getTime()) / 86400000)
    : 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Company Header */}
      <div className="bg-white/5 border border-white/10 rounded-xl p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <span className="text-2xl">{company.icon}</span>
              <h2 className="text-xl font-bold text-white">{company.name}</h2>
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                {ko ? '포트폴리오 회사' : 'Portfolio Company'}
              </Badge>
            </div>
            <p className="text-gray-400 text-sm">{ko ? company.descriptionKo : company.description}</p>
            {company.industry && (
              <div className="flex gap-2 mt-2">
                <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">
                  {company.industry}
                </Badge>
                {company.mode === 'manual' && (
                  <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 text-xs">
                    Manual Setup
                  </Badge>
                )}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-amber-400">{company.agents.length}</div>
            <div className="text-xs text-gray-500">{ko ? '배치 에이전트' : 'Agents'}</div>
            <div className="text-xs text-gray-600 mt-1">
              <Clock className="w-3 h-3 inline mr-1" />
              {connectedDays === 0 ? (ko ? '오늘 연결' : 'Connected today') : `D+${connectedDays}`}
            </div>
          </div>
        </div>
      </div>

      {/* Agent Grid */}
      <div>
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <Users className="w-4 h-4 text-blue-400" />
          {ko ? '배치된 에이전트' : 'Deployed Agents'}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {company.agents.map(agentId => {
            const meta = AGENT_META[agentId];
            const isActive = chatAgent === agentId;
            return (
              <button
                key={agentId}
                onClick={() => setChatAgent(isActive ? null : agentId)}
                className={`bg-white/5 border rounded-xl p-3 flex items-center gap-3 transition hover:bg-white/10 ${
                  isActive ? 'border-amber-400/50 bg-amber-400/5' : 'border-white/10'
                }`}
              >
                <div className="w-10 h-10 rounded-full bg-white/10 shrink-0 flex items-center justify-center text-white/70 text-sm font-semibold uppercase">
                  {displayName(agentId, 'ko').charAt(0)}
                </div>
                <div className="text-left min-w-0">
                  <div className="text-white text-sm font-medium capitalize">{agentId}</div>
                  <div className="text-gray-500 text-xs truncate">
                    {meta ? (ko ? meta.labelKo : meta.label) : 'Agent'}
                  </div>
                </div>
                <Activity className="w-3 h-3 text-emerald-400 ml-auto shrink-0" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Navigate to agent chat */}
      {chatAgent && (
        <div className="bg-white/5 border border-amber-400/20 rounded-xl p-4 text-center">
          <div className="flex items-center justify-center gap-2 mb-3">
            <MessageSquare className="w-4 h-4 text-amber-400" />
            <span className="text-white font-medium capitalize">{chatAgent}</span>
          </div>
          <p className="text-gray-400 text-sm mb-4">
            {ko
              ? `${chatAgent}와 대화하려면 홈에서 직접 만나세요!`
              : `Visit ${chatAgent} on the home screen for a full conversation!`}
          </p>
          <button
            onClick={() => {
              const agentFloor = AGENT_FLOOR[chatAgent] || 1;
              onClose?.();
              setTimeout(() => {
                window.dispatchEvent(new CustomEvent('quorum-navigate', { 
                  detail: { view: 'floor', floor: agentFloor, agent: chatAgent } 
                }));
              }, 200);
            }}
            className="px-6 py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-sm rounded-xl transition-all duration-200 inline-flex items-center gap-2"
          >
            <Building2 className="w-4 h-4" />
            {ko ? '홈에서 대화하기' : 'Chat on home'}
          </button>
        </div>
      )}

      {/* Reports from Company Agents */}
      <div>
        <h3 className="text-white font-semibold mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4 text-emerald-400" />
          {ko ? '에이전트 리포트' : 'Agent Reports'}
          {reports.length > 0 && (
            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
              {reports.length}
            </Badge>
          )}
        </h3>
        {reports.length === 0 ? (
          <div className="bg-white/5 border border-white/10 rounded-xl p-8 text-center">
            <Zap className="w-8 h-8 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-500 text-sm">
              {ko ? '에이전트가 분석 중입니다. 첫 리포트가 곧 도착합니다.' : 'Agents are analyzing. First reports arriving soon.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map(r => (
              <div key={r.id} className="bg-white/5 border border-white/10 rounded-xl p-4">
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center text-white/70 text-[10px] font-semibold uppercase">
                      {displayName(r.agent_id, 'ko').charAt(0)}
                    </div>
                    <span className="text-white font-medium text-sm capitalize">{r.agent_id}</span>
                    <Badge className={`text-xs ${
                      r.report_type === 'onboarding' ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' :
                      r.status === 'approved' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                      'bg-amber-500/20 text-amber-400 border-amber-500/30'
                    }`}>
                      {r.report_type === 'onboarding' ? 'Onboarding' : r.status}
                    </Badge>
                  </div>
                  <span className="text-gray-600 text-xs">
                    {new Date(r.created_at).toLocaleDateString()}
                  </span>
                </div>
                <h4 className="text-white text-sm font-medium mb-1">{r.title}</h4>
                <p className="text-gray-400 text-xs whitespace-pre-wrap line-clamp-4">{r.content}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
