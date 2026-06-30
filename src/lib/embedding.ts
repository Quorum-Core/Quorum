/**
 * Cloudflare Workers AI 임베딩 — REST 호출(프런트/백 위치 무관, 토큰만 있으면 됨).
 * 미설정(CF_ACCOUNT_ID/CF_API_TOKEN 부재) 또는 실패 시 null → 호출부는 importance 정렬로 graceful fallback.
 */
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || '';
const CF_API_TOKEN = process.env.CF_API_TOKEN || '';
// bge-m3 = 1024차원·다국어(한국어 교훈 적합). 모델 바꾸면 EMBED_DIM·SQL vector(N)도 같이 변경.
const CF_EMBED_MODEL = process.env.CF_EMBED_MODEL || '@cf/baai/bge-m3';
export const EMBED_DIM = 1024;

export function embeddingEnabled(): boolean {
  return !!(CF_ACCOUNT_ID && CF_API_TOKEN);
}

// 텍스트 1건 → 임베딩 벡터(실패·미설정 시 null).
export async function embed(text: string): Promise<number[] | null> {
  if (!embeddingEnabled() || !text) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${CF_EMBED_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: [text.slice(0, 4000)] }),
        signal: AbortSignal.timeout(8000), // CF 지연이 reflect/회의 종료를 고착시키지 않게(#1)
      },
    );
    if (!res.ok) { console.error('CF embed error:', res.status); return null; }
    const j = (await res.json()) as { result?: { data?: number[][] }; success?: boolean };
    const v = j?.result?.data?.[0];
    return Array.isArray(v) && v.length === EMBED_DIM ? v : null;
  } catch (e) { console.error('CF embed exception:', e); return null; }
}

// pgvector 입력 리터럴 — supabase-js는 vector 타입 자동 직렬화 안 해 '[a,b,c]' 문자열로 전달(RPC는 ::vector 캐스트).
export function toVectorLiteral(v: number[]): string { return `[${v.join(',')}]`; }
