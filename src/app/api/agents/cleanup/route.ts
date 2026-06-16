/**
 * POST /api/agents/cleanup — Remove zombie test agents and/or groups
 *
 * Removes entities that match a regex pattern (default: covers all common test patterns).
 * Useful for cleaning up test agents, groups, or stuck processes.
 *
 * Body:
 *   - type: 'agents' | 'groups' | 'all' (default: 'agents')
 *   - pattern: string (regex pattern to match, default: covers real-test-*, test-agent-*, temp-*, debug-*)
 *   - dryRun: boolean (if true, only return matches without removing)
 *   - markAsTest: boolean (if true, sets isTest flag on matched agents instead of removing)
 *
 * Returns:
 *   - removed/marked: string[] (list of affected names)
 *   - count: number (number of entities affected)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentRegistry } from '@/lib/agent-registry';
import { getGroupRegistry } from '@/lib/group-registry';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '@/lib/data-dir';

export const dynamic = 'force-dynamic';

/** Default patterns that cover common test/zombie naming conventions */
const DEFAULT_CLEANUP_PATTERNS = [
  'real-test-.*',
  'test-agent-.*',
  'test-group-.*',
  'temp-.*',
  'debug-.*',
  'test-.*',
  'sim-.*',
  'final-.*',
  'auto-.*',
  'ai-.*',
  'grade-.*',
  'write-.*',
  'review-.*',
  'design-.*',
  'prof-.*',
  'comp-.*',
  'biz-.*',
  'dev-bot.*',
  'dev-assistant.*',
  'marketing-bot.*',
  'content-bot.*',
  'hr-bot.*',
  'finance-bot.*',
  'teacher-bot.*',
  'student-bot.*',
  'lawyer-bot.*',
  'doctor-bot.*',
  'research-bot.*',
].join('|');

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const type: string = body.type || 'agents';
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

    const results: { agents: { removed: string[]; marked: string[] }; groups: { removed: string[] } } = {
      agents: { removed: [], marked: [] },
      groups: { removed: [] },
    };

    // ── Agent cleanup ──
    if (type === 'agents' || type === 'all') {
      const registry = getAgentRegistry();

      if (markAsTest) {
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

        results.agents.marked = marked;
      } else {
        results.agents.removed = registry.cleanupZombies(pattern, dryRun);
      }
    }

    // ── Group cleanup ──
    if (type === 'groups' || type === 'all') {
      const registry = getGroupRegistry();
      const regex = new RegExp(pattern, 'i');
      const removed: string[] = [];

      // Discover all groups on disk
      registry.getAll(); // triggers discovery

      for (const group of registry.getAll()) {
        if (regex.test(group.name)) {
          removed.push(group.name);
          if (!dryRun) {
            try {
              // Remove from registry
              registry.remove(group.name);
              // Remove directory from disk
              const groupDir = path.join(GROUPS_DIR, group.name);
              if (fs.existsSync(groupDir)) {
                fs.rmSync(groupDir, { recursive: true, force: true });
                console.log(`[cleanup] Removed group directory: ${groupDir}`);
              }
            } catch (e) {
              console.error(`[cleanup] Failed to remove group ${group.name}:`, e);
            }
          }
        }
      }

      results.groups.removed = removed;
    }

    const totalRemoved = results.agents.removed.length + results.groups.removed.length;
    const totalMarked = results.agents.marked.length;

    return NextResponse.json({
      success: true,
      results,
      count: totalRemoved + totalMarked,
      dryRun,
      type,
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
 * GET /api/agents/cleanup — List zombie agents/groups (dry run)
 */
export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const type = url.searchParams.get('type') || 'all';
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

    const regex = new RegExp(pattern, 'i');
    const results: { agents: string[]; groups: string[] } = { agents: [], groups: [] };

    if (type === 'agents' || type === 'all') {
      const agentRegistry = getAgentRegistry();
      results.agents = agentRegistry.cleanupZombies(pattern, true);
    }

    if (type === 'groups' || type === 'all') {
      const groupRegistry = getGroupRegistry();
      groupRegistry.getAll(); // trigger discovery
      for (const group of groupRegistry.getAll()) {
        if (regex.test(group.name)) {
          results.groups.push(group.name);
        }
      }
    }

    return NextResponse.json({
      results,
      count: results.agents.length + results.groups.length,
      pattern,
      type,
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
