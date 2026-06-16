/**
 * Workflow Engine — Type Definitions & Utilities
 *
 * All enums, interfaces, type guards, and standalone utility functions
 * used across the workflow engine modules.
 */

import * as yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { MIND_DIR } from '../data-dir';
import { createLogger } from '@/lib/logger';

const sharedLog = createLogger('workflow');

// ═══════════════════════════════════════════════════ Enums ═══

export enum StepStatus { PENDING = 'pending', BLOCKED = 'blocked', IN_PROGRESS = 'in_progress', WAITING = 'waiting', COMPLETED = 'completed', SKIPPED = 'skipped', FAILED = 'failed' }
export enum WorkflowStatus { IDLE = 'idle', RUNNING = 'running', COMPLETED = 'completed', FAILED = 'failed' }

export enum LogLevel { DEBUG = 0, INFO = 1, WARN = 2, ERROR = 3 }

/** v0.3 P1: Workflow phase tags — MetaGPT-style stage markers for pipeline visualization */
export enum WorkflowPhase {
  REQUIREMENT = 'requirement', DESIGN = 'design', REVIEW = 'review',
  APPROVAL = 'approval', DEPLOY = 'deploy', VERIFY = 'verify',
  COMPENSATION = 'compensation', COMPLETED = 'completed',
}

// ═══════════════════════════════════════════════════ Logging ═══

const LOG_LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;

export class EngineLogger {
  private level: LogLevel = LogLevel.INFO;

  setLevel(level: LogLevel) { this.level = level; }

  private log(level: LogLevel, component: string, message: string, data?: unknown) {
    if (level < this.level) return;
    const msg = `[wf:${component}] ${message}`;
    if (data !== undefined) {
      if (level >= LogLevel.ERROR) sharedLog.error(msg, data);
      else if (level >= LogLevel.WARN) sharedLog.warn(msg, data);
      else sharedLog.info(msg, data);
    } else {
      if (level >= LogLevel.ERROR) sharedLog.error(msg);
      else if (level >= LogLevel.WARN) sharedLog.warn(msg);
      else sharedLog.info(msg);
    }
  }

  debug(component: string, message: string, data?: unknown) { this.log(LogLevel.DEBUG, component, message, data); }
  info(component: string, message: string, data?: unknown) { this.log(LogLevel.INFO, component, message, data); }
  warn(component: string, message: string, data?: unknown) { this.log(LogLevel.WARN, component, message, data); }
  error(component: string, message: string, data?: unknown) { this.log(LogLevel.ERROR, component, message, data); }
}

export const logger = new EngineLogger();

// ═══════════════════════════════════════════════════ Interfaces ═══

/**
 * Routing rule for step completion.
 * When a step completes, the engine evaluates `when` conditions to determine
 * which downstream step to route to.
 */
export interface WorkflowStepRoute {
  /** Target step ID to route to */
  step: string;
  /** Condition expression (e.g., "output contains APPROVED", "output == deploy") */
  when: string;
}

/**
 * Workflow step definition.
 * Each step represents a unit of work in the workflow DAG.
 */
export interface WorkflowStep {
  /** Unique step identifier within the workflow */
  id: string;
  /** Step type: 'step' (normal), 'trigger' (auto-start), 'claim' (agent claims) */
  type?: 'step' | 'trigger' | 'claim';
  /** Single agent assigned to execute this step */
  agent?: string;
  /** Multiple agents that can be notified (for claim steps) */
  agents?: string[];
  /** Action type (create, review, fix, verify, deploy, research, execute, human_approval) */
  action?: string;
  /** Prompt/instruction for the agent */
  prompt?: string;
  /** Trigger configuration (for trigger-type steps) */
  trigger?: WorkflowTrigger;
  /** Notification targets (alternative to agent) */
  notify?: string | string[];
  /** Condition expression for conditional execution */
  condition?: string;
  /** Step IDs that must complete before this step can start */
  dependsOn?: string[];
  /** Routing rules for post-completion branching */
  routes?: WorkflowStepRoute[];
  /** Timeout in ms (default: 300000 = 5min) */
  timeout?: number;
  /** Step ID to trigger on failure (compensation) */
  onFailure?: string;
  /** Step ID to trigger on review reject */
  onReject?: string;
  /** Step ID to trigger on review approve */
  onApprove?: string;
  /** Max rejection retries before failing */
  maxRejectRetries?: number;
  /** Max retry count on timeout/failure */
  retry?: number;
  /** Retry backoff strategy */
  retryBackoff?: 'fixed' | 'exponential';
  /** Priority for scheduling order */
  priority?: 'low' | 'normal' | 'high' | 'critical';
  /** Reviewer agent for auto-review */
  reviewer?: string;
  /** Custom review prompt */
  reviewPrompt?: string;
  /** Whether to self-evaluate output quality */
  evaluate?: boolean;
  /** Token reward for completing this step */
  reward?: number;
  /** Token budget for agent to spend on this step */
  budget?: number;
}

/**
 * Trigger configuration for workflow or step activation.
 */
export interface WorkflowTrigger {
  /** Trigger type */
  type: 'manual' | 'file_change' | 'schedule' | 'event';
  /** Cron expression for schedule triggers (e.g., "0 9 * * 1-5") */
  cron?: string;
  /** EventBus event type for event triggers */
  eventType?: string;
  /** Filter on event payload (e.g., { group: 'dev' }) */
  eventFilter?: { group?: string; agent?: string };
  /** File path to watch for file_change triggers */
  watchFile?: string;
  /** Debounce interval in ms for file_change triggers */
  debounceMs?: number;
}

/**
 * Complete workflow definition parsed from YAML.
 */
export interface WorkflowDefinition {
  /** Workflow name (unique within group) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Ordered list of step definitions */
  steps: WorkflowStep[];
  /** Source YAML content (for persistence) */
  source?: string;
  /** Max concurrent steps (default: 1) */
  concurrency?: number;
  /** Workflow-level trigger configuration */
  trigger?: WorkflowTrigger;
}

/**
 * Agent execution report for a completed step.
 */
export interface TaskReport {
  stepId: string;
  agent: string;
  status: string;
  summary: string;
  details: string;
  timestamp: number;
}

/**
 * Workflow execution run record.
 * Tracks the state of a single workflow execution instance.
 */
export interface WorkflowRunRecord {
  /** Unique run identifier */
  runId: string;
  /** Name of the workflow being executed */
  workflowName: string;
  /** When execution started (Unix timestamp ms) */
  startedAt: number;
  /** When execution completed (Unix timestamp ms) */
  completedAt?: number;
  /** Current workflow status */
  status: WorkflowStatus;
  /** Step status map: stepId → status */
  steps: Map<string, StepStatus>;
  /** Retry count per step */
  stepRetries: Map<string, number>;
  /** Rollback history */
  rollbacks: Array<{ stepId: string; reason: string; timestamp: number }>;
  /** Compensations triggered */
  compensations: string[];
  /** Task reports from agents */
  taskReports: Map<string, TaskReport>;
  /** Group this run belongs to */
  group?: string;
  /** Cached YAML definition for lazy DAG instantiation */
  _yamlDef?: WorkflowDefinition;
}

/**
 * Step executor interface.
 * Implement to provide custom step execution logic.
 */
export interface StepExecutor {
  execute(step: WorkflowStep, context: Record<string, string>): Promise<string>;
}

/**
 * Lifecycle hooks for step execution events.
 */
export interface StepLifecycle {
  /** Called before a step starts executing */
  onBeforeExecute?: (step: WorkflowStep, context: Record<string, string>) => Promise<void> | void;
  /** Called after a step completes successfully */
  onStepCompleted?: (step: WorkflowStep, output: string) => Promise<void> | void;
  /** Called when a step fails */
  onStepFailed?: (step: WorkflowStep, error: string) => Promise<void> | void;
  /** Called when a step is retried */
  onStepRetried?: (step: WorkflowStep, retryCount: number) => Promise<void> | void;
  /** Called when a step times out */
  onStepTimeout?: (step: WorkflowStep, timeoutMs: number) => Promise<void> | void;
  /** Called when a step is skipped */
  onStepSkipped?: (step: WorkflowStep, reason: string) => Promise<void> | void;
}

/**
 * Engine metrics for monitoring and debugging.
 */
export interface EngineMetrics {
  /** Total workflows executed */
  totalRuns: number;
  /** Currently running workflows */
  activeRuns: number;
  /** Total steps executed */
  totalSteps: number;
  /** Steps currently in progress */
  activeSteps: number;
  /** Steps completed successfully */
  completedSteps: number;
  /** Steps that failed */
  failedSteps: number;
  /** Steps retried */
  retriedSteps: number;
  /** Average step execution time (ms) */
  avgStepDuration: number;
}

// ═══════════════════════════════════════════════════ DAG Internal Types ═══

export interface DagNode { step: WorkflowStep; deps: string[]; dependents: string[]; status: StepStatus; output: string; error: string; retryCount: number; maxRetries: number; rejectCount: number; maxRejectRetries: number; onFailure?: string; onReject?: string; onApprove?: string; routes?: WorkflowStepRoute[]; timeout: number; startedAt: number; notifiedAt: number; _timeoutTimer?: ReturnType<typeof setTimeout>; }

export const PRIORITY: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };

// ═══════════════════════════════════════════════════ Standalone Utilities ═══

/** Map step action to workflow phase */
export function phaseForAction(action?: string): WorkflowPhase {
  const a = (action || '').toLowerCase();
  if (a.includes('review')) return WorkflowPhase.REVIEW;
  if (a.includes('approve')) return WorkflowPhase.APPROVAL;
  if (a.includes('reject')) return WorkflowPhase.REVIEW;
  if (a.includes('deploy')) return WorkflowPhase.DEPLOY;
  if (a.includes('verify') || a.includes('test')) return WorkflowPhase.VERIFY;
  if (a.includes('compensat') || a.includes('notify') || a.includes('rollback')) return WorkflowPhase.COMPENSATION;
  if (a.includes('design')) return WorkflowPhase.DESIGN;
  if (a.includes('require')) return WorkflowPhase.REQUIREMENT;
  return WorkflowPhase.COMPLETED;
}

export function parseReviewFindings(output: string): Array<{ file: string; line: number; desc: string; fix: string }> {
  if (output.includes('NO_ISSUES')) return [];
  const findings: Array<{ file: string; line: number; desc: string; fix: string }> = [];
  const lines = output.split('\n');
  for (const line of lines) {
    const m = line.match(/ISSUE\|(.+?):(\d+)\|(.+?)\|(.+)/);
    if (m) findings.push({ file: m[1].trim(), line: parseInt(m[2]), desc: m[3].trim(), fix: m[4].trim() });
  }
  return findings;
}

/** Normalize agent fields to array — combines agent + agents */
export function getAgents(step: WorkflowStep): string[] {
  const result: string[] = [];
  if (step.agent) result.push(step.agent);
  if (step.agents) result.push(...step.agents);
  return [...new Set(result.filter(Boolean))];
}

/** Parse workflow YAML — supports snake_case aliases */
export function parseWorkflowYaml(raw: string): WorkflowDefinition {
  const p = yaml.load(raw) as Record<string, any>;
  if (!p || typeof p !== 'object') throw new Error('Invalid workflow YAML');
  const sl = p.steps || p.tasks || [];
  if (!Array.isArray(sl)) throw new Error('YAML "steps" must be an array');
  // Parse trigger config
  let trigger: WorkflowTrigger | undefined;
  if (p.trigger) {
    trigger = {
      type: p.trigger.type || 'manual',
      cron: p.trigger.cron,
      eventType: p.trigger.event_type || p.trigger.eventType,
      watchFile: p.trigger.watch_file || p.trigger.watchFile,
      debounceMs: p.trigger.debounce_ms || p.trigger.debounceMs || 5000,
    };
  }

  const steps = sl.map((s: any, i: number) => {
    const isTrigger = s.type === 'trigger' || (!s.agent && !s.prompt && s.trigger);
    const trigger: WorkflowTrigger | undefined = s.trigger ? {
      type: s.trigger.type || 'manual',
      cron: s.trigger.cron,
      eventType: s.trigger.event_type || s.trigger.eventType,
      eventFilter: s.trigger.event_filter || s.trigger.eventFilter,
      watchFile: s.trigger.watch_file || s.trigger.watchFile,
      debounceMs: s.trigger.debounce_ms || s.trigger.debounceMs || 5000,
    } : undefined;

    return {
      id: s.id || `step_${i}`,
      type: isTrigger ? 'trigger' as const : 'step' as const,
      agent: s.agent || (isTrigger ? undefined : 'unknown'),
      action: s.action || (isTrigger ? 'trigger' : 'execute'),
      prompt: s.prompt || '',
      trigger,
      notify: s.notify, condition: s.condition,
      dependsOn: s.dependsOn || (s.depends_on ? (Array.isArray(s.depends_on) ? s.depends_on : [s.depends_on]) : undefined) || (s.depends ? (Array.isArray(s.depends) ? s.depends : [s.depends]) : undefined),
      // timeout: positive integer in milliseconds (default 300000 = 5 min)
      timeout: (typeof s.timeout === 'number' && Number.isFinite(s.timeout) && s.timeout > 0)
        ? Math.floor(s.timeout)
        : 300000,
      onFailure: s.on_failure || s.onFailure || undefined,
      onReject: s.on_reject || s.onReject || undefined,
      onApprove: s.on_approve || s.onApprove || undefined,
      routes: Array.isArray(s.routes) ? s.routes.map((r: any) => ({ step: r.step || r.target, when: r.when || r.condition || '' })) : undefined,
      maxRejectRetries: typeof s.max_reject_retries === 'number' ? Math.min(s.max_reject_retries, 10) : typeof s.maxRejectRetries === 'number' ? Math.min(s.maxRejectRetries, 10) : undefined,
      retry: typeof s.retry === 'number' ? Math.min(s.retry, 10) : undefined,
      retryBackoff: s.retry_backoff || s.retryBackoff || undefined,
      priority: s.priority || undefined, reviewer: s.reviewer || undefined,
      reviewPrompt: s.review_prompt || s.reviewPrompt || undefined,
      reward: typeof s.reward === 'number' ? s.reward : undefined,
      budget: typeof s.budget === 'number' ? s.budget : undefined,
    };
  });

  // v0.4: Validate — duplicate step IDs
  const ids = steps.map(s => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) throw new Error(`重复的步骤 ID: ${[...new Set(dupes)].join(', ')}`);

  // v0.4: Validate — circular dependencies
  const stepMap = new Map(steps.map(s => [s.id, s]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = new Map<string, number>();
  const dfs = (id: string): boolean => {
    colors.set(id, GRAY);
    const s = stepMap.get(id);
    if (s) {
      const deps = Array.isArray(s.dependsOn) ? s.dependsOn : [];
      for (const dep of deps) {
        if (!stepMap.has(dep)) continue;
        const c = colors.get(dep);
        if (c === GRAY) return true; // cycle
        if (c === undefined && dfs(dep)) return true;
      }
    }
    colors.set(id, BLACK);
    return false;
  };
  for (const s of steps) {
    if (!colors.has(s.id) && dfs(s.id)) {
      throw new Error(`检测到循环依赖，请检查步骤之间的依赖关系`);
    }
  }

  return { name: p.name || 'unnamed', description: p.description, concurrency: typeof p.concurrency === 'number' ? p.concurrency : undefined, trigger, steps };
}

// ═══════════════════════════════════════════════════ Shared State ═══

/**
 * Shared mutable state for the workflow engine.
 * Passed to all module functions to avoid circular imports.
 */
export interface EngineState {
  runs: Map<string, WorkflowRunRecord>;
  latestRuns: Map<string, string>;
  runNodes: Map<string, Map<string, DagNode>>;
  pendingApprovals: Map<string, { runId: string; stepId: string; node: DagNode; nodes: Map<string, DagNode> }>;
  abortControllers: Map<string, AbortController>;
  scheduling: Set<string>;
  bus?: import('../event-bus').EventBus;
  executor: StepExecutor;
  lifecycle: StepLifecycle;
  maxLoad: number;
  /** Per-agent circuit breakers to prevent cascade failures */
  circuitBreakers: Map<string, import('../circuit-breaker').CircuitBreaker>;
}

/**
 * Function references for cross-module calls.
 * Created in engine.ts and passed to all module functions to break circular dependencies.
 */
export interface EngineAPI {
  transition: (run: WorkflowRunRecord, node: DagNode, newStatus: StepStatus) => boolean;
  schedule: (runId: string) => void;
  execNode: (runId: string, node: DagNode, nodes: Map<string, DagNode>) => Promise<void>;
  notifyAgent: (runId: string, node: DagNode, nodes: Map<string, DagNode>, ctx: Record<string, string>) => void;
  callback: (runId: string, stepId: string, output: string) => boolean;
  evaluatePostStep: (runId: string, node: DagNode, nodes: Map<string, DagNode>, output: string) => void;
  reviewWorkflowExecution: (group: string | undefined, run: WorkflowRunRecord, nodes: Map<string, DagNode>) => void;
  storeSelfEvaluation: (group: string | undefined, workflowName: string, step: WorkflowStep, output: string) => void;
  storeReviewEvaluation: (group: string | undefined, workflowName: string, reviewStep: WorkflowStep, reviewOutput: string, originalOutput: string) => void;
  storeEvaluation: (group: string | undefined, workflowName: string, stepId: string, step: WorkflowStep, evaluation: Record<string, unknown>, outputSnippet: string, reviewSnippet?: string) => void;
  getLearningRecords: (group: string, limit?: number) => Array<Record<string, unknown>>;
  executeDag: (runId: string, def: WorkflowDefinition, triggerStepId?: string) => Promise<void>;
}
