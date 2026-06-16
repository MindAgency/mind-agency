/**
 * MCP Server - Search tools
 */

import { API_BASE_URL, fetchPost } from './shared';

export interface ToolDef { name: string; description: string; inputSchema: any; }

export function searchTools(): ToolDef[] {
  return [
    {
      name: 'web_search',
      description: 'Search the web for current information. Use only when external or time-sensitive facts are needed. Returns citations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          maxResults: { type: 'number', description: '1-10 results' },
          provider: { type: 'string', description: 'Optional: tavily, exa, or brave' },
        },
        required: ['query'],
      },
    },
  ];
}

export async function handleSearchTool(
  name: string, args: any, _agentName: string,
  respond: (id: string, msg: any) => void, id: string
): Promise<boolean> {
  if (name !== 'web_search') return false;
  if (!args.query) {
    respond(id, { content: [{ type: 'text', text: 'query required' }], isError: true });
    return true;
  }
  try {
    const data = await fetchPost(`${API_BASE_URL}/api/search`, {
      query: args.query,
      maxResults: args.maxResults,
      provider: args.provider,
    });
    if (data?.error) throw new Error(data.error);
    const lines = [`Web search results for: ${data.query}`, `Provider: ${data.provider}`, ''];
    for (const [i, r] of (data.results || []).entries()) {
      lines.push(`[${i + 1}] ${r.title}`);
      lines.push(r.url);
      if (r.snippet) lines.push(r.snippet);
      lines.push('');
    }
    respond(id, { content: [{ type: 'text', text: lines.join('\n') }] });
  } catch (e: any) {
    respond(id, { content: [{ type: 'text', text: `web_search failed: ${e.message}` }], isError: true });
  }
  return true;
}
