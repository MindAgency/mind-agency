/**
 * Tasks API — workflow task management across agents
 *
 * GET    /api/tasks?group=<name>  → list tasks for a group (or all groups)
 * POST   /api/tasks               → create a new task
 * PUT    /api/tasks               → update task status (complete/cancel)
 */

import { NextRequest } from 'next/server';
import { apiOk, apiBadRequest, apiInternal } from '@/lib/api-utils';
import { safeHandler } from '@/lib/api-handler';

export const GET = safeHandler(async (request: NextRequest) => {
  const { getAgency } = await import('@/lib/agency');
  const { searchParams } = new URL(request.url);
  const group = searchParams.get('group');

  const agency = getAgency();

  if (!group) {
    // List all agents with tasks
    const agents = agency.getAgents();
    const agentsWithTasks = [];
    for (const agent of agents) {
      const tasks = await agent.loadTasks();
      if (tasks.length > 0) {
        agentsWithTasks.push(agent.name);
      }
    }
    return apiOk({ groups: agentsWithTasks });
  }

  // Get tasks for a specific group (from all agents)
  const allTasks: any[] = [];
  for (const agent of agency.getAgents()) {
    const tasks = await agent.loadTasks();
    allTasks.push(...tasks.filter(t => t.workflow === group));
  }
  return apiOk({ tasks: allTasks });
});

// POST /api/tasks — create a task (called by MCP tool or API)
export const POST = safeHandler(async (request: NextRequest) => {
  const body = await request.json();
  const { group, id, title, description, reward, requiredSkills, maxClaims, postedBy } = body;

  if (!group || !id || !title || !description) {
    return apiBadRequest('group, id, title, description required');
  }

  const { getAgency } = await import('@/lib/agency');
  const agency = getAgency();
  const agentName = postedBy || 'system';

  const task = {
    runId: id,
    stepId: 'manual',
    workflow: group,
    prompt: description,
    priority: 'normal' as const,
    status: 'pending' as const,
    createdAt: Date.now(),
  };

  await agency.addTask(agentName, task);

  return apiOk({ task });
});

// PUT /api/tasks — update a task (claim, select, complete)
export const PUT = safeHandler(async (request: NextRequest) => {
  const body = await request.json();
  const { group, taskId, action, agent, message } = body;

  if (!group || !taskId || !action) {
    return apiBadRequest('group, taskId, action required');
  }

  const { getAgency } = await import('@/lib/agency');
  const agency = getAgency();
  const agentName = agent || 'system';

  if (action === 'complete') {
    await agency.completeTask(agentName, taskId, message || 'Completed');
  } else if (action === 'cancel') {
    const proxy = agency.getAgent(agentName);
    const tasks = await proxy.loadTasks();
    const task = tasks.find(t => t.runId === taskId);
    if (task) {
      task.status = 'failed';
      task.result = 'Cancelled';
      await proxy.saveTasks();
    }
  }

  return apiOk();
});
