/**
 * MCP 도구 브리지 — 설계 Phase B. HTTP(JSON-RPC) transport + SSRF 가드 + curated-only 노출.
 *
 * 보안 원칙(설계 B-3): 외부 tool name/description/schema·결과 모두 untrusted.
 * → remote가 노출하는 tool을 자동 노출하지 않고, MCP_TOOLS(curated)에 등록된 것만 OpenRouter tools로 노출.
 * 미설정(MCP_SERVERS 없음)이면 완전 dormant(기존 동작 불변).
 */
import { checkMcpUrl, safeMcpToolName, isBlockedIp } from './mcp-ssrf';
import { untrustedBlock } from './untrusted';

// MCP JSON-RPC tools/call 응답에서 텍스트 본문 추출. result.content[].text 우선, 실패 시 raw.
export function extractMcpResult(raw: string): string {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return raw; }
  const o = j as { error?: { message?: string }; result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean } };
  if (o?.error) return `MCP 오류: ${String(o.error.message || 'unknown')}`;
  const content = o?.result?.content;
  if (Array.isArray(content)) {
    const text = content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return raw;
}

type ServerCfg = { name: string; url: string; headers?: Record<string, string> };
type CuratedTool = {
  server: string; tool: string; description: string;
  parameters: Record<string, unknown>;
};

const RESP_CAP = 4000;
const TIMEOUT_MS = 12000;
const MCP_PROTOCOL_VERSION = '2025-06-18'; // MCP spec lifecycle 버전(initialize/headers)

// Streamable HTTP가 text/event-stream으로 응답할 때 data: 라인에서 JSON-RPC 본문 추출.
// 여러 이벤트 중 result/error 가진 마지막 JSON 객체(= tools/call 응답)를 선택.
export function extractSseData(raw: string): string {
  // #40: event(blank line 구분)별로 data line을 \n concat(표준 multi-line data) + 개별 data line도 후보(연속 분리 메시지) 모두 수집.
  const candidates: string[] = [];
  for (const ev of raw.split(/\r?\n\r?\n/)) {
    const lines = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.replace(/^data:\s?/, ''));
    if (!lines.length) continue;
    for (const l of lines) { const t = l.trim(); if (t) candidates.push(t); } // 개별 line
    if (lines.length > 1) { const c = lines.join('\n').trim(); if (c) candidates.push(c); } // multi-line concat
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(candidates[i]); if (o && (o.result !== undefined || o.error !== undefined)) return candidates[i]; } catch { /* skip */ }
  }
  return candidates.join('') || raw;
}

function parseJson<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

// #62: Content-Length 선차단 + stream으로 cap 초과 즉시 abort(전체 read 후 slice = DoS cap 아님 → 진짜 cap). 초과분 버림.
async function readCapped(res: Response, cap: number): Promise<string> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > cap) { try { await res.body?.cancel(); } catch { /* noop */ } return ''; }
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return (await res.text()).slice(0, cap);
  const dec = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += dec.decode(value, { stream: true });
      if (out.length > cap) { try { await reader.cancel(); } catch { /* noop */ } break; }
    }
  } catch { /* stream 오류 → 모인 만큼 */ }
  return out.slice(0, cap);
}

function servers(): ServerCfg[] {
  return parseJson<ServerCfg[]>(process.env.MCP_SERVERS, []).filter((s) => s && s.name && s.url);
}
// curated: 서버가 광고하는 게 아니라 우리가 명시 등록한 tool만(name/description/schema 전부 로컬 정의).
function curated(): CuratedTool[] {
  return parseJson<CuratedTool[]>(process.env.MCP_TOOLS, []).filter((t) => t && t.server && t.tool);
}

export function mcpEnabled(): boolean {
  return servers().length > 0 && curated().length > 0;
}

const EMPTY_SCHEMA = { type: 'object', properties: {} };
const MAX_SCHEMA_BYTES = 4000;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_PROPS = 64;

// curated parameters 검증(#30): plain object + size/depth/property-count cap. 비정상·초과 → 빈 schema fallback.
// curated는 우리가 등록하지만 무검증 주입 시 거대/중첩 schema가 LLM 컨텍스트 토큰 폭증 유발 가능.
export function sanitizeMcpSchema(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ...EMPTY_SCHEMA };
  const o = p as Record<string, unknown>;
  // JSON Schema tool parameters는 top-level object 강제(#26). properties는 plain object여야.
  if (o.type !== 'object') return { ...EMPTY_SCHEMA };
  if (o.properties !== undefined && (typeof o.properties !== 'object' || o.properties === null || Array.isArray(o.properties))) return { ...EMPTY_SCHEMA };
  try { if (JSON.stringify(p).length > MAX_SCHEMA_BYTES) return { ...EMPTY_SCHEMA }; }
  catch { return { ...EMPTY_SCHEMA }; }
  let props = 0;
  const ok = (v: unknown, d: number): boolean => {
    if (d > MAX_SCHEMA_DEPTH) return false;
    if (v && typeof v === 'object') {
      for (const k in v as Record<string, unknown>) {
        if (++props > MAX_SCHEMA_PROPS) return false;
        if (!ok((v as Record<string, unknown>)[k], d + 1)) return false;
      }
    }
    return true;
  };
  return ok(p, 0) ? (p as Record<string, unknown>) : { ...EMPTY_SCHEMA };
}

// OpenRouter tools 스펙(로컬 curated description/schema만 — remote metadata 미사용).
export function getMcpToolSpecs(): unknown[] {
  if (!mcpEnabled()) return [];
  const known = new Set(servers().map((s) => s.name));
  return curated()
    .filter((t) => known.has(t.server))
    .map((t) => ({
      type: 'function',
      function: {
        name: safeMcpToolName(t.server, t.tool),
        description: String(t.description || '').slice(0, 500),
        parameters: sanitizeMcpSchema(t.parameters),
      },
    }));
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__');
}

// mcp__<server>__<tool> → 실제 server/tool 역매핑(safeMcpToolName과 동일 규칙으로 대조).
function resolve(name: string): { cfg: ServerCfg; tool: CuratedTool } | null {
  for (const t of curated()) {
    if (safeMcpToolName(t.server, t.tool) === name) {
      const cfg = servers().find((s) => s.name === t.server);
      if (cfg) return { cfg, tool: t };
    }
  }
  return null;
}

// MCP tool 호출 — SSRF 가드 + timeout + size cap + 결과 untrusted 래핑.
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<string> {
  const r = resolve(name);
  if (!r) return 'MCP 도구 거부: 미등록 tool';
  const chk = checkMcpUrl(r.cfg.url);
  if (!chk.ok) return `MCP 도구 거부: ${chk.reason}`;
  // DNS 해소 IP 전수 검사 → 안전한 IP 1개를 pinning(rebinding 차단). 도메인일 때만.
  let pinnedIp: string | null = null;
  const isLiteral = /^[\d.]+$/.test(chk.host) || chk.host.includes(':');
  if (!isLiteral) {
    try {
      const { lookup } = await import('dns/promises');
      const addrs = await lookup(chk.host, { all: true });
      if (!addrs.length) return 'MCP 도구 거부: DNS 해소 실패';
      if (addrs.some((a) => isBlockedIp(a.address))) return 'MCP 도구 거부: 사설/내부 IP 해소';
      pinnedIp = addrs[0].address; // 검사 통과한 IP로 고정(connect 시 재해석 금지)
    } catch { return 'MCP 도구 거부: DNS 해소 불가'; }
  }

  // Next가 global fetch를 패치해 dispatcher를 무시할 수 있음 → undici.fetch를 직접 써 pinning 보장(리뷰 P1).
  let undici: typeof import('undici') | null = null;
  try { undici = await import('undici'); } catch { undici = null; }
  // 도메인 호스트(pinnedIp 有)인데 undici 미가용 → rebinding 방어 불가 → fail-closed(#6).
  if (pinnedIp && !undici) return 'MCP 도구 거부: IP pinning 불가(undici 미가용)';

  const dispatcher = (pinnedIp && undici)
    ? new undici.Agent({
        connect: {
          lookup: (_h: string, _o: unknown, cb: (e: Error | null, addr: string, fam: number) => void) =>
            cb(null, pinnedIp, pinnedIp.includes(':') ? 6 : 4),
        },
      })
    : undefined;
  const doFetch = (undici?.fetch ?? fetch) as typeof fetch;

  // 동일 dispatcher/pinning/redirect 가드로 JSON-RPC POST(세션 헤더 선택적).
  const rpc = (body: object, sessionId: string | null) => doFetch(r.cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...(r.cfg.headers || {}),
    },
    redirect: 'error', // redirect 따라가지 않음(SSRF)
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  } as RequestInit);

  try {
    // MCP lifecycle: initialize → notifications/initialized → tools/call.
    // 단순 JSON-RPC 엔드포인트(핸드셰이크 미지원) 호환 위해 initialize는 best-effort — 실패 시 무세션 직접 호출 폴백.
    let sessionId: string | null = null;
    try {
      const initRes = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'quorum', version: '1' },
      } }, null);
      if (initRes.ok) {
        sessionId = initRes.headers.get('mcp-session-id');
        await readCapped(initRes, RESP_CAP * 2).catch(() => ''); // body drain(capped, #62)
        // initialized 통지(세션 확립). 응답 없는 notification — 실패해도 진행.
        await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId).then((rr) => readCapped(rr, RESP_CAP * 2).catch(() => '')).catch(() => {}); // #70: notification 응답도 cap
      }
    } catch { /* 핸드셰이크 미지원 → 무세션 폴백 */ }

    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: r.tool.tool, arguments: args } }, sessionId);
    if (!res.ok) return `MCP 호출 실패(status ${res.status})`;
    const raw = await readCapped(res, RESP_CAP * 2); // #62: 선차단+stream abort(초과분 drop)
    const payload = (res.headers.get('content-type') || '').includes('text/event-stream') ? extractSseData(raw) : raw;
    const body = extractMcpResult(payload).slice(0, RESP_CAP);
    return untrustedBlock('UNTRUSTED_MCP_RESULT', body);
  } catch {
    return 'MCP 호출 실패: timeout/네트워크/redirect';
  } finally {
    // #5: 호출마다 생성한 Agent 정리(socket/handle 누수 방지).
    try { await (dispatcher as { close?: () => Promise<void> } | undefined)?.close?.(); } catch { /* noop */ }
  }
}
