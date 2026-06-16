/**
 * GET /api/audit — Read audit logs
 *
 * Returns system-wide audit logs with optional agent filtering.
 * Each log entry records an action (e.g., agent.create, config.update)
 * with actor, resource, and timestamp details.
 *
 * Query params:
 *   - limit (1–1000, default 100) — max entries to return
 *   - agent — filter logs to a specific agent
 */

import { NextRequest, NextResponse } from 'next/server';
import { readAuditLogs, readAgentAuditLogs } from '@/lib/audit';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '100'), 1), 1000);
    const agent = searchParams.get('agent');

    const logs = agent
      ? await readAgentAuditLogs(agent, limit)
      : await readAuditLogs(limit);

    return NextResponse.json({ logs, count: logs.length });
  } catch {
    return NextResponse.json({ error: 'Failed to load audit logs' }, { status: 500 });
  }
}
