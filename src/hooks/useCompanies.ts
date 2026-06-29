'use client';

import { useState, useEffect, useCallback } from 'react';
import { Company, buildCompanyList, loadUserCompany } from '@/lib/company-registry';

export function useCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isMulti, setIsMulti] = useState(false);
  const [defaultId, setDefaultId] = useState('holdings');
  const [userCompany, setUserCompany] = useState<Company | null>(null);

  const refresh = useCallback(() => {
    const uc = loadUserCompany();
    setUserCompany(uc);
    const result = buildCompanyList(uc);
    setCompanies(result.companies);
    setIsMulti(result.isMulti);
    setDefaultId(result.defaultId);
  }, []);

  useEffect(() => {
    // 마운트 시 localStorage 기반 회사 목록 1회 로드(SSR 불가) + 변경 이벤트 구독.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();

    // Listen for company connection changes
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'quorum-company-connection') refresh();
    };
    window.addEventListener('storage', handleStorage);

    // Custom event for same-tab updates
    const handleCustom = () => refresh();
    window.addEventListener('quorum-company-updated', handleCustom);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('quorum-company-updated', handleCustom);
    };
  }, [refresh]);

  return {
    companies,
    isMulti,
    defaultId,
    userCompany,
    refresh,
    getCompany: (id: string) => companies.find(c => c.id === id),
    getCompanyByAgent: (agentId: string) => companies.find(c => c.agents.includes(agentId)),
  };
}
