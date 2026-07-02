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

export type OpenRouterSamplingOptions = {
  temperature?: number;
  seed?: number;
};

function withSamplingOptions<T extends Record<string, unknown>>(body: T, opts?: OpenRouterSamplingOptions): T & OpenRouterSamplingOptions {
  return {
    ...body,
    ...(typeof opts?.temperature === 'number' ? { temperature: opts.temperature } : {}),
    ...(typeof opts?.seed === 'number' ? { seed: opts.seed } : {}),
  };
}

export function hasOpenRouter(): boolean {
  return !!OPENROUTER_API_KEY;
}

/** {reply} 또는 {error}(UI/보고서 표시용 상세 메시지). chat·directive-execute 공용 — 인라인 복제 제거. */
export type LLMResult = { reply: string } | { error: string };
export async function callOpenRouterDetailed(
  system: string,
  user: string,
  opts?: { maxTokens?: number; model?: string; maxRetries?: number; history?: Array<{ role: string; content: string }> } & OpenRouterSamplingOptions,
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
        body: JSON.stringify(withSamplingOptions({ model: mdl, messages, max_tokens: maxTokens }, opts)),
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
export async function callOpenRouter(
  system: string,
  user: string,
  maxTokens = 500,
  model?: string,
  maxRetries?: number,
  sampling?: OpenRouterSamplingOptions,
): Promise<string | null> {
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
          body: JSON.stringify(withSamplingOptions({ model, messages, max_tokens: maxTokens }, sampling)),
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

const DEFAULT_TOOL_JSON_KEYS = ['query', 'expr', 'arguments', 'top_n'];
const DEFAULT_TOOL_NAMES = ['web_search', 'calculate'];
type JsonCandidate = { text: string; embedded: boolean };

function toolJsonClassifiers(toolSpecs?: unknown[]): { argKeys: Set<string>; toolNames: Set<string> } {
  const argKeys = new Set(DEFAULT_TOOL_JSON_KEYS);
  const toolNames = new Set(DEFAULT_TOOL_NAMES);
  for (const spec of toolSpecs || []) {
    const fn = (spec as { function?: { name?: unknown; parameters?: { properties?: unknown; required?: unknown } } })?.function;
    if (typeof fn?.name === 'string') toolNames.add(fn.name);
    const props = fn?.parameters?.properties;
    if (props && typeof props === 'object' && !Array.isArray(props)) {
      for (const k of Object.keys(props)) argKeys.add(k);
    }
    const required = fn?.parameters?.required;
    if (Array.isArray(required)) {
      for (const k of required) if (typeof k === 'string') argKeys.add(k);
    }
  }
  return { argKeys, toolNames };
}

function jsonFragments(s: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  for (let i = 0; i < s.length; i++) {
    const open = s[i];
    if (open !== '{' && open !== '[') continue;
    const stack = [open];
    let inString = false;
    let escaped = false;
    for (let j = i + 1; j < s.length; j++) {
      const ch = s[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' || ch === ']') {
        const last = stack[stack.length - 1];
        if ((last === '{' && ch !== '}') || (last === '[' && ch !== ']')) break;
        stack.pop();
        if (!stack.length) { out.push({ text: s.slice(i, j + 1), start: i }); i = j; break; }
      }
    }
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolCallPrefix(text: string, start: number, toolNames: Set<string>): boolean {
  const p = text.slice(Math.max(0, start - 128), start).toLowerCase();
  if (/(도구\s*(호출|사용)\s*:?|함수\s*호출\s*:?|tool\s*call\s*:?|function\s*call\s*:?|arguments?\s*:|인자\s*:?)\s*$/.test(p)) return true;
  for (const name of toolNames) {
    const n = escapeRegExp(name.toLowerCase());
    if (new RegExp(`(?:^|[^a-z0-9_])${n}\\s*(?:\\(|:)?\\s*$`).test(p)) return true;
  }
  return false;
}

function jsonCandidates(text: string, toolNames: Set<string>): JsonCandidate[] {
  const out: JsonCandidate[] = [];
  const seen = new Set<string>();
  const add = (v: string, embedded: boolean) => {
    const t = v.trim();
    const key = `${embedded}:${t}`;
    if (t && !seen.has(key)) { seen.add(key); out.push({ text: t, embedded }); }
  };
  add(text, false);
  const wholeFence = text.match(/^```[A-Za-z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (wholeFence) add(wholeFence[1], false);
  const fenceRe = /```[A-Za-z0-9_-]*\s*([\s\S]*?)```/g;
  for (let m = fenceRe.exec(text); m; m = fenceRe.exec(text)) add(m[1], !!wholeFence || !toolCallPrefix(text, m.index, toolNames));
  for (const frag of jsonFragments(text)) add(frag.text, !toolCallPrefix(text, frag.start, toolNames));
  return out;
}

function isToolJson(v: unknown, argKeys: Set<string>, toolNames: Set<string>): boolean {
  if (Array.isArray(v)) return v.some((x) => isToolJson(x, argKeys, toolNames));
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => argKeys.has(k) || toolNames.has(k))) return true;
  const named = o.name ?? o.tool;
  if (typeof named === 'string' && toolNames.has(named)) return true;
  if (o.function && isToolJson(o.function, argKeys, toolNames)) return true;
  if (typeof o.arguments === 'string') {
    try { return isToolJson(JSON.parse(o.arguments), argKeys, toolNames); } catch { /* plain string */ }
  }
  return false;
}

// 약한 모델이 tool_call 프로토콜 대신 content에 도구 호출 JSON을 통째로 토하는 경우 방어 —
// 발언이 `{"query":...}`·```json fenced```·`도구 호출: {"expr":...}`처럼 새면 null 처리(상위 fallback/재생성).
export function cleanToolJson(c?: string | null, toolSpecs?: unknown[]): string | null {
  if (c == null) return null;
  if (!c.trim()) return null;
  const { argKeys, toolNames } = toolJsonClassifiers(toolSpecs);
  for (const candidate of jsonCandidates(c, toolNames)) {
    try {
      if (!candidate.embedded && isToolJson(JSON.parse(candidate.text), argKeys, toolNames)) return null;
    } catch { /* JSON 아님 → 정상 텍스트 */ }
  }
  return c;
}

function successfulToolResult(name: string, output: string): boolean {
  const out = String(output || '').trim();
  if (!out) return false;
  if (name === 'web_search') return out.startsWith('[UNTRUSTED_WEB_SEARCH_RESULTS]');
  if (name === 'calculate') return !/^(도구 호출 거부|도구 실행 실패|알 수 없는 도구|수식이 너무 깁니다|허용되지 않은 문자|계산 오류|계산 결과 비정상)/.test(out);
  if (name.startsWith('mcp__')) {
    return out.startsWith('[UNTRUSTED_MCP_RESULT]') && !/^\[UNTRUSTED_MCP_RESULT\]\s*MCP 오류:/m.test(out);
  }
  return !/^(도구 호출 거부|도구 실행 실패|알 수 없는 도구)/.test(out);
}

export async function callOpenRouterWithTools(
  system: string,
  user: string,
  maxTokens = 2000,
  model?: string,
  onToolUse?: (toolName: string) => void,  // 성공한 도구 결과가 최종 답변에 채택될 때 provenance 전달(#1/#31)
  sampling?: OpenRouterSamplingOptions,
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
  const successfulTools = new Set<string>();
  const acceptReply = (content?: string | null): string | null => {
    const cleaned = cleanToolJson(content, TOOL_SPECS);
    if (!cleaned) return null;
    for (const name of successfulTools) onToolUse?.(name);
    return cleaned;
  };
  for (let turn = 0; turn < 4; turn++) {
    const r = await post(withSamplingOptions({ model: mdl, messages, max_tokens: maxTokens, tools: TOOL_SPECS, tool_choice: 'auto' }, sampling));
    if (!r || !r.ok) return null;
    const d = await r.json();
    const msg = d.choices?.[0]?.message as OpenRouterMessage | undefined;
    if (!msg) return null;

    const calls = msg.tool_calls;
    if (!calls?.length) { messages.push(msg); return acceptReply(msg.content); }

    // 한 턴 1개만 실행(parallel_tool_calls 미지원 모델 방어 + 비용 cap).
    // assistant 메시지의 tool_calls도 1개로 맞춰 push → 미응답 tool_call로 인한 다음 턴 400 방지.
    const limited = calls.slice(0, 1);
    if (calls.length > 1) console.warn('tool calls dropped (cap 1/turn):', calls.slice(1).map((c) => c.function?.name));
    messages.push({ ...msg, tool_calls: limited });
    for (const c of limited) {
      let out = '';
      try {
        const toolName = c.function?.name || '';
        out = await runTool(toolName, JSON.parse(c.function?.arguments || '{}'));
        if (successfulToolResult(toolName, out)) successfulTools.add(toolName);
      } catch {
        out = '도구 실행 실패';
      }
      messages.push({ role: 'tool', tool_call_id: c.id, content: out });
    }
    toolUses += limited.length;
    if (toolUses >= MAX_TOOL_USES) break; // cap 도달 → 정리 호출로 마무리
  }

  // 턴 소진/cap → 도구 비활성으로 최종 정리. 약한 모델이 또 JSON·도구호출을 토하지 않도록 자연어 강제 system 추가.
  const finalize: OpenRouterMessage[] = [...messages, { role: 'system', content: '도구 사용은 끝났습니다. 도구를 더 부르지 말고, JSON이나 함수 호출 형식 없이 한국어 자연어 문장으로만 최종 의견을 작성하세요.' }];
  const r = await post(withSamplingOptions({ model: mdl, messages: finalize, max_tokens: maxTokens, tools: TOOL_SPECS, tool_choice: 'none' }, sampling));
  if (!r || !r.ok) return null;
  const d = await r.json();
  return acceptReply(d.choices?.[0]?.message?.content);
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
