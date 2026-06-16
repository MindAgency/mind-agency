/**
 * POST /api/agents/cleanup — Remove or mark zombie test agents
 *
 * Removes agents that match a regex pattern (default: covers all common test patterns).
 * Useful for cleaning up test agents or stuck processes.
 *
 * Body:
 *   - pattern: string (regex pattern to match, default: covers real-test-*, test-agent-*, temp-*, debug-*)
 *   - dryRun: boolean (if true, only return matches without removing)
 *   - markAsTest: boolean (if true, sets isTest flag on matched agents instead of removing)
 *
 * Returns:
 *   - removed/marked: string[] (list of affected agent names)
 *   - count: number (number of agents affected)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentRegistry } from '@/lib/agent-registry';

export const dynamic = 'force-dynamic';

/** Default patterns that cover common test/zombie agent naming conventions */
const DEFAULT_CLEANUP_PATTERNS = [
  'real-test-.*',
  'test-agent-.*',
  'temp-.*',
  'debug-.*',
  'test-.*',
].join('|');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const pattern = body.pattern || DEFAULT_CLEANUP_PATTERNS;
    const dryRun = body.dryRun === true;
    const markAsTest = body.markAsTest === true;

    // Validate pattern
    try {
      new RegExp(pattern, 'i');
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid regex pattern', details: (e as Error).message },
        { status: 400 }
      );
    }

    const registry = getAgentRegistry();

    if (markAsTest) {
      // Mark matching agents as test agents (sets isTest flag, does not delete)
      const marked: string[] = [];
      const allAgents = registry.getAll();
      const regex = new RegExp(pattern, 'i');

      for (const agent of allAgents) {
        if (regex.test(agent.name)) {
          try {
            await agent.loadConfig();
            // Set isTest flag and reduce permissions to prevent side effects
            (agent.config as any).isTest = true;
            (agent.config as any).maxTurns = Math.min(agent.config.maxTurns || 10, 2);
            if (agent.config.autoRespondToEmail) agent.config.autoRespondToEmail = false;
            if (agent.config.autoProcessGroupInvites) agent.config.autoProcessGroupInvites = false;
            await agent.saveConfig();
            marked.push(agent.name);
          } catch (e) {
            console.error(`[cleanup] Failed to mark ${agent.name} as test:`, e);
          }
        }
      }

      return NextResponse.json({
        success: true,
        marked,
        count: marked.length,
        dryRun: false,
        pattern,
        message: `Marked ${marked.length} agents as test (reduced permissions, maxTurns=2)`,
        timestamp: new Date().toISOString(),
      });
    }

    // Default: remove zombies
    const removed = registry.cleanupZombies(pattern, dryRun);

    return NextResponse.json({
      success: true,
      removed,
      count: removed.length,
      dryRun,
      pattern,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: 'Cleanup failed', details: msg },
      { status: 500 }
    );
  }
}

/**
 * GET /api/agents/cleanup — List zombie agents (dry run)
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const pattern = url.searchParams.get('pattern') || DEFAULT_CLEANUP_PATTERNS;

    // Validate pattern
    try {
      new RegExp(pattern, 'i');
    } catch (e) {
      return NextResponse.json(
        { error: 'Invalid regex pattern', details: (e as Error).message },
        { status: 400 }
      );
    }

    const registry = getAgentRegistry();
    const zombies = registry.cleanupZombies(pattern, true);

    return NextResponse.json({
      zombies,
      count: zombies.length,
      pattern,
      defaultPatterns: DEFAULT_CLEANUP_PATTERNS,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: 'Query failed', details: msg },
      { status: 500 }
    );
  }
}
