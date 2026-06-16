/**
 * MCP Server - Multi-level agent hierarchy tools
 */

import { API_BASE_URL, fetchJSON, fetchPost } from './shared';

export interface ToolDef { name: string; description: string; inputSchema: any; }

export function hierarchyTools(): ToolDef[] {
  return [
    {
      name: 'agent_route',
      description: 'Route a goal through the multi-level agent hierarchy and suggest delegate agents.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string' },
          coordinator: { type: 'string' },
          maxDelegates: { type: 'number' },
        },
        required: ['goal'],
      },
    },
    {
      name: 'agent_hierarchy',
      description: 'List discovered manager/lead/worker/reviewer relationships.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
  ];
}

export async function handleHierarchyTool(
  name: string, args: any, agentName: string,
  respond: (id: string, msg: any) => void, id: string
): Promise<boolean> {
  if (name === 'agent_route') {
    if (!args.goal) {
      respond(id, { content: [{ type: 'text', text: 'goal required' }], isError: true });
      return true;
    }
    const data = await fetchPost(`${API_BASE_URL}/api/agents/hierarchy`, {
      action: 'route',
      goal: args.goal,
      coordinator: args.coordinator || agentName,
      maxDelegates: args.maxDelegates || 3,
    });
    respond(id, { content: [{ type: 'text', text: JSON.stringify(data.decision || data, null, 2) }] });
    return true;
  }

  if (name === 'agent_hierarchy') {
    const data = await fetchJSON(`${API_BASE_URL}/api/agents/hierarchy`);
    respond(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
    return true;
  }

  return false;
}
