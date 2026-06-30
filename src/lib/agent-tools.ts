import { evaluate } from 'mathjs';
import { untrustedBlock } from '@/lib/untrusted';
import { getMcpToolSpecs, isMcpToolName, callMcpTool } from '@/lib/mcp-client';

export const TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '실시간 웹 검색. 최신 시장·뉴스·통계·경쟁사 정보가 필요할 때 사용.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '검색어(한국어/영어)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: '수식 계산. 수익률·비중·통계 등 정확한 수치가 필요할 때 사용.',
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: 'mathjs 산술식. 예 "0.3*1.05-0.15". 주의: "50%"는 0.5로 해석됨(퍼센트는 소수로 직접 쓰는 게 안전).' },
        },
        required: ['expr'],
      },
    },
  },
];

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
};

// NFKC 정규화 + format 제어문자(zero-width·word-joiner·soft-hyphen 등) 제거 → 우회 차단용 정규화.
export function normalizeForScan(s: unknown): string {
  return String(s ?? '').normalize('NFKC').replace(/\p{Cf}/gu, '');
}

// secret으로 명명된 인자 key — 값이 비어있지 않으면 fail-closed(#57: 짧은 값이라 패턴 미매치여도 차단).
const SECRET_KEY_NAME = /^\s*(api[_-]?key|secret(_key)?|password|passwd|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|auth[_-]?token|credentials?|private[_-]?key)\s*$/i;

// 실제 키·토큰 "값"만 탐지(일반 보안 키워드 "api key rotation" 등은 허용 — 오탐 최소화).
// MCP 포함 모든 도구 인자를 호출 전 스캔해, 회의 로그의 비밀이 외부 도구로 유출되는 것을 차단.
export function containsSecret(value: unknown): boolean {
  const q = normalizeForScan(value);
  if (!q) return false;
  return (
    /sk-or-v1-[a-z0-9]/i.test(q) || /sk-proj-[a-z0-9]/i.test(q) ||
    /\bsk-[a-z0-9]{20,}/i.test(q) || /\btvly-[a-z0-9]{8,}/i.test(q) ||
    /bearer\s+[A-Za-z0-9._-]{16,}/i.test(q) ||
    /\bapi[_-]?key\s*[:=]\s*\S/i.test(q) ||
    // 알려진 토큰 prefix(#57)
    /\b(AKIA|ASIA)[A-Z0-9]{16}\b/.test(q) ||
    /\bghp_[A-Za-z0-9]{20,}/.test(q) || /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(q) ||
    /\bxox[baprs]-[A-Za-z0-9-]{10,}/i.test(q) ||
    /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/.test(q) ||
    /\bAIza[A-Za-z0-9_-]{30,}/.test(q) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(q) ||
    /\b[A-Fa-f0-9]{40,}\b/.test(q) ||
    /\b[A-Za-z0-9+/]{40,}={0,2}/.test(q)
  );
}

// 도구 인자(중첩 객체/배열 포함)를 재귀 스캔. 깊이 제한으로 순환/폭주 방어.
export function scanArgsForSecret(args: unknown, depth = 0): boolean {
  if (args == null) return false;
  if (depth > 6) return true;  // 과도 중첩 = 스캔 불가 → fail-closed(깊은 곳에 비밀값 은닉 차단, #4)
  if (typeof args === 'string') return containsSecret(args);
  if (typeof args === 'number' || typeof args === 'boolean') return false;
  if (Array.isArray(args)) return args.some((v) => scanArgsForSecret(v, depth + 1));
  if (typeof args === 'object') {
    // 키·값 둘 다 스캔(비밀값이 객체 키로 들어오는 우회 차단) + secret 명명 key는 값 존재 시 fail-closed(#57).
    return Object.entries(args as Record<string, unknown>).some(
      ([k, v]) => (SECRET_KEY_NAME.test(k) && typeof v === 'string' && v.trim().length > 0)
        || containsSecret(k) || scanArgsForSecret(v, depth + 1)
    );
  }
  return false;
}

// 정적 도구 + MCP curated 도구 병합(미설정이면 정적만 — dormant).
export function getToolSpecs(): unknown[] {
  return [...TOOL_SPECS, ...getMcpToolSpecs()];
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  // 모든 도구 공통: 인자에 비밀값(키/토큰) 포함 시 호출 전 거부(web_search·calculate·MCP 공통 게이트).
  if (scanArgsForSecret(args)) return '도구 호출 거부: API 키·토큰 등 비밀값 포함 가능 인자';

  if (isMcpToolName(name)) return callMcpTool(name, args);

  if (name === 'web_search') {
    if (!process.env.TAVILY_API_KEY) return '검색 불가: TAVILY_API_KEY 미설정';

    // 쿼리 길이 제한 + 정규화(도구 진입부 스캔에서 이미 비밀값은 거부됨)
    const raw = String(args.query ?? '').slice(0, 300).trim();
    if (!raw) return '검색 불가: 빈 쿼리';
    const q = normalizeForScan(raw);

    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({ query: q, max_results: 5 }),
        signal: AbortSignal.timeout(12000), // 회의 루프가 Tavily 행에 무한 대기하지 않도록
      });

      if (!r.ok) return `검색 실패(status ${r.status}) — 키/쿼터 확인`;

      const d = await r.json();
      const results = (d.results || []) as TavilyResult[];
      if (!results.length) return '검색 결과 없음';

      const body = results
        .map((x) => `- ${x.title || '제목 없음'} (${x.url || 'URL 없음'})\n  ${x.content || ''}`)
        .join('\n')
        .slice(0, 2000);
      // 외부 검색 결과 = 비신뢰. 그 안의 "지시"를 모델이 명령으로 오인하지 않게 래핑.
      return untrustedBlock('UNTRUSTED_WEB_SEARCH_RESULTS', body);
    } catch {
      return '검색 실패: timeout 또는 네트워크 오류';
    }
  }

  if (name === 'calculate') {
    const expr = String(args.expr ?? '');
    if (expr.length > 200) return '수식이 너무 깁니다(200자 제한)';
    if (!/^[\d\s+\-*/().%]+$/.test(expr)) {
      return '허용되지 않은 문자입니다. 숫자와 + - * / ( ) . % 만 가능';
    }
    try {
      const v = evaluate(expr);
      return typeof v === 'number' && Number.isFinite(v) ? String(v) : '계산 결과 비정상';
    } catch {
      return '계산 오류';
    }
  }

  return '알 수 없는 도구';
}
