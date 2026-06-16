/**
 * E2E Test Setup
 *
 * Provides helper functions for end-to-end testing.
 * Tests simulate real user actions through API endpoints.
 */

import http from 'http';

const BASE_URL = process.env.TEST_API_URL || 'http://localhost:3000';
const WS_URL = process.env.TEST_WS_URL || 'http://localhost:3001';

// ═══════ HTTP Helpers ═══════

export async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`);
  return res.json();
}

export async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function apiPut(path: string, body: any): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function apiDelete(path: string): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return res.json();
}

// ═══════ Assertion Helpers ═══════

export function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual: any, expected: any, field: string) {
  if (actual !== expected) {
    throw new Error(`Assertion failed: ${field} expected "${expected}", got "${actual}"`);
  }
}

export function assertOk(response: any, message?: string) {
  if (!response.ok && !response.success) {
    throw new Error(`Assertion failed: ${message || 'Expected ok=true'}\n${JSON.stringify(response, null, 2)}`);
  }
}

export function assertHas(response: any, field: string) {
  if (!(field in response)) {
    throw new Error(`Assertion failed: response missing field "${field}"\n${JSON.stringify(response, null, 2)}`);
  }
}

// ═══════ Test Data ═══════

const TEST_GROUP = `test-group-${Date.now()}`;
const TEST_AGENT = `test-agent-${Date.now()}`;

export function getTestGroup() { return TEST_GROUP; }
export function getTestAgent() { return TEST_AGENT; }

// ═══════ Cleanup ═══════

export async function cleanup() {
  try {
    await apiDelete(`/api/groups/${TEST_GROUP}`);
  } catch { /* ignore */ }
}

// ═══════ Wait Helper ═══════

export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number = 30000,
  intervalMs: number = 1000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Timeout after ${timeoutMs}ms`);
}
