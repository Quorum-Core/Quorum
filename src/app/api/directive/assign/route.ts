import { NextRequest, NextResponse } from 'next/server';
import { authorizedBrowser } from '@/lib/api-guard';
import { rateLimited } from '@/lib/rate-limit';
import { getAgentRegistry } from '@/lib/agent-registry';
import { callOpenRouter } from '@/lib/openrouter';

type AssignedAgent = { id: string; task: string };

export async function POST(req: NextRequest) {
  if (!authorizedBrowser(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 }); // #75
  { const rl = rateLimited(req, 'assign', 10); if (rl) return rl; }  // 비용 가드(DoW)
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
    const { title, description } = body as Record<string, unknown>;
    // P2: 길이 검증(chat/meeting과 동일 정책) — 무제한 입력으로 인한 토큰 비용·메모리 남용 차단.
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return NextResponse.json({ error: 'title invalid' }, { status: 400 });
    if (description != null && (typeof description !== 'string' || description.length > 5000)) return NextResponse.json({ error: 'description too long' }, { status: 400 });
    const safeTitle = title.trim();
    const safeDescription = description || '';
    // 에이전트 목록 = 요청 시점 registry(DB 원천) → 추가/비활성/이름변경 반영.
    const reg = await getAgentRegistry();
    const activeAgents = reg.agents.filter(a => a.active);
    const AGENT_LIST = activeAgents.map(a => `- ${a.id}: ${a.name} (${a.desc})`).join('\n');

    const prompt = `You are Counsely, Chief of Staff at Quorum. The Leader has issued a directive. Analyze it and assign the most appropriate agents.

DIRECTIVE:
Title: ${safeTitle}
${safeDescription ? `Description: ${safeDescription}` : ''}

AVAILABLE AGENTS:
${AGENT_LIST}

RULES:
- Assign 3-5 agents (no fewer than 3, no more than 5)
- Always include yourself (lead) for synthesis
- Pick agents whose expertise matches the directive
- For each agent, specify their task in 3-5 words
- Consider multiple perspectives: research, risk, financial impact, strategy

Respond ONLY in this exact JSON format, no other text:
{"agents":[{"id":"agent_id","task":"brief task description"}]}`;

    try {
      const text = await callOpenRouter('Respond ONLY with the requested JSON, no other text.', prompt, 400);
      if (text) {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.agents && Array.isArray(parsed.agents) && parsed.agents.length > 0) {
            const validIds = new Set(activeAgents.map(a => a.id));
            const validAgents = normalizeAssignments(parsed.agents, validIds);
            if (validAgents.length >= 2) {
              return NextResponse.json({ agents: completeAssignments(validAgents, validIds), source: 'openrouter' });
            }
          }
        }
      }
    } catch (e) {
      console.error('Assign LLM error:', e);
    }

    // Fallback: keyword-based assignment — registry 활성 agent로 한정(빈/비활성 정적 id 반환 방지).
    const validIds = new Set(activeAgents.map(a => a.id));
    return NextResponse.json({ agents: fallbackAssign(safeTitle, safeDescription).filter(a => validIds.has(a.id)), source: 'fallback' });
  } catch {
    // 요청 파싱 실패 등 — registry 검증 불가 상태라 정적 agent를 주지 않음(무효 assignee 방지).
    return NextResponse.json({ agents: [], source: 'fallback' });
  }
}

function normalizeAssignments(items: unknown[], validIds: Set<string>): AssignedAgent[] {
  const agents: AssignedAgent[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !validIds.has(row.id) || seen.has(row.id)) continue;
    const rawTask = typeof row.task === 'string' ? row.task.trim() : '';
    agents.push({ id: row.id, task: rawTask.slice(0, 200) || 'Analysis' });
    seen.add(row.id);
  }
  return agents;
}

function completeAssignments(agents: AssignedAgent[], validIds: Set<string>): AssignedAgent[] {
  const next = [...agents];
  const add = (id: string, task: string) => {
    if (validIds.has(id) && !next.some(a => a.id === id)) next.push({ id, task });
  };
  add('lead', 'Synthesis & briefing');
  if (next.length < 3) add('risk', 'Risk assessment');
  if (next.length < 3) add('research', 'Research');
  const leadIndex = next.findIndex(a => a.id === 'lead');
  if (leadIndex > 4) {
    const [lead] = next.splice(leadIndex, 1);
    next.unshift(lead);
  }
  return next.slice(0, 5);
}

function fallbackAssign(title: string, desc: string): AssignedAgent[] {
  const text = `${title} ${desc}`.toLowerCase();
  const agents: { id: string; task: string }[] = [];
  if (/시장|market|트렌드|trend|분석|analy|조사|research/.test(text)) agents.push({ id: 'research', task: 'Research' });
  if (/투자|invest|매매|trad|자산|asset/.test(text)) agents.push({ id: 'quant', task: 'Analysis' }, { id: 'finance', task: 'Financial review' });
  if (/리스크|risk|위험|보안|security/.test(text)) agents.push({ id: 'risk', task: 'Risk assessment' });
  if (/마케팅|marketing|콘텐츠|content/.test(text)) agents.push({ id: 'pr', task: 'Marketing' });
  if (/개발|develop|빌드|build/.test(text)) agents.push({ id: 'dev', task: 'Development' });
  if (/전쟁|war|지정학|경제|econom|글로벌|global/.test(text)) agents.push({ id: 'research', task: 'Research' }, { id: 'quant', task: 'Impact analysis' });
  if (!agents.find(a => a.id === 'lead')) agents.push({ id: 'lead', task: 'Synthesis' });
  if (agents.length < 3) {
    if (!agents.find(a => a.id === 'risk')) agents.push({ id: 'risk', task: 'Risk assessment' });
    if (agents.length < 3 && !agents.find(a => a.id === 'research')) agents.push({ id: 'research', task: 'Research' });
  }
  return agents.filter((a, i, arr) => arr.findIndex(b => b.id === a.id) === i).slice(0, 5);
}
