import { randomUUID } from 'node:crypto';
import {
  ApprovalDecision,
  ApprovalRequest,
  DagNode,
  StepExecutionResult,
  StepExecutor,
  StepStatus,
  WorkflowDefinition,
  WorkflowEngineOptions,
  WorkflowEvent,
  WorkflowEventHandler,
  WorkflowEventType,
  WorkflowRunRecord,
  WorkflowSnapshot,
  WorkflowStatus,
  WorkflowStep,
} from './types.js';
import { transition } from './state-machine.js';
import { SimulatedStepExecutor } from './executors.js';

const PRIORITY: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };

interface InternalRun {
  definition: WorkflowDefinition;
  record: WorkflowRunRecord;
  nodes: Map<string, DagNode>;
  abortController: AbortController;
  active: number;
  scheduled: boolean;
}

export class WorkflowEngine {
  private readonly runs = new Map<string, InternalRun>();
  private readonly latestRuns = new Map<string, string>();
  private readonly listeners = new Set<WorkflowEventHandler>();
  private readonly approvals = new Map<string, ApprovalRequest>();
  private readonly executor: StepExecutor;
  private readonly idGenerator: () => string;
  private readonly now: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetry: number;
  private readonly defaultConcurrency: number;

  constructor(options: WorkflowEngineOptions = {}) {
    this.executor = options.executor ?? new SimulatedStepExecutor();
    this.idGenerator = options.idGenerator ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60_000;
    this.defaultRetry = options.defaultRetry ?? 0;
    this.defaultConcurrency = options.concurrency ?? 1;
  }

  on(handler: WorkflowEventHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  execute(definition: WorkflowDefinition, group?: string): WorkflowRunRecord {
    validateDefinition(definition);
    const runId = this.idGenerator();
    const nodes = this.buildDag(definition);
    const record: WorkflowRunRecord = {
      runId,
      workflowName: definition.name,
      startedAt: this.now(),
      status: WorkflowStatus.RUNNING,
      steps: new Map([...nodes].map(([id, node]) => [id, node.status])),
      outputs: new Map(),
      errors: new Map(),
      attempts: new Map(),
    };
    if (group) record.group = group;

    const internal: InternalRun = {
      definition,
      record,
      nodes,
      abortController: new AbortController(),
      active: 0,
      scheduled: false,
    };
    this.runs.set(runId, internal);
    this.latestRuns.set(definition.name, runId);
    this.emit(WorkflowEventType.RUN_STARTED, internal);
    queueMicrotask(() => this.schedule(runId));
    return record;
  }

  getRun(runId: string): WorkflowRunRecord | undefined {
    return this.runs.get(runId)?.record;
  }

  getLatestRun(workflowName: string): WorkflowRunRecord | undefined {
    const runId = this.latestRuns.get(workflowName);
    return runId ? this.getRun(runId) : undefined;
  }

  snapshot(runId: string): WorkflowSnapshot | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const base = run.record;
    const runSummary: WorkflowSnapshot['run'] = {
      runId: base.runId,
      workflowName: base.workflowName,
      startedAt: base.startedAt,
      status: base.status,
    };
    if (base.completedAt !== undefined) runSummary.completedAt = base.completedAt;
    if (base.group !== undefined) runSummary.group = base.group;
    return {
      run: runSummary,
      steps: [...run.nodes].map(([id, node]) => {
        const step = { id, status: node.status, attempts: node.attempts } as WorkflowSnapshot['steps'][number];
        if (node.output) step.output = node.output;
        if (node.error) step.error = node.error;
        return step;
      }),
    };
  }

  callback(runId: string, stepId: string, output: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.record.status !== WorkflowStatus.RUNNING) return false;
    const node = run.nodes.get(stepId);
    if (!node || node.status !== StepStatus.WAITING) return false;
    this.finishStep(run, node, output);
    this.schedule(runId);
    return true;
  }

  claim(runId: string, stepId: string, agent: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.record.status !== WorkflowStatus.RUNNING) return false;
    const node = run.nodes.get(stepId);
    if (!node || node.step.type !== 'claim' || node.status !== StepStatus.WAITING) return false;
    if (!getAgents(node.step).includes(agent)) return false;
    node.step.agent = agent;
    node.step.type = 'step';
    this.emit(WorkflowEventType.STEP_CLAIMED, run, node, { agent });
    this.executeNode(run, node).catch(error => this.failStep(run, node, stringifyError(error)));
    return true;
  }

  submitApproval(approvalId: string, decision: ApprovalDecision, comment?: string): boolean {
    const approval = this.approvals.get(approvalId);
    if (!approval) return false;
    this.approvals.delete(approvalId);
    const run = this.runs.get(approval.runId);
    const node = run?.nodes.get(approval.stepId);
    if (!run || !node || node.status !== StepStatus.WAITING) return false;
    const output = `HUMAN_APPROVAL DECISION:${decision}${comment ? ` COMMENT:${comment}` : ''}`;
    this.emit(WorkflowEventType.APPROVAL_RESOLVED, run, node, { approvalId, decision, comment });
    if (decision === 'REJECTED') {
      const target = node.step.onReject;
      if (target && run.nodes.has(target)) {
        this.finishStep(run, node, output);
        this.releaseRouteTarget(run, target);
      } else {
        this.failStep(run, node, output);
      }
    } else {
      this.finishStep(run, node, output);
      if (node.step.onApprove) this.releaseRouteTarget(run, node.step.onApprove);
    }
    this.schedule(run.record.runId);
    return true;
  }

  cancel(runId: string, reason = 'cancelled'): boolean {
    const run = this.runs.get(runId);
    if (!run || run.record.status !== WorkflowStatus.RUNNING) return false;
    run.abortController.abort(reason);
    for (const node of run.nodes.values()) {
      if (node.timer) clearTimeout(node.timer);
    }
    run.record.status = WorkflowStatus.CANCELLED;
    run.record.completedAt = this.now();
    this.emit(WorkflowEventType.RUN_CANCELLED, run, undefined, { reason });
    return true;
  }

  private schedule(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.scheduled || run.record.status !== WorkflowStatus.RUNNING) return;
    run.scheduled = true;
    queueMicrotask(() => {
      run.scheduled = false;
      this.scheduleNow(run);
    });
  }

  private scheduleNow(run: InternalRun): void {
    if (run.record.status !== WorkflowStatus.RUNNING) return;
    const concurrency = run.definition.concurrency ?? this.defaultConcurrency;
    const ready = this.getReadyNodes(run).slice(0, Math.max(0, concurrency - run.active));
    for (const node of ready) {
      this.executeNode(run, node).catch(error => this.failStep(run, node, stringifyError(error)));
    }
    this.completeIfDone(run);
  }

  private getReadyNodes(run: InternalRun): DagNode[] {
    const ready: DagNode[] = [];
    for (const node of run.nodes.values()) {
      if (node.status !== StepStatus.PENDING && node.status !== StepStatus.BLOCKED) continue;
      if (!this.conditionPasses(node.step.condition, run)) {
        this.skipNode(run, node, 'condition=false');
        continue;
      }
      const depsOk = node.deps.every(depId => {
        const dep = run.nodes.get(depId);
        return dep?.status === StepStatus.COMPLETED || dep?.status === StepStatus.SKIPPED;
      });
      if (depsOk) {
        if (node.status === StepStatus.BLOCKED) transition(run.record, node, StepStatus.PENDING);
        ready.push(node);
      } else if (node.status === StepStatus.PENDING) {
        transition(run.record, node, StepStatus.BLOCKED);
      }
    }
    return ready.sort((a, b) => priorityOf(a.step) - priorityOf(b.step));
  }

  private async executeNode(run: InternalRun, node: DagNode): Promise<void> {
    if (run.record.status !== WorkflowStatus.RUNNING) return;
    if (node.step.type === 'claim') {
      transition(run.record, node, StepStatus.WAITING);
      this.emit(WorkflowEventType.STEP_WAITING, run, node, { reason: 'claim' });
      return;
    }
    if (node.step.type === 'human_approval' || node.step.action === 'human_approval') {
      transition(run.record, node, StepStatus.WAITING);
      const approval: ApprovalRequest = {
        approvalId: this.idGenerator(),
        runId: run.record.runId,
        stepId: node.step.id,
        createdAt: this.now(),
      };
      if (node.step.prompt !== undefined) approval.prompt = node.step.prompt;
      this.approvals.set(approval.approvalId, approval);
      this.emit(WorkflowEventType.APPROVAL_REQUESTED, run, node, approval as unknown as Record<string, unknown>);
      return;
    }

    transition(run.record, node, StepStatus.IN_PROGRESS);
    node.startedAt = this.now();
    node.attempts += 1;
    run.record.attempts.set(node.step.id, node.attempts);
    run.active += 1;
    this.emit(WorkflowEventType.STEP_STARTED, run, node, { attempt: node.attempts });

    node.timer = setTimeout(() => {
      this.failStep(run, node, `Step timed out after ${node.timeoutMs}ms`);
    }, node.timeoutMs);

    try {
      const context = {
        runId: run.record.runId,
        workflowName: run.record.workflowName,
        stepId: node.step.id,
        attempt: node.attempts,
        upstream: this.collectUpstream(run, node),
        signal: run.abortController.signal,
      };
      const result = await this.executor.execute(
        node.step,
        run.record.group === undefined ? context : { ...context, group: run.record.group },
      );
      if (run.abortController.signal.aborted) return;
      if (node.timer) clearTimeout(node.timer);
      node.timer = undefined;
      run.active -= 1;

      const normalized = normalizeResult(result);
      if (normalized.status === 'waiting') {
        transition(run.record, node, StepStatus.WAITING);
        this.emit(WorkflowEventType.STEP_WAITING, run, node);
        return;
      }
      if (normalized.status === 'failed') {
        this.failStep(run, node, normalized.output);
        return;
      }
      this.finishStep(run, node, normalized.output);
      this.schedule(run.record.runId);
    } catch (error) {
      if (node.timer) clearTimeout(node.timer);
      node.timer = undefined;
      run.active -= 1;
      this.failStep(run, node, stringifyError(error));
    }
  }

  private finishStep(run: InternalRun, node: DagNode, output: string): void {
    node.output = output;
    run.record.outputs.set(node.step.id, output);
    transition(run.record, node, StepStatus.COMPLETED);
    this.emit(WorkflowEventType.STEP_COMPLETED, run, node, { output });
    this.applyRoutes(run, node, output);
  }

  private failStep(run: InternalRun, node: DagNode, error: string): void {
    if (node.timer) clearTimeout(node.timer);
    node.timer = undefined;
    if (node.status === StepStatus.IN_PROGRESS) run.active = Math.max(0, run.active - 1);
    node.error = error;
    run.record.errors.set(node.step.id, error);

    if (node.attempts <= node.maxRetries) {
      transition(run.record, node, StepStatus.FAILED);
      const delay = retryDelay(node);
      this.emit(WorkflowEventType.STEP_RETRYING, run, node, { error, retryInMs: delay });
      setTimeout(() => {
        if (run.record.status !== WorkflowStatus.RUNNING) return;
        transition(run.record, node, StepStatus.PENDING);
        this.schedule(run.record.runId);
      }, delay);
      return;
    }

    transition(run.record, node, StepStatus.FAILED);
    this.emit(WorkflowEventType.STEP_FAILED, run, node, { error });
    if (node.step.onFailure) {
      this.releaseRouteTarget(run, node.step.onFailure);
      this.schedule(run.record.runId);
      return;
    }
    this.completeIfDone(run);
  }

  private skipNode(run: InternalRun, node: DagNode, reason: string): void {
    transition(run.record, node, StepStatus.SKIPPED);
    this.emit(WorkflowEventType.STEP_SKIPPED, run, node, { reason });
  }

  private applyRoutes(run: InternalRun, node: DagNode, output: string): void {
    if (!node.step.routes?.length) return;
    const matched = node.step.routes.filter(route => evaluateRoute(route.when, output, node.status));
    if (matched.length === 0) return;
    const matchedTargets = new Set(matched.map(route => route.step));
    for (const target of matchedTargets) this.releaseRouteTarget(run, target);
    for (const dependentId of node.dependents) {
      if (!matchedTargets.has(dependentId)) {
        const dependent = run.nodes.get(dependentId);
        if (dependent && (dependent.status === StepStatus.PENDING || dependent.status === StepStatus.BLOCKED)) {
          this.skipNode(run, dependent, 'route_not_matched');
        }
      }
    }
  }

  private releaseRouteTarget(run: InternalRun, targetId: string): void {
    const target = run.nodes.get(targetId);
    if (!target) return;
    target.deps = target.deps.filter(dep => {
      const depNode = run.nodes.get(dep);
      return depNode?.status !== StepStatus.COMPLETED && depNode?.status !== StepStatus.SKIPPED;
    });
    if (target.status === StepStatus.BLOCKED) transition(run.record, target, StepStatus.PENDING);
  }

  private completeIfDone(run: InternalRun): void {
    if (run.record.status !== WorkflowStatus.RUNNING || run.active > 0) return;
    const nodes = [...run.nodes.values()];
    const hasOpen = nodes.some(node =>
      node.status === StepStatus.PENDING ||
      node.status === StepStatus.BLOCKED ||
      node.status === StepStatus.IN_PROGRESS ||
      node.status === StepStatus.WAITING
    );
    if (hasOpen) return;
    const failed = nodes.some(node => node.status === StepStatus.FAILED);
    run.record.status = failed ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
    run.record.completedAt = this.now();
    this.emit(failed ? WorkflowEventType.RUN_FAILED : WorkflowEventType.RUN_COMPLETED, run);
  }

  private collectUpstream(run: InternalRun, node: DagNode): Record<string, string> {
    const upstream: Record<string, string> = {};
    for (const dep of node.deps) {
      const output = run.nodes.get(dep)?.output;
      if (output) upstream[dep] = output;
    }
    return upstream;
  }

  private conditionPasses(condition: string | undefined, run: InternalRun): boolean {
    if (!condition) return true;
    if (condition === 'always') return true;
    if (condition === 'never') return false;
    const match = condition.match(/^output\(([^)]+)\)\s+contains\s+(.+)$/);
    if (match) {
      const stepId = match[1] ?? '';
      const needle = match[2]?.replace(/^['"]|['"]$/g, '') ?? '';
      return run.nodes.get(stepId)?.output.includes(needle) ?? false;
    }
    throw new Error(`Unsupported condition: ${condition}`);
  }

  private buildDag(definition: WorkflowDefinition): Map<string, DagNode> {
    const nodes = new Map<string, DagNode>();
    for (const step of definition.steps) {
      nodes.set(step.id, {
        step: { ...step },
        deps: [...(step.dependsOn ?? [])],
        dependents: [],
        status: StepStatus.PENDING,
        output: '',
        error: '',
        attempts: 0,
        maxRetries: step.retry ?? this.defaultRetry,
        rejectCount: 0,
        maxRejectRetries: step.maxRejectRetries ?? 0,
        timeoutMs: step.timeoutMs ?? this.defaultTimeoutMs,
        startedAt: 0,
        timer: undefined,
      });
    }
    for (const [id, node] of nodes) {
      for (const dep of node.deps) {
        const depNode = nodes.get(dep);
        if (!depNode) throw new Error(`Step "${id}" depends on unknown step "${dep}"`);
        depNode.dependents.push(id);
      }
    }
    assertAcyclic(nodes);
    return nodes;
  }

  private emit(
    type: WorkflowEventType,
    run: InternalRun,
    node?: DagNode,
    payload?: Record<string, unknown>,
  ): void {
    const event: WorkflowEvent = {
      type,
      runId: run.record.runId,
      workflowName: run.record.workflowName,
      timestamp: this.now(),
      ...(node ? { stepId: node.step.id } : {}),
      ...(payload ? { payload } : {}),
    };
    for (const listener of this.listeners) {
      Promise.resolve(listener(event)).catch(() => undefined);
    }
  }
}

function validateDefinition(definition: WorkflowDefinition): void {
  if (!definition.name.trim()) throw new Error('Workflow name is required');
  if (definition.steps.length === 0) throw new Error('Workflow must contain at least one step');
  const seen = new Set<string>();
  for (const step of definition.steps) {
    if (!step.id.trim()) throw new Error('Step id is required');
    if (seen.has(step.id)) throw new Error(`Duplicate step id "${step.id}"`);
    seen.add(step.id);
  }
}

function assertAcyclic(nodes: Map<string, DagNode>): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Workflow DAG contains a cycle at "${id}"`);
    visiting.add(id);
    for (const dep of nodes.get(id)?.dependents ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
}

function getAgents(step: WorkflowStep): string[] {
  if (step.agents?.length) return step.agents;
  return step.agent ? [step.agent] : [];
}

function normalizeResult(result: string | StepExecutionResult): Required<StepExecutionResult> {
  if (typeof result === 'string') return { output: result, status: 'completed' };
  return { output: result.output, status: result.status ?? 'completed' };
}

function priorityOf(step: WorkflowStep): number {
  return PRIORITY[step.priority ?? 'normal'] ?? 2;
}

function retryDelay(node: DagNode): number {
  if (node.step.retryBackoff === 'exponential') {
    return Math.min(30_000, 250 * 2 ** Math.max(0, node.attempts - 1));
  }
  return 250;
}

function evaluateRoute(when: string, output: string, status: StepStatus): boolean {
  const normalized = when.trim();
  if (normalized === 'always') return true;
  if (normalized === 'success') return status === StepStatus.COMPLETED;
  const contains = normalized.match(/^output\s+contains\s+(.+)$/);
  if (contains) {
    const needle = contains[1]?.replace(/^['"]|['"]$/g, '') ?? '';
    return output.includes(needle);
  }
  const equals = normalized.match(/^output\s*==\s*(.+)$/);
  if (equals) {
    const expected = equals[1]?.replace(/^['"]|['"]$/g, '') ?? '';
    return output.trim() === expected;
  }
  throw new Error(`Unsupported route condition: ${when}`);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
