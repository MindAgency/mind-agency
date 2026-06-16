/**
 * Agents API — CRUD operations for agent management
 *
 * GET    /api/agents               → list all agents with config and activity
 * POST   /api/agents               → create a new agent
 * DELETE /api/agents?name=<name>   → delete an agent by name
 */

import { NextRequest } from 'next/server';
import { apiOk, apiNotFound, apiBadRequest, apiInternal, apiConflict, requireName } from '@/lib/api-utils';
import { safeHandler } from '@/lib/api-handler';

export const GET = safeHandler(async () => {
  const { getAgentRegistry } = await import('@/lib/agent-registry');
  const registry = getAgentRegistry();
  const agents = registry.getAll();
  const agentList = await Promise.all(agents.map(async (proxy) => {
    await proxy.loadConfig();
    return {
      name: proxy.name,
      config: proxy.config,
      activity: proxy.activity,
    };
  }));
  return apiOk({ agents: agentList });
});

export const DELETE = safeHandler(async (request: NextRequest) => {
  const { getAgentRegistry } = await import('@/lib/agent-registry');
  const { writeAudit } = await import('@/lib/audit');

  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  if (!name) return apiBadRequest('Agent name required');
  const validName = requireName(name);
  if (validName instanceof Object) return validName;

  const registry = getAgentRegistry();
  const proxy = registry.get(validName);
  if (!proxy || !proxy.exists()) {
    return apiNotFound('Agent not found');
  }

  writeAudit({ agent: validName, action: 'agent.delete', resource: `agent:${validName}`, details: 'Agent directory removed' });
  registry.remove(validName);

  return apiOk();
});

// Create new agent
export const POST = safeHandler(async (request: NextRequest) => {
  const { getAgentRegistry } = await import('@/lib/agent-registry');
  const { writeAudit } = await import('@/lib/audit');
  const { broadcastWs } = await import('@/lib/ws-embedded');

  const body = await request.json();
  const name = (body.name || '').trim();
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return apiBadRequest('Invalid agent name');
  }

  const registry = getAgentRegistry();
  const existingProxy = registry.get(name);
  if (existingProxy && existingProxy.exists()) {
    return apiConflict('Agent already exists');
  }

  // Create agent via proxy
  const proxy = registry.getOrCreate(name);
  await proxy.loadConfig();

  // Set config from request body
  proxy.config.roles = body.roles || ['member'];
  proxy.config.permissions = body.permissions || { canCreateGroup: false, canDeleteGroup: false, canDeploy: false };
  proxy.config.autoRespondToEmail = body.autoRespondToEmail ?? false;
  proxy.config.autoProcessGroupInvites = body.autoProcessGroupInvites ?? false;
  if (body.allowedTools) proxy.config.allowedTools = body.allowedTools;
  if (body.disallowedTools) proxy.config.disallowedTools = body.disallowedTools;
  if (body.permissionMode) proxy.config.permissionMode = body.permissionMode;
  if (body.maxTurns) proxy.config.maxTurns = body.maxTurns;

  await proxy.saveConfig();

  writeAudit({ agent: name, action: 'agent.create', resource: `agent:${name}`, details: `roles: ${proxy.config.roles.join(',')}` });

  broadcastWs('sidebar_refresh', {});
  return apiOk({ name, config: proxy.config });
});
