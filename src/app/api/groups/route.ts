/**
 * POST /api/groups — Create a new group
 *
 * Creates a group directory with default TASK_SPEC.md and workflow.yaml.
 * Optionally adds initial members and sets owner/admins configuration.
 *
 * Body: { name, owner?, admins?, members? }
 */

import { NextRequest } from 'next/server';
import { getGroupRegistry } from '@/lib/group-registry';
import { getAgentRegistry } from '@/lib/agent-registry';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '@/lib/data-dir';
import { apiOk, apiBadRequest, apiConflict, parseBody } from '@/lib/api-utils';

export async function GET() {
  try {
    const registry = getGroupRegistry();
    const names = registry.getAllNames();
    return apiOk({ groups: names });
  } catch {
    return apiOk({ groups: [] });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = (body.name || '').trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return apiBadRequest('Invalid group name');
    }

    const registry = getGroupRegistry();
    const existingProxy = registry.get(name);
    if (existingProxy && existingProxy.exists()) {
      return apiConflict('Group already exists');
    }

    // Create group via proxy
    const proxy = registry.getOrCreate(name);

    // Set config
    proxy.config.name = name;
    proxy.config.owner = body.owner || '';
    proxy.config.admins = body.admins || [];
    await proxy.saveConfig();

    // Add initial members if provided
    const agentRegistry = getAgentRegistry();
    const members: string[] = body.members || [];
    for (const member of members) {
      const memberName = (member || '').trim();
      if (!memberName) continue;
      const agentProxy = agentRegistry.getOrCreate(memberName);
      if (!agentProxy.exists()) continue;
      await proxy.addMember(memberName);
    }

    // Default TASK_SPEC
    const groupDir = path.join(GROUPS_DIR, name);
    if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'TASK_SPEC.md'), `# ${name} 任务规则\n\n群组已创建，暂无任务规则。`, 'utf-8');

    // Default workflow.yaml
    await proxy.saveWorkflow(`name: ${name}-default\ndescription: "Default workflow for ${name}"\nsteps: []\n`);

    return apiOk({ name });
  } catch {
    return apiBadRequest('Invalid request');
  }
}
