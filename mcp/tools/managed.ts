/**
 * MCP Server - User-managed HTTP tools
 */

import { API_BASE_URL, fetchPost } from './shared';

export interface ToolDef { name: string; description: string; inputSchema: any; }

export function managedTools(): ToolDef[] {
  return [
    {
      name: 'tool_call',
      description: 'Call a user-managed HTTP tool by name. Use only after checking that the tool is appropriate for the task.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Managed tool name' },
          input: { type: 'string', description: 'JSON object string passed to the tool' },
        },
        required: ['name'],
      },
    },
  ];
}

export async function handleManagedTool(
  name: string, args: any, _agentName: string,
  respond: (id: string, msg: any) => void, id: string
): Promise<boolean> {
  if (name !== 'tool_call') return false;
  try {
    const input = args.input ? JSON.parse(args.input) : {};
    const data = await fetchPost(`${API_BASE_URL}/api/system/tools/call`, { name: args.name, input });
    if (data?.error) throw new Error(data.error);
    respond(id, { content: [{ type: 'text', text: JSON.stringify(data.result, null, 2) }] });
  } catch (e: any) {
    respond(id, { content: [{ type: 'text', text: `tool_call failed: ${e.message}` }], isError: true });
  }
  return true;
}
