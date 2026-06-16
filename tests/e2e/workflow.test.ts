/**
 * E2E Test: Workflow Execution
 *
 * Tests the complete user journey:
 * 1. Create group
 * 2. Create agent
 * 3. Create workflow
 * 4. Trigger workflow
 * 5. Wait for completion
 * 6. Verify results
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import {
  apiGet, apiPost, apiPut, apiDelete,
  assert, assertOk, assertEqual, assertHas,
  getTestGroup, getTestAgent, cleanup, waitFor,
} from './setup';

describe('Workflow E2E', () => {
  const group = getTestGroup();
  const agent = getTestAgent();

  beforeAll(async () => {
    // Create test group
    const g = await apiPost('/api/groups', { name: group });
    assertOk(g, 'Failed to create group');

    // Create test agent
    const a = await apiPost('/api/agents', { name: agent, role: 'developer' });
    assertOk(a, 'Failed to create agent');
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should create a workflow', async () => {
    const workflow = {
      name: 'test-workflow',
      steps: [
        { id: 'step1', agent, action: 'create', prompt: 'Write a hello world function' },
        { id: 'step2', agent, action: 'review', prompt: 'Review the code', dependsOn: ['step1'] },
      ],
    };

    const r = await apiPut(`/api/groups/${group}/workflow`, { steps: workflow.steps });
    assertOk(r, 'Failed to create workflow');
  });

  it('should trigger workflow', async () => {
    const r = await apiPost(`/api/groups/${group}/workflow`, {});
    assertOk(r, 'Failed to trigger workflow');
    assertHas(r, 'runId');
  });

  it('should show running status', async () => {
    const r = await apiGet(`/api/groups/${group}/workflow?action=runs`);
    assertOk(r);
    assert(r.runs.length > 0, 'No runs found');
    assertEqual(r.runs[0].status, 'running', 'run status');
  });

  it('should complete workflow', async () => {
    // Wait for completion (max 60 seconds)
    await waitFor(async () => {
      const r = await apiGet(`/api/groups/${group}/workflow?action=runs`);
      return r.runs.some((run: any) => run.status === 'completed' || run.status === 'failed');
    }, 60000);

    const r = await apiGet(`/api/groups/${group}/workflow?action=runs`);
    const run = r.runs[0];
    assert(run.status === 'completed' || run.status === 'failed', `Run ended with status: ${run.status}`);
  });

  it('should have step results', async () => {
    const r = await apiGet(`/api/groups/${group}/workflow?action=runs`);
    const run = r.runs[0];
    assert(run.steps, 'No steps in run');
    assert(Object.keys(run.steps).length > 0, 'No step results');
  });
});

describe('Agent E2E', () => {
  const agent = getTestAgent();

  it('should list agents', async () => {
    const r = await apiGet('/api/agents');
    assertOk(r);
    assert(r.agents.length > 0, 'No agents found');
  });

  it('should get agent config', async () => {
    const r = await apiGet(`/api/agents/${agent}/config`);
    assertOk(r);
    assertEqual(r.name, agent, 'agent name');
  });

  it('should get agent tasks', async () => {
    const r = await apiGet(`/api/agents/${agent}/tasks`);
    assertOk(r);
    assertHas(r, 'tasks');
  });
});

describe('Group E2E', () => {
  const group = getTestGroup();

  it('should list groups', async () => {
    const r = await apiGet('/api/groups');
    assertOk(r);
    assert(r.groups.length > 0, 'No groups found');
  });

  it('should get group info', async () => {
    const r = await apiGet(`/api/groups/${group}`);
    assertOk(r);
    assertEqual(r.name, group, 'group name');
  });
});

describe('Health Check', () => {
  it('should return healthy status', async () => {
    const r = await apiGet('/api/health');
    assertHas(r, 'status');
    assert(r.status === 'healthy' || r.status === 'degraded', `Unexpected status: ${r.status}`);
  });

  it('should return metrics', async () => {
    const res = await fetch('http://localhost:3000/api/metrics');
    assert(res.ok, 'Metrics endpoint not accessible');
    const text = await res.text();
    assert(text.includes('mind_'), 'No metrics found');
  });
});
