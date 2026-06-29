'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Lang, t } from '@/data/i18n';

type TextMap = Record<string, string>;

interface LangContextType {
  lang: Lang;
  setLang: (lang: Lang) => void;
  text: TextMap;
}

const LangContext = createContext<LangContextType>({
  lang: 'ko',
  setLang: () => {},
  text: t.ko as unknown as TextMap,
});

export function LangProvider({ children }: { children: ReactNode }) {
  // 기본 ko (프리렌더/첫 페인트 일관). 저장된 선택이 있으면 마운트 후 반영.
  const [lang, setLangState] = useState<Lang>('ko');

  // localStorage는 SSR에서 못 읽으므로 마운트 후 1회 저장된 언어 반영(첫 페인트는 ko 고정).
  useEffect(() => {
    try {
      const saved = localStorage.getItem('quorum-lang');
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved === 'ko' || saved === 'en') setLangState(saved);
    } catch {
      /* noop */
    }
  }, []);

  const setLang = (l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('quorum-lang', l); } catch { /* noop */ }
  };

  return (
    <LangContext.Provider value={{ lang, setLang, text: t[lang] as unknown as TextMap }}>
      {children}
    </LangContext.Provider>
  );
}

export function useLang() {
  return useContext(LangContext);
}
