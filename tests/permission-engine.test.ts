/**
 * Permission Engine Tests — thin wrapper over consensus module.
 *
 * Tests the permission flow:
 *   1. No consensus rule → pass through (allowed: true)
 *   2. Agent has permissionKey → auto-pass (allowed: true)
 *   3. No approvers in rule → pass through (allowed: true)
 *   4. Approvers exist → create consensus request (allowed: false, requestId)
 *   5. Already approved request → pass through (allowed: true)
 *   6. PermissionResult shape validation
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import fs from 'fs';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  default: path.join(__dirname, '.test-data'),
}));

vi.mock('../src/lib/cache', () => ({
  agentCache: {
    get: vi.fn(() => undefined),
    set: vi.fn(),
    invalidate: vi.fn(),
    invalidateRegion: vi.fn(),
  },
}));

// Mock chat and group-config to prevent loading heavy transitive dependencies
// (chat.ts imports providers, memory, agent-proxy, etc.)
vi.mock('../src/lib/chat', () => ({
  getAgentConfig: vi.fn(() => ({ name: 'test-agent', roles: [] })),
}));

vi.mock('../src/lib/group-config', () => ({
  loadGroupConfig: vi.fn(() => ({
    owner: 'owner-agent',
    admins: ['admin1', 'admin2'],
    createdAt: Date.now(),
    name: 'test-group',
  })),
}));

import { checkToolPermission, type PermissionResult } from '../src/lib/permission-engine';

// ── Helpers ──────────────────────────────────────────────

/** Create an agent config file with a granted permission key. */
function createAgentWithPermission(agentName: string, permissionKey: string): void {
  const dir = path.join(__dirname, '.test-data', 'Agents', agentName);
  fs.mkdirSync(dir, { recursive: true });
  const config = { permissions: { [permissionKey]: true } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

/** Create an approved consensus request file on disk. */
function createApprovedRequestFile(
  group: string,
  requestId: string,
  action: string,
  requestedBy: string,
): void {
  const dir = path.join(__dirname, '.test-data', 'Groups', group, '.consensus');
  fs.mkdirSync(dir, { recursive: true });
  const request = {
    id: requestId,
    action,
    group,
    requestedBy,
    description: 'pre-approved request',
    createdAt: Date.now(),
    timeoutMs: 86400_000,
    approvers: ['owner-agent'],
    decisions: { 'owner-agent': 'APPROVED' },
    status: 'approved',
  };
  fs.writeFileSync(path.join(dir, `${requestId}.json`), JSON.stringify(request, null, 2), 'utf-8');
}

// ── Test 1: No rule for tool → allowed: true ──────────────

describe('Permission Engine — No rule for tool', () => {
  // 1. No rule for tool → allowed: true
  it('returns allowed=true when no consensus rule exists for the tool', () => {
    const agent = 'agent-norule-' + Date.now();
    const tool = 'nonexistent_tool_' + Date.now();
    const result = checkToolPermission(agent, tool, { group: 'test-group' });

    expect(result.allowed).toBe(true);
    expect(result.message).toBe('ok');
    expect(result.requestId).toBeUndefined();
  });

  it('returns allowed=true for empty tool name', () => {
    const result = checkToolPermission('agent', '', { group: 'g' });
    expect(result.allowed).toBe(true);
  });
});

// ── Test 2: permissionKey and agent has key → allowed: true ─

describe('Permission Engine — permissionKey auto-pass', () => {
  // 2. Rule with permissionKey and agent has key → allowed: true
  it('returns allowed=true when agent has the required permissionKey', () => {
    const agent = 'agent-with-perm-' + Date.now();
    // group_delete rule has permissionKey: 'canDeleteGroup'
    createAgentWithPermission(agent, 'canDeleteGroup');

    const result = checkToolPermission(agent, 'group_delete', { group: 'test-group' });

    expect(result.allowed).toBe(true);
    expect(result.message).toContain('canDeleteGroup');
  });

  it('returns allowed=false when agent lacks the required permissionKey', () => {
    const agent = 'agent-no-perm-' + Date.now();
    // No config file created → checkPermissionKey returns false

    const result = checkToolPermission(agent, 'group_delete', { group: 'perm-group-' + Date.now() });

    // Should NOT auto-pass; should fall through to request creation
    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeDefined();
  });
});

// ── Test 3: No approvers → allowed: true ──────────────────

describe('Permission Engine — No approvers in rule', () => {
  // 3. Rule with no approvers → allowed: true
  it('returns allowed=true when rule has no approvers (workflow_trigger)', () => {
    const result = checkToolPermission('any-agent', 'workflow_trigger', { group: 'g' });

    expect(result.allowed).toBe(true);
    expect(result.message).toBe('ok');
    expect(result.requestId).toBeUndefined();
  });

  it('returns allowed=true when rule has quorum=0', () => {
    // workflow_trigger has quorum: 0
    const result = checkToolPermission('any-agent', 'workflow_trigger', {});
    expect(result.allowed).toBe(true);
  });
});

// ── Test 4: Approvers exist → allowed: false, requestId ───

describe('Permission Engine — Rule with approvers creates request', () => {
  // 4. Rule with approvers → allowed: false, requestId returned
  it('returns allowed=false with a requestId when approvers exist', () => {
    const agent = 'agent-needs-approval-' + Date.now();
    const group = 'req-group-' + Date.now();

    // group_delete has approvers (group_owner) and quorum=1
    // Agent has no permissionKey → does not auto-pass
    const result = checkToolPermission(agent, 'group_delete', { group });

    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeDefined();
    expect(typeof result.requestId).toBe('string');
    expect(result.requestId!.length).toBeGreaterThan(0);
    expect(result.message).toContain(result.requestId!);
  });

  it('returns allowed=false with requestId for group_kick (OR logic)', () => {
    const agent = 'agent-kick-' + Date.now();
    const group = 'kick-group-' + Date.now();

    const result = checkToolPermission(agent, 'group_kick', { group, target: 'target-agent' });

    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeDefined();
  });
});

// ── Test 5: Already approved request → allowed: true ─────

describe('Permission Engine — Already approved request', () => {
  // 5. Already approved request → allowed: true
  it('returns allowed=true when an approved request exists for the same agent and action', () => {
    const agent = 'agent-approved-' + Date.now();
    const group = 'approved-group-' + Date.now();
    const requestId = 'preapp1';

    // Create an approved request file on disk
    createApprovedRequestFile(group, requestId, 'group_delete', agent);

    const result = checkToolPermission(agent, 'group_delete', { group });

    expect(result.allowed).toBe(true);
    expect(result.message).toContain(requestId);
  });

  it('does not match approved request for a different agent', () => {
    const group = 'mismatch-group-' + Date.now();
    const requestId = 'preapp2';

    // Create approved request for agentA
    createApprovedRequestFile(group, requestId, 'group_delete', 'agentA');

    // Check for agentB → should NOT find the approved request
    const result = checkToolPermission('agentB', 'group_delete', { group });

    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeDefined();
  });

  it('does not match approved request for a different action', () => {
    const agent = 'agent-diff-action-' + Date.now();
    const group = 'diff-action-group-' + Date.now();
    const requestId = 'preapp3';

    // Create approved request for group_delete
    createApprovedRequestFile(group, requestId, 'group_delete', agent);

    // Check for group_kick → should NOT match
    const result = checkToolPermission(agent, 'group_kick', { group });

    expect(result.allowed).toBe(false);
    expect(result.requestId).toBeDefined();
  });
});

// ── Test 6: PermissionResult shape ────────────────────────

describe('Permission Engine — PermissionResult shape', () => {
  // 6. Returns correct PermissionResult shape
  it('returns object with allowed (boolean) and message (string) for no-rule case', () => {
    const result = checkToolPermission('agent', 'no_such_tool', {});

    expect(result).toHaveProperty('allowed');
    expect(result).toHaveProperty('message');
    expect(typeof result.allowed).toBe('boolean');
    expect(typeof result.message).toBe('string');
  });

  it('returns object with requestId (string) when request is created', () => {
    const agent = 'agent-shape-' + Date.now();
    const group = 'shape-group-' + Date.now();

    const result: PermissionResult = checkToolPermission(agent, 'group_delete', { group });

    expect(result.allowed).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.requestId).toBeDefined();
    expect(typeof result.requestId).toBe('string');
  });

  it('returns allowed=true with string message for permissionKey auto-pass', () => {
    const agent = 'agent-shape-perm-' + Date.now();
    createAgentWithPermission(agent, 'canDeleteGroup');

    const result = checkToolPermission(agent, 'group_delete', { group: 'g' });

    expect(result.allowed).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('PermissionResult requestId is undefined when allowed=true (no-rule path)', () => {
    const result = checkToolPermission('agent', 'unknown_tool_' + Date.now(), {});

    expect(result.allowed).toBe(true);
    expect(result.requestId).toBeUndefined();
  });
});
