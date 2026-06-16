/**
 * POST /api/agents/{name}/launch — Launch agent terminal
 *
 * Opens a terminal window in the agent's working directory running
 * the claude-deepseek-zhijiao CLI. Cross-platform support (Windows,
 * macOS, Linux).
 */

import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';
import { AGENTS_DIR } from '@/lib/data-dir';
import { getAgency } from '@/lib/agency';
import { requireName, apiNotFound, apiOk, apiInternal } from '@/lib/api-utils';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const validName = requireName(name);
  if (validName instanceof Response) return validName;

  const agency = getAgency();
  const proxy = agency.getAgent(validName);

  if (!proxy.exists()) {
    return apiNotFound(`Agent "${validName}" not found`);
  }

  const agentDir = path.join(AGENTS_DIR, validName);

  // Build launch command using spawn (no shell injection)
  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      spawn('cmd', ['/c', 'start', `"Mind Agency - ${validName}"`, 'cmd', '/k', `cd /d "${agentDir}" && claude-deepseek-zhijiao`], {
        detached: true, stdio: 'ignore',
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell app "Terminal" to do script "cd ${agentDir} && claude-deepseek-zhijiao"`], {
        detached: true, stdio: 'ignore',
      }).unref();
    } else {
      spawn('gnome-terminal', [`--working-directory=${agentDir}`, '--', 'claude-deepseek-zhijiao'], {
        detached: true, stdio: 'ignore',
      }).unref();
    }
  } catch (e: any) {
    return apiInternal(`Failed to launch agent: ${e.message}`);
  }

  return apiOk({ message: `${validName} terminal launched`, directory: agentDir });
}
