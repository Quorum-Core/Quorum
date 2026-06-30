// 공용 OpenRouter 호출. chat/meeting/simulate 공통.
// agent-tools(mathjs 포함)는 도구 경로에서만 동적 import — 도구 안 쓰는 경로 콜드스타트/번들 영향 제거.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
// 모델 고정 — 폴백 없이 단일 모델만 사용. 기본 모델 상수는 라우트들이 공용으로 import.
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-120b';
const CHAIN = [OPENROUTER_MODEL];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_HEADERS = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
  'HTTP-Referer': 'https://quorum.app',
  'X-Title': 'Quorum',
};

export function hasOpenRouter(): boolean {
  return !!OPENROUTER_API_KEY;
}

/** {reply} 또는 {error}(UI/보고서 표시용 상세 메시지). chat·directive-execute 공용 — 인라인 복제 제거. */
export type LLMResult = { reply: string } | { error: string };
export async function callOpenRouterDetailed(
  system: string,
  user: string,
  opts?: { maxTokens?: number; model?: string; maxRetries?: number; history?: Array<{ role: string; content: string }> },
): Promise<LLMResult> {
  if (!OPENROUTER_API_KEY) return { error: 'OPENROUTER_API_KEY 미설정 (런타임 변수/비밀에 추가 필요)' };
  const maxTokens = opts?.maxTokens ?? 2000;
  const MAX = opts?.maxRetries ?? 6;
  const mdl = opts?.model || OPENROUTER_MODEL;
  const hist = (opts?.history || []).slice(-10).map((h) => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content }));
  const messages = [{ role: 'system', content: system }, ...hist, { role: 'user', content: user }];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  let lastError = '';
  for (let attempt = 0; attempt < MAX; attempt++) {
    try {
      const r = await fetch(OPENROUTER_URL, {
        method: 'POST', headers: OPENROUTER_HEADERS,
        body: JSON.stringify({ model: mdl, messages, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(45000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const detail = d?.error?.message || JSON.stringify(d).slice(0, 200);
        lastError = `OpenRouter ${r.status} (${mdl}): ${detail}`;
        if (r.status === 401 || r.status === 402 || r.status === 403) return { error: lastError };
        if ((r.status === 429 || r.status >= 500) && attempt < MAX - 1) { await sleep(1500 * (attempt + 1) + Math.floor(Math.random() * 500)); continue; }
        break;
      }
      const reply = d.choices?.[0]?.message?.content;
      if (reply) return { reply };
      lastError = `OpenRouter 빈 응답 (${mdl})`;
      if (attempt < MAX - 1) { await sleep(1500 * (attempt + 1)); continue; }
      break;
    } catch (e) {
      lastError = `OpenRouter 호출 실패 (${mdl}): ${String(e).slice(0, 150)}`;
      if (attempt < MAX - 1) { await sleep(1500 * (attempt + 1)); continue; }
    }
  }
  return { error: lastError || 'OpenRouter 호출 실패' };
}

/** system+user 단발 호출. 실패 시 null. model 미지정 시 기본 모델. maxRetries로 재시도 횟수 조절(free 빠른 실패용). */
export async function callOpenRouter(system: string, user: string, maxTokens = 500, model?: string, maxRetries?: number): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const MAX = maxRetries ?? 6; // 기본 6회. free 모델은 1~2회로 빠르게 끊고 유료 fallback.
  const chain = model ? [model] : CHAIN;
  for (const model of chain) {
    for (let attempt = 0; attempt < MAX; attempt++) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://quorum.app',
            'X-Title': 'Quorum',
          },
          body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
          signal: AbortSignal.timeout(45000),
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 402 || r.status === 403) return null;
          if ((r.status === 429 || r.status >= 500) && attempt < MAX - 1) { await sleep(2500 * (attempt + 1) + Math.floor(Math.random() * 600)); continue; }
          break;
        }
        const d = await r.json();
        const reply = d.choices?.[0]?.message?.content;
        if (reply) return reply;
        // 빈 content(reasoning-only 등)도 재시도 가치 있음
        if (attempt < MAX - 1) { await sleep(2000 * (attempt + 1)); continue; }
        break;
      } catch {
        if (attempt < MAX - 1) { await sleep(2500 * (attempt + 1)); continue; }
      }
    }
  }
  return null;
}

type ToolCall = {
  id: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

type OpenRouterMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export async function callOpenRouterWithTools(
  system: string,
  user: string,
  maxTokens = 2000,
  model?: string,
  onToolUse?: (toolName: string) => void,  // 도구 실행 시 도구명 전달(provenance 추적, #1/#31)
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null;
  const { getToolSpecs, runTool } = await import('@/lib/agent-tools'); // 도구 경로에서만 mathjs 로드
  const TOOL_SPECS = getToolSpecs(); // 정적 + MCP curated(미설정이면 정적만)
  const mdl = model || OPENROUTER_MODEL;
  const messages: OpenRouterMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  // 429/5xx만 1회 jitter 재시도(401/402/403은 즉시 반환). 네트워크 예외도 1회.
  const post = async (body: Record<string, unknown>): Promise<Response | null> => {
    for (let a = 0; a < 2; a++) {
      try {
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
            'HTTP-Referer': 'https://quorum.app',
            'X-Title': 'Quorum',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });
        if (r.ok) return r;
        if ((r.status === 429 || r.status >= 500) && a < 1) { await r.body?.cancel().catch(() => {}); await sleep(1500 + Math.floor(Math.random() * 500)); continue; }
        return r;
      } catch (e) {
        // timeout(TimeoutError)은 재시도 안 함 — 지연 2배 방지. 일반 네트워크 예외만 1회 재시도.
        if (a < 1 && !(e instanceof Error && e.name === 'TimeoutError')) { await sleep(1500); continue; }
        return null;
      }
    }
    return null;
  };

  const MAX_TOOL_USES = 2; // 도구 호출 총량 hard cap — 누적 비용·토큰 제한
  let toolUses = 0;
  for (let turn = 0; turn < 4; turn++) {
    const r = await post({ model: mdl, messages, max_tokens: maxTokens, tools: TOOL_SPECS, tool_choice: 'auto' });
    if (!r || !r.ok) return null;
    const d = await r.json();
    const msg = d.choices?.[0]?.message as OpenRouterMessage | undefined;
    if (!msg) return null;

    const calls = msg.tool_calls;
    if (!calls?.length) { messages.push(msg); return msg.content || null; }

    // 한 턴 1개만 실행(parallel_tool_calls 미지원 모델 방어 + 비용 cap).
    // assistant 메시지의 tool_calls도 1개로 맞춰 push → 미응답 tool_call로 인한 다음 턴 400 방지.
    const limited = calls.slice(0, 1);
    if (calls.length > 1) console.warn('tool calls dropped (cap 1/turn):', calls.slice(1).map((c) => c.function?.name));
    messages.push({ ...msg, tool_calls: limited });
    for (const c of limited) {
      let out = '';
      try {
        out = await runTool(c.function?.name || '', JSON.parse(c.function?.arguments || '{}'));
      } catch {
        out = '도구 실행 실패';
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
      onToolUse?.(c.function?.name || '');  // 도구명 전달 → 비신뢰 도구만 tool-derived 표시(#31)
    }
    toolUses += limited.length;
    if (toolUses >= MAX_TOOL_USES) break; // cap 도달 → 정리 호출로 마무리
  }

  // 턴 소진/cap → 도구 비활성으로 최종 정리. tools는 스펙상 매번 포함, 비활성은 tool_choice:'none'.
  const r = await post({ model: mdl, messages, max_tokens: maxTokens, tools: TOOL_SPECS, tool_choice: 'none' });
  if (!r || !r.ok) return null;
  const d = await r.json();
  return d.choices?.[0]?.message?.content || null;
}

/**
 * 스트리밍 호출. delta.content를 누적하며 onDelta(누적 전체 텍스트)를 호출.
 * 반환: 최종 전체 텍스트(실패 시 null). reasoning 토큰은 무시하고 content만 누적.
 */
export async function callOpenRouterStream(
  system: string,
  user: string,
  maxTokens: number,
  model: string | undefined,
  onDelta: (full: string) => void,
): Promise<string | null> {
  if (!OPENROUTER_API_KEY) return null;
  const mdl = model || OPENROUTER_MODEL;
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://quorum.app',
        'X-Title': 'Quorum',
      },
      body: JSON.stringify({
        model: mdl,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: maxTokens,
        stream: true,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!r.ok || !r.body) { await r.body?.cancel().catch(() => {}); return null; }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || ''; // 마지막 미완성 라인 보존
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) { full += delta; onDelta(full); }
        } catch { /* SSE 분할로 인한 partial JSON — 다음 청크에서 완성 */ }
      }
    }
    return full || null;
  } catch { return null; }
}
