/**
 * Agent Config API — read and update agent configuration
 *
 * GET  /api/agents/{name}/config                → return agent config
 * GET  /api/agents/{name}/config?file=claude     → return CLAUDE.md content
 * PUT  /api/agents/{name}/config                → update config or CLAUDE.md
 *
 * Sensitive fields (e.g., apiKey) are stripped from GET responses.
 */

import { NextRequest } from 'next/server';
import { getAgentRegistry } from '@/lib/agent-registry';
import { writeAudit } from '@/lib/audit';
import fs from 'fs';
import path from 'path';
import { AGENTS_DIR } from '@/lib/data-dir';
import { apiOk, apiNotFound, apiBadRequest, requireName, parseBody } from '@/lib/api-utils';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const validName = requireName(name);
  if (validName instanceof Object) return validName;

  const registry = getAgentRegistry();
  const proxy = registry.getOrCreate(validName);
  await proxy.loadConfig();

  // CLAUDE.md read
  const { searchParams } = new URL(request.url);
  if (searchParams.get('file') === 'claude') {
    const claudePath = path.join(AGENTS_DIR, validName, 'CLAUDE.md');
    if (!fs.existsSync(claudePath)) return apiOk({ content: '' });
    return apiOk({ content: fs.readFileSync(claudePath, 'utf-8') });
  }

  // Filter out sensitive fields
  const config = { ...proxy.config };
  delete (config as any).apiKey;
  return apiOk(config as Record<string, unknown>);
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const validName = requireName(name);
  if (validName instanceof Object) return validName;

  const registry = getAgentRegistry();
  const proxy = registry.getOrCreate(validName);
  if (!proxy.exists()) return apiNotFound('Agent not found');

  try {
    const body = await request.json();

    // CLAUDE.md write
    if (body.claudeMd !== undefined) {
      const agentDir = path.join(AGENTS_DIR, validName);
      if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
      const claudePath = path.join(agentDir, 'CLAUDE.md');
      fs.writeFileSync(claudePath, body.claudeMd, 'utf-8');
      proxy.invalidateCache();
      writeAudit({ agent: validName, action: 'claude.update', resource: `agent:${validName}`, details: 'Updated CLAUDE.md' });
      return apiOk();
    }

    // Update config via proxy
    await proxy.loadConfig();
    Object.assign(proxy.config, body);
    await proxy.saveConfig();
    proxy.invalidateCache();

    writeAudit({
      agent: validName,
      action: 'config.update',
      resource: `agent:${validName}`,
      details: JSON.stringify(body),
    });

    return apiOk(proxy.config as unknown as Record<string, unknown>);
  } catch {
    return apiBadRequest('Invalid JSON');
  }
}
