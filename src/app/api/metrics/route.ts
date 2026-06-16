/**
 * GET /api/metrics — Prometheus-compatible metrics endpoint
 *
 * Returns all system counters, histograms, and gauges in Prometheus
 * text exposition format. Useful for integration with Grafana,
 * Datadog, or any Prometheus-compatible monitoring stack.
 */

import { NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

export const GET = safeHandler(async () => {
  const { metrics } = await import('@/lib/metrics');

  return new NextResponse(metrics.toPrometheus(), {
    headers: { 'Content-Type': 'text/plain; version=0.0.4' },
  });
});
