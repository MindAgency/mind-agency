import { metrics } from './metrics';

export function trackRequest(method: string, path: string, status: number, durationMs: number) {
  metrics.incHttpRequest(method, path, status);
  metrics.httpDuration.observe(durationMs);
}
