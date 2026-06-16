/**
 * POST /api/poll — Trigger a poll of all agents
 *
 * Evaluates auto-respond rules for every agent and triggers chat replies
 * for any agents with active signals. Also starts the background scheduler
 * on first invocation.
 */

import { apiOk, apiInternal } from '@/lib/api-utils';
import { safeHandler } from '@/lib/api-handler';
import { pollAllAgents } from '@/lib/auto-respond';
import { startScheduler } from '@/lib/scheduler';
export const dynamic = 'force-dynamic';
let started = false;

export const POST = safeHandler(async () => {
  if (!started) { started = true; startScheduler(); }
  const r = await pollAllAgents();
  const triggered = r.filter(t => t.triggered);
  return apiOk({
    polled: r.length, triggered: triggered.length,
    triggered_agents: triggered.map(t => t.agent),
    results: r.map(t => ({ agent: t.agent, active: t.triggered })),
  });
});
