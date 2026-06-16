/**
 * Agent Tasks API — v0.4
 *
 * GET /api/agents/{name}/tasks → returns all tasks assigned to this agent
 * across all running and completed workflows.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';
import { requireName, apiNotFound } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: NextRequest,
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

  // Get all tasks for this agent via AgentProxy
  const allTasks = await proxy.loadTasks();

  // Sort: in_progress first, then pending, then completed/failed
  const order: Record<string, number> = { in_progress: 0, pending: 1, failed: 2, completed: 3, skipped: 4 };
  allTasks.sort((a: any, b: any) => (order[a.status] ?? 5) - (order[b.status] ?? 5));

  return NextResponse.json({ tasks: allTasks, total: allTasks.length });
}
