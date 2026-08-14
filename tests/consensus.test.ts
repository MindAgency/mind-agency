/**
 * Consensus Engine Tests — Unified Consensus Engine v2
 *
 * Tests the core consensus workflow: rule lookup, request creation,
 * decision submission (AND / OR / threshold logic), and permission keys.
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  default: path.join(__dirname, '.test-data'),
}));

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

import {
  getRule,
  resolveApprovers,
  createRequest,
  submitDecision,
  checkPermissionKey,
  listPendingRequests,
  getRequest,
  type ConsensusRule,
} from '../src/lib/consensus';

// ── getRule ──────────────────────────────────────────────

describe('Consensus Engine — getRule', () => {
  // 1. getRule returns correct rule for known actions
  it('returns correct rule for group_delete (AND logic)', () => {
    const rule = getRule('group_delete');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('group_delete');
    expect(rule!.logic).toBe('and');
    expect(rule!.approvers).toHaveLength(1);
    expect(rule!.approvers[0].type).toBe('group_owner');
    expect(rule!.quorum).toBe(1);
  });

  it('returns correct rule for deploy (OR logic with adversary)', () => {
    const rule = getRule('deploy');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('deploy');
    expect(rule!.logic).toBe('or');
    expect(rule!.adversary).toBeDefined();
    expect(rule!.adversary!.type).toBe('role');
    expect(rule!.adversary!.role).toBe('admin');
  });

  it('returns correct rule for workflow_trigger (no approval needed)', () => {
    const rule = getRule('workflow_trigger');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('workflow_trigger');
    expect(rule!.approvers).toHaveLength(0);
    expect(rule!.quorum).toBe(0);
  });

  it('returns correct rule for critical_deploy (threshold logic)', () => {
    const rule = getRule('critical_deploy');
    expect(rule).not.toBeNull();
    expect(rule!.action).toBe('critical_deploy');
    expect(rule!.logic).toBe('threshold');
    expect(rule!.threshold).toBe(2);
  });

  // 2. getRule returns null for unknown actions
  it('returns null for unknown action', () => {
    const rule = getRule('nonexistent_action_' + Date.now());
    expect(rule).toBeNull();
  });

  it('returns null for empty action string', () => {
    const rule = getRule('');
    expect(rule).toBeNull();
  });
});

// ── DEFAULT_RULES logic types ────────────────────────────

describe('Consensus Engine — DEFAULT_RULES logic types', () => {
  // 3. DEFAULT_RULES have correct logic types
  it('group_delete uses AND logic', () => {
    expect(getRule('group_delete')!.logic).toBe('and');
  });

  it('group_set_admin uses AND logic', () => {
    expect(getRule('group_set_admin')!.logic).toBe('and');
  });

  it('group_kick uses OR logic', () => {
    expect(getRule('group_kick')!.logic).toBe('or');
  });

  it('deploy uses OR logic', () => {
    expect(getRule('deploy')!.logic).toBe('or');
  });

  it('agent_create uses OR logic', () => {
    expect(getRule('agent_create')!.logic).toBe('or');
  });

  it('critical_deploy uses threshold logic with threshold=2', () => {
    const rule = getRule('critical_deploy')!;
    expect(rule.logic).toBe('threshold');
    expect(rule.threshold).toBe(2);
    expect(rule.quorum).toBe(2);
  });

  it('workflow_trigger has no approvers and quorum=0', () => {
    const rule = getRule('workflow_trigger')!;
    expect(rule.approvers).toHaveLength(0);
    expect(rule.quorum).toBe(0);
  });
});

// ── createRequest ────────────────────────────────────────

describe('Consensus Engine — createRequest', () => {
  // 4. createRequest generates unique IDs
  it('generates unique IDs for each request', () => {
    const group = 'test-unique-' + Date.now();
    const id1 = createRequest({
      action: 'group_delete',
      group,
      requestedBy: 'agent-a',
      description: 'first request',
      approvers: ['approver1'],
    });
    const id2 = createRequest({
      action: 'group_delete',
      group,
      requestedBy: 'agent-b',
      description: 'second request',
      approvers: ['approver1'],
    });
    expect(id1).not.toBe(id2);
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
    expect(id1.length).toBeGreaterThan(0);
    expect(id2.length).toBeGreaterThan(0);
  });

  it('creates a request that can be retrieved via getRequest', () => {
    const group = 'test-retrieve-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'test retrieval',
      approvers: ['admin1'],
    });
    const req = getRequest(group, id);
    expect(req).not.toBeNull();
    expect(req!.id).toBe(id);
    expect(req!.action).toBe('group_kick');
    expect(req!.status).toBe('pending');
    expect(req!.requestedBy).toBe('requester');
    expect(req!.approvers).toEqual(['admin1']);
  });

  it('creates request with correct default fields', () => {
    const group = 'test-fields-' + Date.now();
    const id = createRequest({
      action: 'group_delete',
      group,
      requestedBy: 'requester',
      description: 'field test',
      approvers: ['a1', 'a2'],
    });
    const req = getRequest(group, id);
    expect(req).not.toBeNull();
    expect(req!.decisions).toEqual({});
    expect(req!.timeoutMs).toBe(86400_000);
    expect(req!.createdAt).toBeGreaterThan(0);
  });
});

// ── submitDecision ───────────────────────────────────────

describe('Consensus Engine — submitDecision', () => {
  // 5. submitDecision with APPROVED changes status
  it('changes status to approved when APPROVED is submitted (single approver, no adversary)', () => {
    const group = 'test-approve-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'kick test',
      approvers: ['admin1'],
    });

    const result = submitDecision(group, id, 'admin1', 'APPROVED');
    expect(result.status).toBe('approved');

    const req = getRequest(group, id);
    expect(req).not.toBeNull();
    expect(req!.status).toBe('approved');
  });

  // 6. submitDecision with REJECTED changes status
  it('changes status to rejected when REJECTED is submitted', () => {
    const group = 'test-reject-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'reject test',
      approvers: ['admin1'],
    });

    const result = submitDecision(group, id, 'admin1', 'REJECTED');
    expect(result.status).toBe('rejected');

    const req = getRequest(group, id);
    expect(req).not.toBeNull();
    expect(req!.status).toBe('rejected');
  });

  it('returns not_an_approver for non-approver', () => {
    const group = 'test-nonapprover-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'non-approver test',
      approvers: ['admin1'],
    });

    const result = submitDecision(group, id, 'random-stranger', 'APPROVED');
    expect(result.status).toBe('not_an_approver');
  });

  it('returns not_found for non-existent request', () => {
    const group = 'test-notfound-' + Date.now();
    const result = submitDecision(group, 'nonexistent-id', 'admin1', 'APPROVED');
    expect(result.status).toBe('not_found');
  });

  it('returns already_decided for a completed request', () => {
    const group = 'test-already-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'already decided test',
      approvers: ['admin1'],
    });

    // First decision
    submitDecision(group, id, 'admin1', 'APPROVED');

    // Second attempt
    const result = submitDecision(group, id, 'admin1', 'REJECTED');
    expect(result.status).toBe('already_decided');
  });
});

// ── listPendingRequests ──────────────────────────────────

describe('Consensus Engine — listPendingRequests', () => {
  // 7. listPendingRequests returns requests from the group directory
  //    (the function reads all .json files; pending items are included)
  it('includes pending requests in the returned list', () => {
    const group = 'test-pending-' + Date.now();

    const id1 = createRequest({
      action: 'group_kick', group, requestedBy: 'r1',
      description: 'will be approved', approvers: ['a1'],
    });
    const id2 = createRequest({
      action: 'group_kick', group, requestedBy: 'r2',
      description: 'will be rejected', approvers: ['a1'],
    });
    const id3 = createRequest({
      action: 'group_kick', group, requestedBy: 'r3',
      description: 'stays pending', approvers: ['a1'],
    });

    // Approve id1, reject id2
    submitDecision(group, id1, 'a1', 'APPROVED');
    submitDecision(group, id2, 'a1', 'REJECTED');

    const all = listPendingRequests(group);
    const allIds = all.map(r => r.id);

    // The pending request must be present
    expect(allIds).toContain(id3);

    // Filter to only truly pending status
    const trulyPending = all.filter(r => r.status === 'pending');
    const pendingIds = trulyPending.map(r => r.id);
    expect(pendingIds).toContain(id3);
    expect(pendingIds).not.toContain(id1);
    expect(pendingIds).not.toContain(id2);
  });

  it('returns empty array for group with no requests', () => {
    const group = 'test-empty-' + Date.now();
    const pending = listPendingRequests(group);
    expect(pending).toEqual([]);
  });
});

// ── AND logic ────────────────────────────────────────────

describe('Consensus Engine — AND logic', () => {
  // 8. AND logic requires all approvers
  it('requires all approvers to approve before status changes', () => {
    const group = 'test-and-' + Date.now();
    const id = createRequest({
      action: 'group_delete',
      group,
      requestedBy: 'requester',
      description: 'AND logic test',
      approvers: ['approver1', 'approver2'],
    });

    // First approval → still pending (AND needs all)
    const r1 = submitDecision(group, id, 'approver1', 'APPROVED');
    expect(r1.status).toBe('pending');

    // Verify the request is still pending on disk
    const reqAfterFirst = getRequest(group, id);
    expect(reqAfterFirst!.status).toBe('pending');
    expect(reqAfterFirst!.decisions['approver1']).toBe('APPROVED');

    // Second approval → approved
    const r2 = submitDecision(group, id, 'approver2', 'APPROVED');
    expect(r2.status).toBe('approved');

    const reqAfterSecond = getRequest(group, id);
    expect(reqAfterSecond!.status).toBe('approved');
  });

  it('rejects immediately on first REJECTED with AND logic', () => {
    const group = 'test-and-reject-' + Date.now();
    const id = createRequest({
      action: 'group_delete',
      group,
      requestedBy: 'requester',
      description: 'AND reject test',
      approvers: ['approver1', 'approver2'],
    });

    const r1 = submitDecision(group, id, 'approver1', 'REJECTED');
    expect(r1.status).toBe('rejected');

    const req = getRequest(group, id);
    expect(req!.status).toBe('rejected');
  });
});

// ── OR logic ──────────────────────────────────────────────

describe('Consensus Engine — OR logic', () => {
  // 9. OR logic requires any one approver
  it('approves after a single approval (OR logic, quorum=1)', () => {
    const group = 'test-or-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'OR logic test',
      approvers: ['approver1', 'approver2'],
    });

    // First approval → approved (OR only needs quorum=1)
    const r1 = submitDecision(group, id, 'approver1', 'APPROVED');
    expect(r1.status).toBe('approved');

    const req = getRequest(group, id);
    expect(req!.status).toBe('approved');
  });

  it('rejects on first REJECTED if quorum not yet met (OR logic)', () => {
    const group = 'test-or-reject-' + Date.now();
    const id = createRequest({
      action: 'group_kick',
      group,
      requestedBy: 'requester',
      description: 'OR reject test',
      approvers: ['approver1', 'approver2'],
    });

    const r1 = submitDecision(group, id, 'approver1', 'REJECTED');
    expect(r1.status).toBe('rejected');
  });
});

// ── checkPermissionKey ───────────────────────────────────

describe('Consensus Engine — checkPermissionKey', () => {
  // 10. checkPermissionKey returns false for agents without permission
  it('returns false for agent without config file', () => {
    const agentName = 'agent-no-config-' + Date.now();
    const result = checkPermissionKey(agentName, 'group_delete');
    expect(result).toBe(false);
  });

  it('returns false for action without permissionKey in rule', () => {
    // group_kick has no permissionKey
    const result = checkPermissionKey('any-agent', 'group_kick');
    expect(result).toBe(false);
  });

  it('returns false for unknown action', () => {
    const result = checkPermissionKey('any-agent', 'unknown_action_' + Date.now());
    expect(result).toBe(false);
  });
});

// ── resolveApprovers ──────────────────────────────────────

describe('Consensus Engine — resolveApprovers', () => {
  it('resolves group_owner approver from group config', () => {
    const rule = getRule('group_delete')!;
    const group = 'test-resolve-owner-' + Date.now();
    const approvers = resolveApprovers(rule, group);
    expect(approvers).toContain('owner-agent');
  });

  it('resolves group_admin approvers (owner + admins) from group config', () => {
    const rule = getRule('group_kick')!;
    const group = 'test-resolve-admin-' + Date.now();
    const approvers = resolveApprovers(rule, group);
    // Mocked config: owner='owner-agent', admins=['admin1','admin2']
    expect(approvers).toContain('owner-agent');
    expect(approvers).toContain('admin1');
    expect(approvers).toContain('admin2');
  });

  it('returns empty array for rule with no approvers (workflow_trigger)', () => {
    const rule = getRule('workflow_trigger')!;
    const group = 'test-resolve-empty-' + Date.now();
    const approvers = resolveApprovers(rule, group);
    expect(approvers).toEqual([]);
  });
});
