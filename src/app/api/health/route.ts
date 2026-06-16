/**
 * GET /api/health — System health check (no authentication required)
 *
 * Returns the overall health status of the platform including:
 * - WebSocket server connectivity and metrics
 * - Workflow run counters
 * - Active configuration (env, port, AI model)
 *
 * Responds with 200 when healthy, 503 when degraded.
 */

import { NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

export const dynamic = 'force-dynamic';

export const GET = safeHandler(async () => {
  const { config } = await import('@/lib/config');
  const { getWsMetrics, checkWsHealth } = await import('@/lib/ws-embedded');
  const { metrics } = await import('@/lib/metrics');

  const wsHealthy = await checkWsHealth();
  const wsMetrics = getWsMetrics();

  const health = {
    status: wsHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    version: '0.8.0',
    uptime: process.uptime(),
    services: {
      ws: { status: wsHealthy ? 'up' : 'down', ...wsMetrics },
      metrics: { status: 'up', workflowRuns: metrics.workflowRuns.get() },
    },
    config: {
      env: config.server.env,
      port: config.server.port,
      aiModel: config.ai.defaultModel,
    },
  };

  return NextResponse.json(health, {
    status: wsHealthy ? 200 : 503,
  });
});
