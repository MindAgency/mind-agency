/**
 * Workflow Engine — Unit Tests
 *
 * Tests core engine logic: state machine, YAML parsing, utilities,
 * SimulatedStepExecutor, evalRouteCondition, and WorkflowEngine API
 * including execute(), callback(), and tick() with active runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// ── Mock all filesystem / side-effect modules BEFORE imports ──

vi.mock('../../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  AGENTS_DIR: path.join(__dirname, '.test-data', 'Agents'),
  AUDIT_DIR: path.join(__dirname, '.test-data', '.audit'),
  GROUPS_DIR: path.join(__dirname, '.test-data', 'Groups'),
  MCP_DIR: path.join(__dirname, '..', '..', 'mcp'),
  SRC_DIR: path.join(__dirname, '..', '..', 'src'),
  DATA_DIR: path.join(__dirname, '.test-data'),
  default: path.join(__dirname, '.test-data'),
}));

vi.mock('../../src/lib/atomic', () => ({
  atomicWrite: vi.fn((_filePath: string, _content: string) => {}),
}));

vi.mock('../../src/lib/event-bus', () => ({
  EventType: {
    TASK_CREATED: 'task.created',
    TASK_COMPLETED: 'task.completed',
    TASK_FAILED: 'task.failed',
    TASK_BLOCKED: 'task.blocked',
    TASK_IN_PROGRESS: 'task.in_progress',
    TASK_ASSIGNED: 'task.assigned',
    TASK_REVIEW_REQUESTED: 'task.review_requested',
    TASK_REVIEW_COMPLETED: 'task.review_completed',
  },
  createEvent: vi.fn((event: string, payload: Record<string, unknown>, source: string) => ({
    event, payload, source, timestamp: Date.now(), id: 'mock-uuid',
  })),
  EventBus: vi.fn(),
}));

vi.mock('../../src/lib/metrics', () => ({
  metrics: {
    workflowRuns: { inc: vi.fn() },
    workflowStepFailures: { inc: vi.fn() },
    workflowStepRetries: { inc: vi.fn() },
    workflowStepDuration: { observe: vi.fn() },
  },
}));

vi.mock('../../src/lib/workflow-checkpoint', () => ({
  saveRunMeta: vi.fn(),
  saveStepCheckpoint: vi.fn(),
  completeRunCheckpoint: vi.fn(),
  appendRunHistory: vi.fn(),
  findIncompleteRuns: vi.fn().mockReturnValue([]),
  cleanupCheckpoints: vi.fn(),
}));

vi.mock('../../src/lib/ws-embedded', () => ({
  broadcastWs: vi.fn(),
}));

vi.mock('../../src/lib/task-queue', () => ({
  enqueueTask: vi.fn(),
  completeTask: vi.fn(),
}));

vi.mock('../../src/lib/permission-engine', () => ({
  checkToolPermission: vi.fn().mockReturnValue({ allowed: true, message: '' }),
}));

vi.mock('../../src/lib/circuit-breaker', () => ({
  CircuitBreaker: vi.fn().mockImplementation(function () {
    return {
      canExecute: vi.fn().mockReturnValue(true),
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
      getFailures: vi.fn().mockReturnValue(0),
    };
  }),
}));

vi.mock('../../src/lib/errors', () => ({
  toUserError: vi.fn((type: string, ctx: Record<string, string>) => ({
    title: `Error: ${type}`,
    message: JSON.stringify(ctx),
    suggestion: 'Check configuration',
  })),
}));

vi.mock('../../src/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
  })),
}));

// ── Import engine modules ──

import {
  WorkflowEngine,
  StepStatus,
  WorkflowStatus,
  WorkflowPhase,
  isValidTransition,
  VALID_TRANSITIONS,
  transition,
  phaseForAction,
  parseReviewFindings,
  getAgents,
  parseWorkflowYaml,
  SimulatedStepExecutor,
} from '../../src/lib/workflow-engine';
import { evalRouteCondition } from '../../src/lib/workflow/callbacks';
import type {
  WorkflowDefinition,
  WorkflowStep,
  DagNode,
  WorkflowRunRecord,
} from '../../src/lib/workflow-engine';

// ── Helpers ──

function makeDef(overrides: Partial<WorkflowDefinition> & { steps: WorkflowStep[] }): WorkflowDefinition {
  return { name: 'test-workflow', ...overrides };
}

// ═══════════════════════════════════════════════════ WorkflowEngine API ═══

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine;

  beforeEach(() => {
    engine = new WorkflowEngine(undefined, new SimulatedStepExecutor());
  });

  describe('constructor', () => {
    it('should create engine with SimulatedStepExecutor', () => {
      expect(engine).toBeDefined();
      expect(engine).toBeInstanceOf(WorkflowEngine);
    });

    it('should create engine with no arguments (auto-detects executor)', () => {
      const e = new WorkflowEngine();
      expect(e).toBeDefined();
    });
  });

  describe('getRun()', () => {
    it('should return undefined for unknown run id', () => {
      expect(engine.getRun('nonexistent')).toBeUndefined();
    });

    it('should return undefined for unknown workflow name', () => {
      expect(engine.getRun('nonexistent-name')).toBeUndefined();
    });
  });

  describe('listRuns()', () => {
    it('should return empty list for fresh engine', () => {
      expect(engine.listRuns()).toEqual([]);
    });
  });

  describe('getStats()', () => {
    it('should return zero stats for fresh engine', () => {
      const stats = engine.getStats();
      expect(stats.totalRuns).toBe(0);
      expect(stats.activeRuns).toBe(0);
      expect(stats.completedRuns).toBe(0);
      expect(stats.failedRuns).toBe(0);
      expect(stats.totalRetries).toBe(0);
      expect(stats.totalRollbacks).toBe(0);
      expect(stats.totalCompensations).toBe(0);
    });
  });

  describe('getRunsByGroup()', () => {
    it('should return empty object for fresh engine', () => {
      expect(Object.keys(engine.getRunsByGroup())).toHaveLength(0);
    });
  });

  describe('cancel()', () => {
    it('should return false for unknown run', () => {
      expect(engine.cancel('nonexistent')).toBe(false);
    });
  });

  describe('listPendingApprovals()', () => {
    it('should return empty array when nothing pending', () => {
      expect(engine.listPendingApprovals()).toEqual([]);
    });
  });

  describe('submitApproval()', () => {
    it('should return false for unknown approval id', () => {
      expect(engine.submitApproval('fake-id', 'APPROVED')).toBe(false);
    });
  });

  describe('tick()', () => {
    it('should not throw with no active runs', () => {
      expect(() => engine.tick()).not.toThrow();
    });
  });

  describe('getSystemLoad()', () => {
    it('should return valid system load info', () => {
      const load = engine.getSystemLoad();
      expect(load.cpuCount).toBeGreaterThan(0);
      expect(typeof load.load1).toBe('number');
      expect(typeof load.load5).toBe('number');
      expect(typeof load.load15).toBe('number');
      expect(typeof load.overloaded).toBe('boolean');
    });
  });

  describe('setLogLevel()', () => {
    it('should not throw', () => {
      expect(() => engine.setLogLevel(0)).not.toThrow();
      expect(() => engine.setLogLevel(3)).not.toThrow();
    });
  });

  describe('setLifecycle()', () => {
    it('should accept lifecycle hooks', () => {
      expect(() => engine.setLifecycle({
        onStepCompleted: vi.fn(),
        onStepFailed: vi.fn(),
      })).not.toThrow();
    });
  });

  describe('getLearningRecords()', () => {
    it('should return empty array for non-existent group', () => {
      expect(engine.getLearningRecords('nonexistent')).toEqual([]);
    });
  });

  describe('getQualitySummary()', () => {
    it('should return zero summary for non-existent group', () => {
      const summary = engine.getQualitySummary('nonexistent');
      expect(summary.count).toBe(0);
      expect(summary.avgTotal).toBe(0);
    });
  });

  describe('execute()', () => {
    it('should return a WorkflowRunRecord with RUNNING status', () => {
      const def = makeDef({
        steps: [{ id: 'step1', agent: 'test-agent', action: 'create', prompt: 'Do something' }],
      });
      const run = engine.execute(def, 'test-group');
      expect(run.status).toBe(WorkflowStatus.RUNNING);
      expect(run.workflowName).toBe('test-workflow');
      expect(run.steps.size).toBe(1);
      expect(run.steps.get('step1')).toBe(StepStatus.PENDING);
      expect(run.group).toBe('test-group');
      expect(run.runId).toBeDefined();
      expect(run.startedAt).toBeGreaterThan(0);
    });

    it('should register run so getRun() can retrieve it by runId', () => {
      const def = makeDef({
        steps: [{ id: 'step1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def, 'grp');
      const found = engine.getRun(run.runId);
      expect(found).toBeDefined();
      expect(found!.runId).toBe(run.runId);
    });

    it('should register run so getRun() can retrieve it by workflow name', () => {
      const def = makeDef({
        name: 'my-workflow',
        steps: [{ id: 'step1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def);
      const found = engine.getRun('my-workflow');
      expect(found).toBeDefined();
      expect(found!.runId).toBe(run.runId);
    });

    it('should include step in listRuns()', () => {
      const def = makeDef({
        steps: [{ id: 'step1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      engine.execute(def);
      const runs = engine.listRuns();
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe(WorkflowStatus.RUNNING);
    });

    it('should increment stats', () => {
      const def = makeDef({
        steps: [{ id: 'step1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      engine.execute(def);
      const stats = engine.getStats();
      expect(stats.totalRuns).toBe(1);
      expect(stats.activeRuns).toBe(1);
    });

    it('should set group on run record', () => {
      const def = makeDef({
        steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def, 'my-group');
      expect(run.group).toBe('my-group');
    });

    it('should handle workflow with no group', () => {
      const def = makeDef({
        steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def);
      expect(run.group).toBeUndefined();
    });

    it('should auto-complete trigger steps', async () => {
      const def = makeDef({
        steps: [
          { id: 't1', type: 'trigger', trigger: { type: 'manual' } },
          { id: 's1', agent: 'a', action: 'execute', prompt: 'Do it' },
        ],
      });
      engine.execute(def, 'grp');
      // Wait for execution to complete
      await new Promise(r => setTimeout(r, 1500));
      const run = engine.getRun(def.name);
      expect(run).toBeDefined();
      expect(run!.steps.get('t1')).toBe(StepStatus.COMPLETED);
    });
  });

  describe('callback()', () => {
    it('should return false for unknown run', () => {
      expect(engine.callback('nonexistent', 'step1', 'output')).toBe(false);
    });

    it('should return false for non-running workflow', () => {
      const def = makeDef({
        steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def, 'grp');
      // Manually mark as completed
      run.status = WorkflowStatus.COMPLETED;
      expect(engine.callback(run.runId, 's1', 'some output')).toBe(false);
    });

    it('should return false for step not in WAITING status', () => {
      const def = makeDef({
        steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def, 'grp');
      // step1 starts as PENDING, not WAITING
      expect(engine.callback(run.runId, 's1', 'output')).toBe(false);
    });
  });

  describe('claim()', () => {
    it('should return false for unknown run', () => {
      expect(engine.claim('nonexistent', 'step1', 'agent1')).toBe(false);
    });

    it('should return false for non-running workflow', () => {
      const def = makeDef({
        steps: [{ id: 's1', type: 'claim', agents: ['a1', 'a2'], action: 'execute', prompt: 'p' }],
      });
      const run = engine.execute(def, 'grp');
      run.status = WorkflowStatus.COMPLETED;
      expect(engine.claim(run.runId, 's1', 'a1')).toBe(false);
    });
  });

  describe('tick()', () => {
    it('should not throw with active runs', () => {
      const def = makeDef({
        steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }],
      });
      engine.execute(def, 'grp');
      expect(() => engine.tick()).not.toThrow();
    });

    it('should handle tick with multiple runs', () => {
      const def1 = makeDef({ name: 'wf1', steps: [{ id: 's1', agent: 'a', action: 'execute', prompt: 'p' }] });
      const def2 = makeDef({ name: 'wf2', steps: [{ id: 's1', agent: 'b', action: 'execute', prompt: 'q' }] });
      engine.execute(def1, 'grp');
      engine.execute(def2, 'grp');
      expect(() => engine.tick()).not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════ State Machine ═══

describe('State Machine', () => {
  describe('isValidTransition()', () => {
    it('should allow PENDING -> IN_PROGRESS', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.IN_PROGRESS)).toBe(true);
    });

    it('should allow PENDING -> BLOCKED', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.BLOCKED)).toBe(true);
    });

    it('should allow PENDING -> WAITING', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.WAITING)).toBe(true);
    });

    it('should allow PENDING -> FAILED', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.FAILED)).toBe(true);
    });

    it('should allow PENDING -> SKIPPED', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.SKIPPED)).toBe(true);
    });

    it('should reject PENDING -> COMPLETED (must go through IN_PROGRESS)', () => {
      expect(isValidTransition(StepStatus.PENDING, StepStatus.COMPLETED)).toBe(false);
    });

    it('should allow IN_PROGRESS -> WAITING', () => {
      expect(isValidTransition(StepStatus.IN_PROGRESS, StepStatus.WAITING)).toBe(true);
    });

    it('should allow IN_PROGRESS -> COMPLETED', () => {
      expect(isValidTransition(StepStatus.IN_PROGRESS, StepStatus.COMPLETED)).toBe(true);
    });

    it('should allow IN_PROGRESS -> FAILED', () => {
      expect(isValidTransition(StepStatus.IN_PROGRESS, StepStatus.FAILED)).toBe(true);
    });

    it('should reject IN_PROGRESS -> BLOCKED', () => {
      expect(isValidTransition(StepStatus.IN_PROGRESS, StepStatus.BLOCKED)).toBe(false);
    });

    it('should reject IN_PROGRESS -> PENDING', () => {
      expect(isValidTransition(StepStatus.IN_PROGRESS, StepStatus.PENDING)).toBe(false);
    });

    it('should allow WAITING -> COMPLETED', () => {
      expect(isValidTransition(StepStatus.WAITING, StepStatus.COMPLETED)).toBe(true);
    });

    it('should allow WAITING -> FAILED', () => {
      expect(isValidTransition(StepStatus.WAITING, StepStatus.FAILED)).toBe(true);
    });

    it('should allow WAITING -> IN_PROGRESS', () => {
      expect(isValidTransition(StepStatus.WAITING, StepStatus.IN_PROGRESS)).toBe(true);
    });

    it('should reject WAITING -> PENDING', () => {
      expect(isValidTransition(StepStatus.WAITING, StepStatus.PENDING)).toBe(false);
    });

    it('should allow BLOCKED -> PENDING (retry)', () => {
      expect(isValidTransition(StepStatus.BLOCKED, StepStatus.PENDING)).toBe(true);
    });

    it('should allow BLOCKED -> SKIPPED', () => {
      expect(isValidTransition(StepStatus.BLOCKED, StepStatus.SKIPPED)).toBe(true);
    });

    it('should allow FAILED -> PENDING (retry)', () => {
      expect(isValidTransition(StepStatus.FAILED, StepStatus.PENDING)).toBe(true);
    });

    it('should reject FAILED -> COMPLETED', () => {
      expect(isValidTransition(StepStatus.FAILED, StepStatus.COMPLETED)).toBe(false);
    });

    it('should reject COMPLETED -> any (terminal state)', () => {
      expect(isValidTransition(StepStatus.COMPLETED, StepStatus.PENDING)).toBe(false);
      expect(isValidTransition(StepStatus.COMPLETED, StepStatus.IN_PROGRESS)).toBe(false);
      expect(isValidTransition(StepStatus.COMPLETED, StepStatus.FAILED)).toBe(false);
      expect(isValidTransition(StepStatus.COMPLETED, StepStatus.COMPLETED)).toBe(false);
    });

    it('should reject SKIPPED -> any (terminal state)', () => {
      expect(isValidTransition(StepStatus.SKIPPED, StepStatus.PENDING)).toBe(false);
      expect(isValidTransition(StepStatus.SKIPPED, StepStatus.IN_PROGRESS)).toBe(false);
      expect(isValidTransition(StepStatus.SKIPPED, StepStatus.FAILED)).toBe(false);
      expect(isValidTransition(StepStatus.SKIPPED, StepStatus.COMPLETED)).toBe(false);
    });

    it('should have transition map for all StepStatus values', () => {
      for (const status of Object.values(StepStatus)) {
        expect(VALID_TRANSITIONS[status]).toBeDefined();
        expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
      }
    });
  });

  describe('transition()', () => {
    function makeNode(status: StepStatus = StepStatus.PENDING): DagNode {
      return {
        step: { id: 'step1', agent: 'a', action: 'execute', prompt: 'p' },
        deps: [], dependents: [], status, output: '', error: '',
        retryCount: 0, maxRetries: 3, rejectCount: 0, maxRejectRetries: 3,
        timeout: 300000, startedAt: 0, notifiedAt: 0,
      };
    }

    function makeRun(stepStatus: StepStatus = StepStatus.PENDING): WorkflowRunRecord {
      return {
        runId: 'test-run', workflowName: 'test', startedAt: Date.now(),
        status: WorkflowStatus.RUNNING,
        steps: new Map([['step1', stepStatus]]),
        stepRetries: new Map(), rollbacks: [], compensations: [],
        taskReports: new Map(),
      };
    }

    it('should succeed for valid PENDING -> IN_PROGRESS', () => {
      const run = makeRun();
      const node = makeNode();
      expect(transition(run, node, StepStatus.IN_PROGRESS)).toBe(true);
      expect(node.status).toBe(StepStatus.IN_PROGRESS);
      expect(run.steps.get('step1')).toBe(StepStatus.IN_PROGRESS);
    });

    it('should succeed for valid IN_PROGRESS -> COMPLETED', () => {
      const run = makeRun(StepStatus.IN_PROGRESS);
      const node = makeNode(StepStatus.IN_PROGRESS);
      expect(transition(run, node, StepStatus.COMPLETED)).toBe(true);
      expect(node.status).toBe(StepStatus.COMPLETED);
      expect(run.steps.get('step1')).toBe(StepStatus.COMPLETED);
    });

    it('should fail for invalid PENDING -> COMPLETED', () => {
      const run = makeRun();
      const node = makeNode();
      expect(transition(run, node, StepStatus.COMPLETED)).toBe(false);
      expect(node.status).toBe(StepStatus.PENDING);
      expect(run.steps.get('step1')).toBe(StepStatus.PENDING);
    });

    it('should fail for terminal COMPLETED -> any', () => {
      const run = makeRun(StepStatus.COMPLETED);
      const node = makeNode(StepStatus.COMPLETED);
      expect(transition(run, node, StepStatus.FAILED)).toBe(false);
      expect(node.status).toBe(StepStatus.COMPLETED);
    });

    it('should succeed for FAILED -> PENDING (retry)', () => {
      const run = makeRun(StepStatus.FAILED);
      const node = makeNode(StepStatus.FAILED);
      expect(transition(run, node, StepStatus.PENDING)).toBe(true);
      expect(node.status).toBe(StepStatus.PENDING);
    });

    it('should complete full valid chain', () => {
      const run = makeRun();
      const node = makeNode();

      expect(transition(run, node, StepStatus.IN_PROGRESS)).toBe(true);
      expect(transition(run, node, StepStatus.WAITING)).toBe(true);
      expect(transition(run, node, StepStatus.COMPLETED)).toBe(true);
      expect(node.status).toBe(StepStatus.COMPLETED);
    });

    it('should keep run.steps map in sync with node.status', () => {
      const run = makeRun();
      const node = makeNode();
      transition(run, node, StepStatus.IN_PROGRESS);
      expect(run.steps.get('step1')).toBe(node.status);
      transition(run, node, StepStatus.WAITING);
      expect(run.steps.get('step1')).toBe(node.status);
    });
  });
});

// ═══════════════════════════════════════════════════ YAML Parsing ═══

describe('parseWorkflowYaml()', () => {
  it('should parse a basic workflow', () => {
    const yaml = `
name: test-wf
description: A test workflow
steps:
  - id: step1
    agent: alice
    action: create
    prompt: Do something
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.name).toBe('test-wf');
    expect(def.description).toBe('A test workflow');
    expect(def.steps).toHaveLength(1);
    expect(def.steps[0]).toMatchObject({
      id: 'step1', agent: 'alice', action: 'create', prompt: 'Do something',
    });
  });

  it('should parse steps with dependsOn', () => {
    const yaml = `
name: chain
steps:
  - id: s1
    agent: a1
    action: create
  - id: s2
    agent: a2
    action: review
    dependsOn:
      - s1
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[1].dependsOn).toEqual(['s1']);
  });

  it('should support snake_case depends_on (string)', () => {
    const yaml = `
name: snake
steps:
  - id: s1
    agent: a
    action: create
  - id: s2
    agent: b
    action: review
    depends_on: s1
`;
    expect(parseWorkflowYaml(yaml).steps[1].dependsOn).toEqual(['s1']);
  });

  it('should support snake_case depends_on (array)', () => {
    const yaml = `
name: snake2
steps:
  - id: s1
    agent: a
    action: create
  - id: s2
    agent: b
    action: review
    depends_on:
      - s1
`;
    expect(parseWorkflowYaml(yaml).steps[1].dependsOn).toEqual(['s1']);
  });

  it('should parse trigger type steps', () => {
    const yaml = `
name: trigger-wf
steps:
  - id: t1
    type: trigger
    trigger:
      type: manual
  - id: s1
    agent: a
    action: create
    prompt: do it
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].type).toBe('trigger');
    expect(def.steps[0].trigger!.type).toBe('manual');
    expect(def.steps[1].type).toBe('step');
  });

  it('should auto-detect trigger type from trigger field', () => {
    const yaml = `
name: auto-trigger
steps:
  - id: t1
    trigger:
      type: event
      event_type: file_change
`;
    expect(parseWorkflowYaml(yaml).steps[0].type).toBe('trigger');
  });

  it('should parse routing rules', () => {
    const yaml = `
name: route-wf
steps:
  - id: s1
    agent: a
    action: review
    routes:
      - step: s2-approved
        when: output contains APPROVED
      - step: s2-rejected
        when: output contains REJECTED
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].routes).toHaveLength(2);
    expect(def.steps[0].routes![0]).toEqual({ step: 's2-approved', when: 'output contains APPROVED' });
  });

  it('should parse routes with condition/target aliases', () => {
    const yaml = `
name: route-alias
steps:
  - id: s1
    agent: a
    action: review
    routes:
      - target: s2
        condition: output contains PASS
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].routes![0]).toEqual({ step: 's2', when: 'output contains PASS' });
  });

  it('should parse workflow-level trigger', () => {
    const yaml = `
name: scheduled
trigger:
  type: schedule
  cron: "0 9 * * 1-5"
steps:
  - id: s1
    agent: a
    action: execute
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.trigger).toMatchObject({ type: 'schedule', cron: '0 9 * * 1-5' });
  });

  it('should parse step trigger with full event config', () => {
    const yaml = `
name: event-trigger
steps:
  - id: t1
    type: trigger
    trigger:
      type: event
      event_type: file_change
      watch_file: config.yaml
      debounce_ms: 3000
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].trigger).toMatchObject({
      eventType: 'file_change', watchFile: 'config.yaml', debounceMs: 3000,
    });
  });

  it('should parse trigger with event_filter', () => {
    const yaml = `
name: filter-trigger
steps:
  - id: t1
    type: trigger
    trigger:
      type: event
      event_type: task.created
      event_filter:
        group: dev
        agent: coder
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].trigger!.eventFilter).toEqual({ group: 'dev', agent: 'coder' });
  });

  it('should throw on invalid YAML', () => {
    expect(() => parseWorkflowYaml('')).toThrow('Invalid workflow YAML');
    expect(() => parseWorkflowYaml('plain text')).toThrow('Invalid workflow YAML');
  });

  it('should throw on duplicate step IDs', () => {
    const yaml = `
name: dupes
steps:
  - id: s1
    agent: a
    action: create
  - id: s1
    agent: b
    action: review
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(/重复的步骤 ID/);
  });

  it('should detect circular dependencies (2 steps)', () => {
    const yaml = `
name: circular
steps:
  - id: s1
    agent: a
    action: create
    dependsOn:
      - s2
  - id: s2
    agent: b
    action: review
    dependsOn:
      - s1
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(/循环依赖/);
  });

  it('should detect circular dependencies (3 steps)', () => {
    const yaml = `
name: circular3
steps:
  - id: s1
    agent: a
    action: create
    dependsOn:
      - s3
  - id: s2
    agent: b
    action: review
    dependsOn:
      - s1
  - id: s3
    agent: c
    action: deploy
    dependsOn:
      - s2
`;
    expect(() => parseWorkflowYaml(yaml)).toThrow(/循环依赖/);
  });

  it('should parse retry, timeout, priority, maxRejectRetries', () => {
    const yaml = `
name: settings
steps:
  - id: s1
    agent: a
    action: execute
    retry: 5
    retry_backoff: exponential
    timeout: 60000
    priority: high
    maxRejectRetries: 2
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({
      retry: 5, retryBackoff: 'exponential', timeout: 60000,
      priority: 'high', maxRejectRetries: 2,
    });
  });

  it('should cap retry at 10', () => {
    const yaml = `
name: cap
steps:
  - id: s1
    agent: a
    action: execute
    retry: 99
`;
    expect(parseWorkflowYaml(yaml).steps[0].retry).toBe(10);
  });

  it('should cap maxRejectRetries at 10', () => {
    const yaml = `
name: cap
steps:
  - id: s1
    agent: a
    action: execute
    max_reject_retries: 99
`;
    expect(parseWorkflowYaml(yaml).steps[0].maxRejectRetries).toBe(10);
  });

  it('should use "tasks" as alias for "steps"', () => {
    const yaml = `
name: alias
tasks:
  - id: s1
    agent: a
    action: execute
`;
    expect(parseWorkflowYaml(yaml).steps).toHaveLength(1);
  });

  it('should default missing fields', () => {
    const yaml = `
name: defaults
steps:
  - id: s1
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({
      agent: 'unknown', action: 'execute', type: 'step', prompt: '', timeout: 300000,
    });
  });

  it('should parse onFailure, onReject, onApprove (camelCase)', () => {
    const yaml = `
name: hooks
steps:
  - id: s1
    agent: a
    action: create
    onFailure: comp-step
    onReject: retry-step
    onApprove: next-step
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({
      onFailure: 'comp-step', onReject: 'retry-step', onApprove: 'next-step',
    });
  });

  it('should parse onFailure, onReject, onApprove (snake_case)', () => {
    const yaml = `
name: snake-hooks
steps:
  - id: s1
    agent: a
    action: create
    on_failure: comp-step
    on_reject: retry-step
    on_approve: next-step
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({
      onFailure: 'comp-step', onReject: 'retry-step', onApprove: 'next-step',
    });
  });

  it('should parse reviewer and reviewPrompt', () => {
    const yaml = `
name: review
steps:
  - id: s1
    agent: a
    action: create
    reviewer: reviewer-agent
    reviewPrompt: Please review
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({
      reviewer: 'reviewer-agent', reviewPrompt: 'Please review',
    });
  });

  it('should parse snake_case review_prompt', () => {
    const yaml = `
name: review-snake
steps:
  - id: s1
    agent: a
    action: create
    review_prompt: Custom prompt
`;
    expect(parseWorkflowYaml(yaml).steps[0].reviewPrompt).toBe('Custom prompt');
  });

  it('should parse reward and budget', () => {
    const yaml = `
name: tokens
steps:
  - id: s1
    agent: a
    action: execute
    reward: 100
    budget: 500
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0]).toMatchObject({ reward: 100, budget: 500 });
  });

  it('should parse concurrency', () => {
    const yaml = `
name: concurrent
concurrency: 4
steps:
  - id: s1
    agent: a
    action: execute
`;
    expect(parseWorkflowYaml(yaml).concurrency).toBe(4);
  });

  it('should default name to "unnamed" when missing', () => {
    const yaml = `
steps:
  - id: s1
    agent: a
    action: execute
`;
    expect(parseWorkflowYaml(yaml).name).toBe('unnamed');
  });

  it('should parse notify field', () => {
    const yaml = `
name: notify-wf
steps:
  - id: s1
    agent: a
    action: create
    notify:
      - reviewer1
      - reviewer2
`;
    expect(parseWorkflowYaml(yaml).steps[0].notify).toEqual(['reviewer1', 'reviewer2']);
  });

  it('should parse condition field', () => {
    const yaml = `
name: cond-wf
steps:
  - id: s1
    agent: a
    action: create
    condition: "env == 'production'"
`;
    expect(parseWorkflowYaml(yaml).steps[0].condition).toBe("env == 'production'");
  });

  it('should handle non-circular valid dependencies', () => {
    const yaml = `
name: valid
steps:
  - id: s1
    agent: a
    action: create
  - id: s2
    agent: b
    action: review
    dependsOn:
      - s1
  - id: s3
    agent: c
    action: deploy
    dependsOn:
      - s2
`;
    expect(() => parseWorkflowYaml(yaml)).not.toThrow();
    const def = parseWorkflowYaml(yaml);
    expect(def.steps).toHaveLength(3);
  });

  it('should handle step with no deps (entry point)', () => {
    const yaml = `
name: entry
steps:
  - id: s1
    agent: a
    action: create
`;
    const def = parseWorkflowYaml(yaml);
    expect(def.steps[0].dependsOn).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════ Utility Functions ═══

describe('phaseForAction()', () => {
  it('should map review to REVIEW phase', () => {
    expect(phaseForAction('review')).toBe(WorkflowPhase.REVIEW);
    expect(phaseForAction('code_review')).toBe(WorkflowPhase.REVIEW);
  });

  it('should map deploy to DEPLOY phase', () => {
    expect(phaseForAction('deploy')).toBe(WorkflowPhase.DEPLOY);
    expect(phaseForAction('production_deploy')).toBe(WorkflowPhase.DEPLOY);
  });

  it('should map verify/test to VERIFY phase', () => {
    expect(phaseForAction('verify')).toBe(WorkflowPhase.VERIFY);
    expect(phaseForAction('test')).toBe(WorkflowPhase.VERIFY);
    expect(phaseForAction('run_tests')).toBe(WorkflowPhase.VERIFY);
  });

  it('should map fix/notify/rollback to COMPENSATION phase', () => {
    expect(phaseForAction('compensate')).toBe(WorkflowPhase.COMPENSATION);
    expect(phaseForAction('notify')).toBe(WorkflowPhase.COMPENSATION);
    expect(phaseForAction('rollback')).toBe(WorkflowPhase.COMPENSATION);
  });

  it('should map design to DESIGN phase', () => {
    expect(phaseForAction('design')).toBe(WorkflowPhase.DESIGN);
  });

  it('should map require to REQUIREMENT phase', () => {
    expect(phaseForAction('requirement')).toBe(WorkflowPhase.REQUIREMENT);
  });

  it('should default to COMPLETED for unknown/empty actions', () => {
    expect(phaseForAction('create')).toBe(WorkflowPhase.COMPLETED);
    expect(phaseForAction('execute')).toBe(WorkflowPhase.COMPLETED);
    expect(phaseForAction(undefined)).toBe(WorkflowPhase.COMPLETED);
    expect(phaseForAction('')).toBe(WorkflowPhase.COMPLETED);
  });

  it('should be case insensitive', () => {
    expect(phaseForAction('REVIEW')).toBe(WorkflowPhase.REVIEW);
    expect(phaseForAction('Deploy')).toBe(WorkflowPhase.DEPLOY);
    expect(phaseForAction('VERIFY')).toBe(WorkflowPhase.VERIFY);
  });
});

describe('parseReviewFindings()', () => {
  it('should return empty array for NO_ISSUES', () => {
    expect(parseReviewFindings('NO_ISSUES')).toEqual([]);
  });

  it('should parse single ISSUE line', () => {
    const findings = parseReviewFindings('ISSUE|src/foo.ts:42|Bug in function|Fix the bug');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      file: 'src/foo.ts', line: 42, desc: 'Bug in function', fix: 'Fix the bug',
    });
  });

  it('should parse multiple ISSUE lines', () => {
    const output = [
      'ISSUE|src/lib/foo.ts:42|Bug in function|Fix the bug',
      'ISSUE|src/lib/bar.ts:100|Missing null check|Add guard',
    ].join('\n');
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(2);
    expect(findings[0].file).toBe('src/lib/foo.ts');
    expect(findings[0].line).toBe(42);
    expect(findings[1].file).toBe('src/lib/bar.ts');
    expect(findings[1].line).toBe(100);
  });

  it('should handle mixed content with ISSUE lines', () => {
    const output = 'REVIEW_COMPLETE ACTION:review\nISSUE|file.ts:1|problem|fix\nDONE';
    expect(parseReviewFindings(output)).toHaveLength(1);
  });

  it('should return empty for text without ISSUE lines', () => {
    expect(parseReviewFindings('Just some normal text')).toEqual([]);
    expect(parseReviewFindings('REVIEW_COMPLETE\nAPPROVED')).toEqual([]);
  });

  it('should handle ISSUE lines with whitespace in fields', () => {
    const output = 'ISSUE|src/index.ts:10|Space in desc|Space in fix';
    const findings = parseReviewFindings(output);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: 'src/index.ts', line: 10 });
  });
});

describe('getAgents()', () => {
  it('should return single agent from agent field', () => {
    expect(getAgents({ id: 's', agent: 'alice' })).toEqual(['alice']);
  });

  it('should combine agent + agents fields', () => {
    expect(getAgents({ id: 's', agent: 'alice', agents: ['bob', 'charlie'] })).toEqual(
      ['alice', 'bob', 'charlie']
    );
  });

  it('should deduplicate agents', () => {
    expect(getAgents({ id: 's', agent: 'alice', agents: ['alice', 'bob'] })).toEqual(
      ['alice', 'bob']
    );
  });

  it('should return empty array when no agent fields', () => {
    expect(getAgents({ id: 's' })).toEqual([]);
  });

  it('should handle only agents field', () => {
    expect(getAgents({ id: 's', agents: ['x', 'y'] })).toEqual(['x', 'y']);
  });

  it('should filter out undefined values', () => {
    expect(getAgents({ id: 's', agents: ['a', undefined as any, 'b'] })).toEqual(['a', 'b']);
  });
});

// ═══════════════════════════════════════════════════ evalRouteCondition ═══

describe('evalRouteCondition()', () => {
  it('should return false for empty when', () => {
    expect(evalRouteCondition('', 'some output')).toBe(false);
  });

  it('should match output contains X', () => {
    expect(evalRouteCondition('output contains APPROVED', 'REVIEW COMPLETE APPROVED')).toBe(true);
    expect(evalRouteCondition('output contains APPROVED', 'REVIEW COMPLETE REJECTED')).toBe(false);
  });

  it('should match output == X (exact)', () => {
    expect(evalRouteCondition('output == deploy', 'deploy')).toBe(true);
    expect(evalRouteCondition('output == deploy', 'deployed')).toBe(false);
  });

  it('should match output != X', () => {
    expect(evalRouteCondition('output != deploy', 'deploy')).toBe(false);
    expect(evalRouteCondition('output != deploy', 'skip')).toBe(true);
  });

  it('should match shorthand contains (e.g. "APPROVED")', () => {
    expect(evalRouteCondition('APPROVED', 'Step output: APPROVED')).toBe(true);
    expect(evalRouteCondition('APPROVED', 'Step output: REJECTED')).toBe(false);
  });

  it('should evaluate success() status function', () => {
    expect(evalRouteCondition('success()', 'anything', 'completed')).toBe(true);
    expect(evalRouteCondition('success()', 'anything')).toBe(true);
    expect(evalRouteCondition('success()', 'anything', 'failed')).toBe(false);
  });

  it('should evaluate failure() status function', () => {
    expect(evalRouteCondition('failure()', 'anything', 'failed')).toBe(true);
    expect(evalRouteCondition('failure()', 'anything', 'completed')).toBe(false);
  });

  it('should evaluate always() status function', () => {
    expect(evalRouteCondition('always()', 'anything', 'completed')).toBe(true);
    expect(evalRouteCondition('always()', 'anything', 'failed')).toBe(true);
    expect(evalRouteCondition('always()', 'anything')).toBe(true);
  });

  it('should evaluate NOT operator', () => {
    expect(evalRouteCondition('!APPROVED', 'REJECTED')).toBe(true);
    expect(evalRouteCondition('!APPROVED', 'APPROVED')).toBe(false);
  });

  it('should evaluate AND compound conditions', () => {
    expect(evalRouteCondition('output contains APPROVED AND output contains PASS', 'APPROVED and PASS')).toBe(true);
    expect(evalRouteCondition('output contains APPROVED AND output contains PASS', 'APPROVED only')).toBe(false);
  });

  it('should evaluate OR compound conditions', () => {
    expect(evalRouteCondition('output contains APPROVED OR output contains PASS', 'APPROVED')).toBe(true);
    expect(evalRouteCondition('output contains APPROVED OR output contains PASS', 'PASS')).toBe(true);
    expect(evalRouteCondition('output contains APPROVED OR output contains PASS', 'REJECTED')).toBe(false);
  });

  it('should evaluate contains() function', () => {
    expect(evalRouteCondition("contains('output', 'hello')", 'hello world')).toBe(true);
    expect(evalRouteCondition("contains('output', 'hello')", 'goodbye world')).toBe(false);
  });

  it('should evaluate startsWith() function', () => {
    expect(evalRouteCondition("startsWith('output', 'hello')", 'hello world')).toBe(true);
    expect(evalRouteCondition("startsWith('output', 'hello')", 'say hello')).toBe(false);
  });

  it('should evaluate endsWith() function', () => {
    expect(evalRouteCondition("endsWith('output', 'world')", 'hello world')).toBe(true);
    expect(evalRouteCondition("endsWith('output', 'world')", 'hello')).toBe(false);
  });

  it('should evaluate regex pattern', () => {
    expect(evalRouteCondition('regex:\\d+', 'score is 42')).toBe(true);
    expect(evalRouteCondition('regex:^ERROR', 'ERROR: something failed')).toBe(true);
    expect(evalRouteCondition('regex:^ERROR', 'something failed')).toBe(false);
  });

  it('should evaluate score threshold', () => {
    expect(evalRouteCondition('score > 30', 'total: 35 / 40')).toBe(true);
    expect(evalRouteCondition('score > 30', 'total: 25 / 40')).toBe(false);
    expect(evalRouteCondition('total >= 28', '28 / 40')).toBe(true);
    expect(evalRouteCondition('total >= 28', '27 / 40')).toBe(false);
  });

  it('should handle case insensitivity', () => {
    expect(evalRouteCondition('output contains approved', 'APPROVED')).toBe(true);
    expect(evalRouteCondition('APPROVED', 'step output: approved')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════ SimulatedStepExecutor ═══

describe('SimulatedStepExecutor', () => {
  const executor = new SimulatedStepExecutor();

  it('should produce review output with findings', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'reviewer', action: 'review', prompt: 'Review this' }, {}
    );
    expect(result).toContain('REVIEW_COMPLETE');
    expect(result).toContain('APPROVED');
    expect(result).toContain('ISSUE|');
  });

  it('should include prior findings in re-review', async () => {
    const ctx = { 'step1': 'ISSUE|src/foo.ts:10|Bug|Fix it' };
    const result = await executor.execute(
      { id: 's', agent: 'reviewer', action: 'review', prompt: 'Review' }, ctx
    );
    const issueCount = (result.match(/ISSUE\|/g) || []).length;
    expect(issueCount).toBe(3); // 2 default + 1 from context
  });

  it('should produce fix output with findings from context', async () => {
    const ctx = { 'step1': 'ISSUE|src/foo.ts:10|Bug|Fix it' };
    const result = await executor.execute(
      { id: 's', agent: 'fixer', action: 'fix', prompt: 'Fix issues' }, ctx
    );
    expect(result).toContain('FIXED');
    expect(result).toContain('1 issues');
  });

  it('should produce fix output without context findings', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'fixer', action: 'fix', prompt: 'Fix' }, {}
    );
    expect(result).toContain('FIXED');
  });

  it('should produce approve output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'lead', action: 'approve', prompt: 'Approve' }, {}
    );
    expect(result).toContain('APPROVED');
  });

  it('should produce reject output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'lead', action: 'reject', prompt: 'Reject' }, {}
    );
    expect(result).toContain('REJECTED');
  });

  it('should produce deploy output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'ops', action: 'deploy', prompt: 'Deploy' }, {}
    );
    expect(result).toContain('DEPLOYED+PASSED');
  });

  it('should produce verify output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'qa', action: 'verify', prompt: 'Verify' }, {}
    );
    expect(result).toContain('VERIFIED');
  });

  it('should produce verify output for test action', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'qa', action: 'test', prompt: 'Test' }, {}
    );
    expect(result).toContain('VERIFIED');
  });

  it('should produce default COMPLETED output for create', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'dev', action: 'create', prompt: 'Create' }, {}
    );
    expect(result).toContain('COMPLETED');
    expect(result).toContain('ACTION:create');
    expect(result).toContain('AGENT:dev');
  });

  it('should produce notify output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'bot', action: 'notify', prompt: 'Notify' }, {}
    );
    expect(result).toContain('NOTIFIED');
  });

  it('should default agent to unknown when not set', async () => {
    const result = await executor.execute(
      { id: 's', action: 'create', prompt: 'Do it' }, {}
    );
    expect(result).toContain('AGENT:unknown');
  });

  it('should handle 修复 (Chinese fix) action', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'dev', action: '修复', prompt: 'Fix bugs' }, {}
    );
    expect(result).toContain('FIXED');
  });

  it('should handle multiple findings in context for fix', async () => {
    const ctx = {
      'step1': 'ISSUE|a.ts:1|Bug1|Fix1\nISSUE|b.ts:2|Bug2|Fix2\nISSUE|c.ts:3|Bug3|Fix3',
    };
    const result = await executor.execute(
      { id: 's', agent: 'fixer', action: 'fix', prompt: 'Fix' }, ctx
    );
    expect(result).toContain('FIXED');
    expect(result).toContain('3 issues');
  });

  it('should include agent name in output', async () => {
    const result = await executor.execute(
      { id: 's', agent: 'myagent', action: 'create', prompt: 'Do it' }, {}
    );
    expect(result).toContain('AGENT:myagent');
  });
});

// ═══════════════════════════════════════════════════ Enums ═══

describe('WorkflowPhase enum', () => {
  it('should have all 8 expected phases', () => {
    expect(WorkflowPhase.REQUIREMENT).toBe('requirement');
    expect(WorkflowPhase.DESIGN).toBe('design');
    expect(WorkflowPhase.REVIEW).toBe('review');
    expect(WorkflowPhase.APPROVAL).toBe('approval');
    expect(WorkflowPhase.DEPLOY).toBe('deploy');
    expect(WorkflowPhase.VERIFY).toBe('verify');
    expect(WorkflowPhase.COMPENSATION).toBe('compensation');
    expect(WorkflowPhase.COMPLETED).toBe('completed');
  });
});

describe('StepStatus enum', () => {
  it('should have all 7 expected statuses', () => {
    expect(StepStatus.PENDING).toBe('pending');
    expect(StepStatus.BLOCKED).toBe('blocked');
    expect(StepStatus.IN_PROGRESS).toBe('in_progress');
    expect(StepStatus.WAITING).toBe('waiting');
    expect(StepStatus.COMPLETED).toBe('completed');
    expect(StepStatus.SKIPPED).toBe('skipped');
    expect(StepStatus.FAILED).toBe('failed');
  });
});

describe('WorkflowStatus enum', () => {
  it('should have all 4 expected statuses', () => {
    expect(WorkflowStatus.IDLE).toBe('idle');
    expect(WorkflowStatus.RUNNING).toBe('running');
    expect(WorkflowStatus.COMPLETED).toBe('completed');
    expect(WorkflowStatus.FAILED).toBe('failed');
  });
});
