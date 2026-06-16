/**
 * GET /api/agents/{name}/heartbeat — Agent liveness check
 *
 * Returns whether the agent is currently active (last activity within 2
 * minutes), along with its status, pending task count, and last action
 * timestamp.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid agent name' }, { status: 400 });
  }

  const agency = getAgency();
  const proxy = agency.getAgent(name);

  if (!proxy.exists()) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  // Get activity from proxy
  const activity = proxy.activity;

  // Check if agent has pending tasks
  const pendingTasks = await agency.getPendingTasks(name);

  // Check last activity time
  const lastActivity = activity.updatedAt || 0;
  const isActive = Date.now() - lastActivity < 120000; // 2 min window

  return NextResponse.json({
    active: isActive || pendingTasks.length > 0,
    lastAction: lastActivity > 0 ? new Date(lastActivity).toISOString() : null,
    status: activity.status,
    detail: activity.detail,
    pendingTasks: pendingTasks.length,
  });
}
