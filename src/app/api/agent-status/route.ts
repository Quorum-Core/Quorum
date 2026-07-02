import { NextRequest } from 'next/server';
import { authorized } from '@/lib/api-guard';
import { isDemoMode, DEMO_AGENT_STATUS } from '../../../lib/demo-data';
import { getAgentRegistry } from '@/lib/agent-registry';

export async function GET(req: NextRequest) {
  if (!authorized(req)) return Response.json({ error: 'forbidden' }, { status: 403 });
  if (isDemoMode()) return Response.json({ agents: DEMO_AGENT_STATUS });
  try {
    const reg = await getAgentRegistry();
    const agents: Record<string, { status: 'idle' | 'resting'; lastTask: string; lastActive: string; tasksToday: number }> = {};
    for (const agent of reg.agents) {
      agents[agent.id] = {
        status: agent.active ? 'idle' : 'resting',
        lastTask: '',
        lastActive: '',
        tasksToday: 0,
      };
    }
    return Response.json({ agents });
  } catch (error) {
    console.error('agent-status failed:', error);
    return Response.json({ agents: {} });
  }
}
