import { NextRequest, NextResponse } from 'next/server';
import { dbQuery, getBackendType } from '@/lib/db';
import { authorized } from '@/lib/api-guard';
import { resumeStuckMeetings, resumeStuckDirectives, resumePendingReflections } from '@/lib/meeting-runner';

interface CheckResult { name: string; status: 'ok' | 'warn' | 'error'; latencyMs: number; detail?: string; httpStatus?: number; }

async function checkEndpoint(name: string, url: string, options?: RequestInit): Promise<CheckResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    const latencyMs = Date.now() - start;
    return res.ok || res.status === 400 ? { name, status: 'ok', latencyMs, httpStatus: res.status } : { name, status: 'warn', latencyMs, detail: `HTTP ${res.status}`, httpStatus: res.status };
  } catch (e) { return { name, status: 'error', latencyMs: Date.now() - start, detail: String(e) }; }
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  const detailed = authorized(req);
  // keep-alive cron 핑이 곧 워치독 — 정체된 회의·지시·reflection을 주기 재개(await 안 함, 즉시 200).
  // 공개 health probe는 side-effect 없이 요약만 반환. 워치독 재개는 same-origin 또는 API_TOKEN 요청에서만 실행.
  if (detailed) {
    void resumeStuckMeetings();
    void resumeStuckDirectives();
    void resumePendingReflections();  // #1: 미완 REFLECT(error backoff/started 만료) 재개
  }
  const backend = getBackendType();
  const checks: CheckResult[] = [];

  // Database health check
  try {
    const start = Date.now();
    await dbQuery('conversations', { limit: 1 });
    checks.push({ name: 'db_connection', status: 'ok', latencyMs: Date.now() - start });
  } catch (e) { checks.push({ name: 'db_connection', status: 'error', latencyMs: 0, detail: String(e) }); }

  // agent_configs 시드 여부 — DB 단독이라 비어있으면 registry 빈값 → 회의/채팅 불가.
  try {
    const start = Date.now();
    const rows = await dbQuery('agent_configs', { limit: 1 });
    checks.push(rows.length > 0
      ? { name: 'agent_configs', status: 'ok', latencyMs: Date.now() - start }
      : { name: 'agent_configs', status: 'error', latencyMs: Date.now() - start, detail: '시드 비어있음 — sql/agent-configs-seed.sql 실행 필요' });
  } catch (e) { checks.push({ name: 'agent_configs', status: 'error', latencyMs: 0, detail: String(e) }); }

  // chat_api는 실제 POST 시 LLM 호출+대화 저장 부수효과가 있어 헬스체크에서 제거.
  // 대신 LLM 설정 여부만 확인(비용·대화 오염 없이).
  checks.push({
    name: 'llm_config',
    status: process.env.OPENROUTER_API_KEY ? 'ok' : 'warn',
    latencyMs: 0,
    // 키 존재만 확인(실호출 아님) — 키 폐기/쿼터 초과 등 실제 LLM 장애는 못 잡으니 healthy를 가용성 보장으로 오해 말 것
    detail: process.env.OPENROUTER_API_KEY ? '키 설정됨(실호출 미검증)' : 'OPENROUTER_API_KEY 미설정',
  });
  // opt-in 실검증: ?live=1이면 OpenRouter key 엔드포인트로 키 유효성/크레딧 확인(LLM 호출 아님, 비용 없음).
  // 키 폐기·쿼터 초과를 잡아 'llm_config: ok'의 false healthy를 보완.
  // API_TOKEN 설정 시 Bearer 필요 — 외부의 무인증 키-상태 probe(정보 유출) 차단.
  const live = detailed && new URL(req.url).searchParams.get('live') === '1';
  if (live) {
    const apiToken = process.env.API_TOKEN;
    if (!apiToken) {
      // 토큰 미설정 시 live 비활성 — 무인증 외부에 키 상태/latency를 노출하지 않음
      checks.push({ name: 'llm_live', status: 'warn', latencyMs: 0, detail: 'live check는 API_TOKEN 설정 시에만 동작' });
    } else if ((req.headers.get('authorization') || '') !== `Bearer ${apiToken}`) {
      // 인증 실패를 조용히 skip하지 않고 명시 — 모니터가 검증 누락을 인지하게
      checks.push({ name: 'llm_live', status: 'error', latencyMs: 0, detail: 'unauthorized (Bearer API_TOKEN 필요)' });
    } else if (process.env.OPENROUTER_API_KEY) {
      const r = await checkEndpoint('llm_live', 'https://openrouter.ai/api/v1/key', {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      });
      // 키 무효(401/402/403)는 가용성 문제 → error. 일시장애(429/5xx)는 과민반응 피해 warn 유지.
      if (r.status !== 'ok') {
        r.status = (r.httpStatus === 401 || r.httpStatus === 402 || r.httpStatus === 403) ? 'error' : 'warn';
      }
      checks.push(r);
    }
  }
  const totalMs = Date.now() - startTime;
  const okCount = checks.filter(c => c.status === 'ok').length;
  const errorCount = checks.filter(c => c.status === 'error').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;

  const body = {
    overall: errorCount > 0 ? 'degraded' : warnCount > 0 ? 'warning' : 'healthy',
    timestamp: new Date().toISOString(), totalMs,
    summary: { ok: okCount, warn: warnCount, error: errorCount, total: checks.length },
  };
  return NextResponse.json(detailed ? { ...body, backend, checks, operator: 'Watchy (#19)' } : body);
}
