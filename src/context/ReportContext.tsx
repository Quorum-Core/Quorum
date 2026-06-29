'use client';

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react';

// Agent → department/floor mapping
const AGENT_DEPT: Record<string, { department: string; floor: number }> = {
  lead: { department: "Chief of Staff", floor: 10 },
  strategy: { department: 'Planning & Coordination', floor: 9 },
  finance: { department: 'Planning & Coordination', floor: 9 },
  legal: { department: 'Planning & Coordination', floor: 9 },
  risk: { department: 'Risk Challenge', floor: 8 },
  audit: { department: 'Audit', floor: 8 },
  design: { department: 'Software Development', floor: 7 },
  dev: { department: 'Software Development', floor: 7 },
  qa: { department: 'Software Development', floor: 7 },
  pr: { department: 'Content Division', floor: 6 },
  copy: { department: 'Content Division', floor: 6 },
  editor: { department: 'Content Division', floor: 6 },
  research: { department: 'Content Division', floor: 6 },
  growth: { department: 'Marketing Division', floor: 5 },
  infra: { department: 'ICT Division', floor: 4 },
  monitoring: { department: 'ICT Division', floor: 4 },
  security: { department: 'ICT Division', floor: 4 },
  quant: { department: 'Quorum Capital', floor: 2 },
  trading: { department: 'Quorum Capital', floor: 2 },
  operations: { department: 'Quorum SaaS', floor: 1 },
};

export interface Report {
  id: string;
  title: string;
  department: string;
  floor: number;
  timestamp: number;
  type: 'simulation' | 'meeting' | 'research';
  priority: 'high' | 'medium' | 'low';
  read: boolean;
  summary: string;
  content: string;
  actions?: string[];
  agentId?: string;
}

interface ReportContextType {
  reports: Report[];
  addReport: (report: Omit<Report, 'id' | 'timestamp' | 'read'>) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  unreadCount: number;
  getUnreadReports: () => Report[];
}

const ReportContext = createContext<ReportContextType>({
  reports: [],
  addReport: () => {},
  markRead: () => {},
  markAllRead: () => {},
  unreadCount: 0,
  getUnreadReports: () => [],
});

// /api/reports 원시 행(서버 컬럼명) — UI Report로 매핑 전 형태.
type RawReportRow = {
  id?: string | number; agent_id?: string; department?: string; priority?: string;
  title?: string; created_at?: string | number; report_type?: string; status?: string; content?: string;
};

export function ReportProvider({ children }: { children: ReactNode }) {
  const [reports, setReports] = useState<Report[]>([]);

  // Fetch reports from local API on mount
  useEffect(() => {
    fetch('/api/reports?limit=50')
      .then(r => r.json())
      .then((data: RawReportRow[]) => {
        if (!Array.isArray(data)) return;
        const mapped: Report[] = data.map(r => {
          const dept = AGENT_DEPT[r.agent_id || ''] || { department: r.department || 'Unknown', floor: 1 };
          const pri = r.priority === 'urgent' ? 'high' : r.priority === 'high' ? 'high' : r.priority === 'low' ? 'low' : 'medium';
          return {
            id: r.id?.toString() || `rpt-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
            title: r.title || 'Report',
            department: dept.department,
            floor: dept.floor,
            timestamp: new Date(r.created_at || Date.now()).getTime(),
            type: r.report_type === 'meeting' ? 'meeting' as const : r.report_type === 'research' ? 'research' as const : 'simulation' as const,
            priority: pri as 'high' | 'medium' | 'low',
            read: r.status === 'read' || r.status === 'approved',
            summary: (r.content || '').slice(0, 120) + ((r.content?.length ?? 0) > 120 ? '…' : ''),
            content: r.content || '',
            agentId: r.agent_id || '',
          };
        });
        setReports(prev => {
          // Merge: API reports + any locally added
          const ids = new Set(mapped.map(m => m.id));
          const local = prev.filter(p => !ids.has(p.id));
          return [...mapped, ...local];
        });
      })
      .catch(() => {});
  }, []);

  const addReport = useCallback((report: Omit<Report, 'id' | 'timestamp' | 'read'>) => {
    const newReport: Report = {
      ...report,
      id: `rpt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      read: false,
    };
    setReports(prev => [newReport, ...prev]);
  }, []);

  const markRead = useCallback((id: string) => {
    setReports(prev => prev.map(r => r.id === id ? { ...r, read: true } : r));
  }, []);

  const markAllRead = useCallback(() => {
    setReports(prev => prev.map(r => ({ ...r, read: true })));
  }, []);

  const unreadCount = reports.filter(r => !r.read).length;

  const getUnreadReports = useCallback(() => {
    return reports.filter(r => !r.read);
  }, [reports]);

  return (
    <ReportContext.Provider value={{ reports, addReport, markRead, markAllRead, unreadCount, getUnreadReports }}>
      {children}
    </ReportContext.Provider>
  );
}

export function useReports() {
  return useContext(ReportContext);
}
