/**
 * GET /api/system/export?key=<admin_key> — Export full system backup
 *
 * Downloads a JSON file containing all agents, groups, workflows,
 * messages, and token records. Requires ADMIN_KEY authentication.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';
import fs from 'fs';
import path from 'path';

export async function GET(request: NextRequest) {
  // Auth: require admin key
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key || key !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Admin key required' } }, { status: 401 });
  }

  try {
    const agency = getAgency();
    const manifest: Record<string, any> = { exportedAt: new Date().toISOString(), agents: {}, groups: {} };

    // Agents
    for (const proxy of agency.getAgents()) {
      await proxy.loadConfig();
      manifest.agents[proxy.name] = { config: proxy.config };
    }

    // Groups
    for (const proxy of agency.getGroups()) {
      await proxy.loadConfig();
      await proxy.loadMembers();
      const workflow = await proxy.getWorkflow();
      const messages = await proxy.getMessages(1000);

      manifest.groups[proxy.name] = {
        config: proxy.config,
        members: proxy.members.map(m => m.name),
        workflow,
        messages,
      };
    }

    // Token usage
    await agency.system.loadTokenRecords();
    manifest.tokens = agency.system.tokenRecords;

    const json = JSON.stringify(manifest, null, 2);
    return new NextResponse(json, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="mind-agency-backup-${new Date().toISOString().split('T')[0]}.json"`,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
