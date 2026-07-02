/**
 * MCP/외부 도구 SSRF 가드 — 설계 Phase B B-3.
 * HTTPS only + private/link-local/metadata/loopback CIDR 차단(IPv4+IPv6). DNS rebinding은
 * 호출부에서 resolve된 IP 전수를 isBlockedIp로 검사 + IP pinning(undici)으로 보강.
 */
import { createHash } from 'crypto';

// IPv4 점표기 → 32bit 정수
function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}
function inCidr4(ip: number, base: string, bits: number): boolean {
  const b = ipv4ToInt(base);
  if (b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (b & mask);
}

// 차단 IPv4 범위: private/link-local/benchmark/docs/multicast/reserved 등 외부 MCP 대상이 될 수 없는 special-use.
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

// IPv4-mapped IPv6를 내부 v4로 환산: ::ffff:1.2.3.4 / ::ffff:7f00:1(hex) / 0:0:0:0:0:ffff:7f00:1(비압축).
function mappedV4(ip: string): string | null {
  const m = ip.match(/^(?:::ffff:|(?:0:){5}ffff:)(.+)$/);
  if (!m) return null;
  const tail = m[1];
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(tail)) return tail;     // dotted
  const hm = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);            // hex 2 hextet
  if (hm) {
    const hi = parseInt(hm[1], 16), lo = parseInt(hm[2], 16);
    return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
  }
  return null;
}

export function isBlockedIp(ipRaw: string): boolean {
  const ip = ipRaw.trim().toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6(hex/dotted/비압축) → 내부 v4로 검사(우회 차단)
  const v4 = mappedV4(ip) || ip;
  const n = ipv4ToInt(v4);
  if (n != null) return BLOCKED_V4.some(([b, bits]) => inCidr4(n, b, bits));

  // IPv6: loopback(::1), unspecified(::), unique-local(fc00::/7), link-local(fe80::/10), multicast(ff00::/8)
  if (ip === '::1' || ip === '::') return true;
  const seg0 = ip.split(':')[0];
  if (/^f[cd][0-9a-f]{0,2}$/.test(seg0)) return true;            // fc00::/7
  if (/^fe[89ab][0-9a-f]?$/.test(seg0)) return true;             // fe80::/10
  if (/^ff[0-9a-f]{0,2}$/.test(seg0)) return true;               // ff00::/8 multicast
  return false;
}

export type UrlCheck = { ok: true; host: string } | { ok: false; reason: string };

// URL 1차 검사: HTTPS only + 호스트가 IP 리터럴이면 즉시 차단 판정. (DNS resolve 검사는 호출부.)
export function checkMcpUrl(raw: string): UrlCheck {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https only' };
  if (u.username || u.password) return { ok: false, reason: 'userinfo not allowed' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  // IP 리터럴이면 바로 검사(DNS 우회 시도 차단)
  if (/^[\d.]+$/.test(host)) {
    // 점표기 정상 IPv4가 아니면(정수 2130706433·8진 0177.0.0.1 등) 거부 — ipv4ToInt 미파싱→검사 우회 + isLiteral로 DNS skip되는 bypass 차단(#54).
    if (!/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(host)) return { ok: false, reason: 'non-standard numeric host' };
    if (isBlockedIp(host)) return { ok: false, reason: 'blocked ip literal' };
  } else if (host.includes(':')) {
    if (isBlockedIp(host)) return { ok: false, reason: 'blocked ip literal' };
  }
  return { ok: true, host };
}

// remote tool 이름 → 안전한 노출명 mcp__<server>__<tool>__<hash8>, 전체 64자 이하(OpenAI tool-name 한도).
// hash suffix로 truncate 충돌 방지(긴 이름 2개가 같은 prefix여도 원본 기준 고유, #5).
export function safeMcpToolName(server: string, tool: string): string {
  const clean = (s: string) => String(s ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 20) || 'x';
  const h = createHash('sha256').update(JSON.stringify([server, tool])).digest('hex').slice(0, 8);
  // mcp__(5) + server(≤20) + __(2) + tool(≤20) + __(2) + hash(8) = ≤57 ≤ 64
  return `mcp__${clean(server)}__${clean(tool)}__${h}`;
}
