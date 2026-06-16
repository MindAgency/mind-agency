/**
 * Embedded WebSocket broadcast — Production Grade
 *
 * Forwards broadcast messages to the main WS server via HTTP POST.
 * Includes retry logic, connection health monitoring, and configurable endpoints.
 *
 * Used by Next.js API routes (same process) to push to browser clients.
 */

import http from 'http';
import { createLogger } from './logger';

const log = createLogger('ws-embedded');

// ═══════ Configuration ═══════

const WS_PORT = process.env.WS_PORT || '3001';
const WS_HOST = process.env.WS_HOST || '127.0.0.1';
const BROADCAST_URL = `http://${WS_HOST}:${WS_PORT}/broadcast`;
const HEALTH_URL = `http://${WS_HOST}:${WS_PORT}/health`;

// ═══════ Retry Configuration ═══════

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 5000;

// ═══════ State ═══════

let consecutiveFailures = 0;
let lastSuccessTime = 0;
let lastFailureTime = 0;

// ═══════ Core Functions ═══════

/**
 * Fire-and-forget HTTP POST with retry logic.
 * Retries up to MAX_RETRIES times on failure.
 */
function httpPostWithRetry(urlStr: string, body: Record<string, unknown>, attempt: number = 1): void {
  try {
    const data = JSON.stringify(body);
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      res.resume();
      consecutiveFailures = 0;
      lastSuccessTime = Date.now();
    });

    req.on('error', (err) => {
      consecutiveFailures++;
      lastFailureTime = Date.now();
      if (attempt < MAX_RETRIES) {
        log.warn(`Broadcast failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY_MS}ms`, { error: err.message });
        setTimeout(() => httpPostWithRetry(urlStr, body, attempt + 1), RETRY_DELAY_MS * attempt);
      } else {
        log.error(`Broadcast failed after ${MAX_RETRIES} attempts`, { error: err.message, url: urlStr });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      consecutiveFailures++;
      lastFailureTime = Date.now();
      if (attempt < MAX_RETRIES) {
        log.warn(`Broadcast timeout (attempt ${attempt}/${MAX_RETRIES}), retrying`);
        setTimeout(() => httpPostWithRetry(urlStr, body, attempt + 1), RETRY_DELAY_MS * attempt);
      }
    });

    req.write(data);
    req.end();
  } catch (err) {
    log.error('Broadcast exception', { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Broadcast a message to all connected browser clients via the main WS server.
 *
 * @param type - Message type (e.g., 'sidebar_refresh', 'wf_step_status')
 * @param data - Message payload
 */
export function broadcastWs(type: string, data: Record<string, unknown> = {}): void {
  httpPostWithRetry(BROADCAST_URL, { type, ...data, timestamp: new Date().toISOString() });
}

/**
 * Check if the WS server is healthy.
 * Returns true if reachable, false otherwise.
 */
export async function checkWsHealth(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Get connection health metrics.
 */
export function getWsMetrics() {
  return {
    consecutiveFailures,
    lastSuccessTime,
    lastFailureTime,
    isHealthy: consecutiveFailures < 5,
    uptime: lastSuccessTime ? Date.now() - lastSuccessTime : 0,
  };
}
