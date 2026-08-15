export enum StepStatus {
  PENDING = 'pending',
  BLOCKED = 'blocked',
  IN_PROGRESS = 'in_progress',
  WAITING = 'waiting',
  COMPLETED = 'completed',
  SKIPPED = 'skipped',
  FAILED = 'failed',
}

export enum WorkflowStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export enum WorkflowEventType {
  RUN_STARTED = 'run.started',
  RUN_COMPLETED = 'run.completed',
  RUN_FAILED = 'run.failed',
  RUN_CANCELLED = 'run.cancelled',
  STEP_READY = 'step.ready',
  STEP_STARTED = 'step.started',
  STEP_WAITING = 'step.waiting',
  STEP_COMPLETED = 'step.completed',
  STEP_FAILED = 'step.failed',
  STEP_SKIPPED = 'step.skipped',
  STEP_RETRYING = 'step.retrying',
  STEP_CLAIMED = 'step.claimed',
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_RESOLVED = 'approval.resolved',
}

export type StepKind = 'step' | 'trigger' | 'claim' | 'human_approval';
export type RetryBackoff = 'fixed' | 'exponential';
export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export interface WorkflowStepRoute {
  step: string;
  when: string;
}

export interface WorkflowStep<TInput = unknown> {
  id: string;
  type?: StepKind;
  agent?: string;
  agents?: string[];
  action?: string;
  prompt?: string;
  input?: TInput;
  condition?: string;
  dependsOn?: string[];
  routes?: WorkflowStepRoute[];
  timeoutMs?: number;
  retry?: number;
  retryBackoff?: RetryBackoff;
  priority?: Priority;
  onFailure?: string;
  onReject?: string;
  onApprove?: string;
  maxRejectRetries?: number;
}

export interface WorkflowDefinition {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  concurrency?: number;
  source?: string;
}

export interface StepExecutionContext {
  runId: string;
  workflowName: string;
  stepId: string;
  group?: string;
  attempt: number;
  upstream: Record<string, string>;
  signal: AbortSignal;
}

export interface StepExecutor {
  execute(step: WorkflowStep, context: StepExecutionContext): Promise<string | StepExecutionResult>;
}

export interface StepExecutionResult {
  output: string;
  status?: 'completed' | 'waiting' | 'failed';
}

export interface WorkflowRunRecord {
  runId: string;
  workflowName: string;
  startedAt: number;
  completedAt?: number;
  status: WorkflowStatus;
  steps: Map<string, StepStatus>;
  outputs: Map<string, string>;
  errors: Map<string, string>;
  attempts: Map<string, number>;
  group?: string;
}

export interface DagNode {
  step: WorkflowStep;
  deps: string[];
  dependents: string[];
  status: StepStatus;
  output: string;
  error: string;
  attempts: number;
  maxRetries: number;
  rejectCount: number;
  maxRejectRetries: number;
  timeoutMs: number;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface WorkflowEvent {
  type: WorkflowEventType;
  runId: string;
  workflowName: string;
  stepId?: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

export type WorkflowEventHandler = (event: WorkflowEvent) => void | Promise<void>;

export interface WorkflowEngineOptions {
  executor?: StepExecutor;
  idGenerator?: () => string;
  now?: () => number;
  defaultTimeoutMs?: number;
  defaultRetry?: number;
  concurrency?: number;
}

export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  stepId: string;
  prompt?: string;
  createdAt: number;
}

export interface WorkflowSnapshot {
  run: {
    runId: string;
    workflowName: string;
    startedAt: number;
    completedAt?: number;
    status: WorkflowStatus;
    group?: string;
  };
  steps: Array<{
    id: string;
    status: StepStatus;
    output?: string;
    error?: string;
    attempts: number;
  }>;
}
