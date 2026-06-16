/**
 * Workflow Engine — Main Class
 *
 * The WorkflowEngine class that imports and uses all workflow modules.
 * Maintains the same public API as the original monolithic implementation.
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import * as yaml from 'js-yaml';
import { AGENTS_DIR, GROUPS_DIR, MIND_DIR } from '../data-dir';
import { atomicWrite } from '../atomic';
import { EventBus, EventType, createEvent } from '../event-bus';
import { metrics } from '../metrics';
import {
  saveRunMeta, saveStepCheckpoint, completeRunCheckpoint,
  appendRunHistory, findIncompleteRuns, cleanupCheckpoints,
} from '../workflow-checkpoint';
import { CircuitBreaker } from '../circuit-breaker';
import { toUserError } from '../errors';

import {
  type EngineState,
  type EngineAPI,
  type WorkflowStep,
  type WorkflowDefinition,
  type WorkflowRunRecord,
  type DagNode,
  type StepExecutor,
  type StepLifecycle,
  StepStatus,
  WorkflowStatus,
  WorkflowPhase,
  LogLevel,
  logger,
  phaseForAction,
  getAgents,
  parseWorkflowYaml,
} from './types';

import { isValidTransition, transition as stateTransition } from './state-machine';
import { schedule as scheduleFn } from './scheduler';
import { execNode as execNodeFn, notifyAgent as notifyAgentFn, createStepExecutor, checkForCompletedWork } from './executor';
import {
  callback as callbackFn,
  claim as claimFn,
  evaluatePostStep as evaluatePostStepFn,
  reviewWorkflowExecution as reviewWorkflowExecutionFn,
  storeSelfEvaluation as storeSelfEvaluationFn,
  storeReviewEvaluation as storeReviewEvaluationFn,
  storeEvaluation as storeEvaluationFn,
  getLearningRecords as getLearningRecordsFn,
  getQualitySummary as getQualitySummaryFn,
} from './callbacks';

// ═══════════════════════════════════════════════════ WorkflowEngine ═══

export class WorkflowEngine {
  private state: EngineState;
  private api: EngineAPI;

  constructor(bus?: EventBus, executor?: StepExecutor) {
    // ── Initialize shared state ──
    this.state = {
      runs: new Map(),
      latestRuns: new Map(),
      runNodes: new Map(),
      pendingApprovals: new Map(),
      abortControllers: new Map(),
      scheduling: new Set(),
      bus,
      executor: executor || createStepExecutor(),
      lifecycle: {},
      maxLoad: parseFloat(process.env.MAX_CPU_LOAD || '0.8'),
      circuitBreakers: new Map(),
    };

    // ── Initialize API (function references with bound state) ──
    this.api = {
      transition: (run, node, newStatus) => stateTransition(run, node, newStatus),
      schedule: (runId) => scheduleFn(this.state, this.api, runId),
      execNode: (runId, node, nodes) => execNodeFn(this.state, this.api, runId, node, nodes),
      notifyAgent: (runId, node, nodes, ctx) => notifyAgentFn(this.state, this.api, runId, node, nodes, ctx),
      callback: (runId, stepId, output) => callbackFn(this.state, this.api, runId, stepId, output),
      evaluatePostStep: (runId, node, nodes, output) => evaluatePostStepFn(this.state, this.api, runId, node, nodes, output),
      reviewWorkflowExecution: (group, run, nodes) => reviewWorkflowExecutionFn(this.state, group, run, nodes),
      storeSelfEvaluation: (group, workflowName, step, output) => storeSelfEvaluationFn(group, workflowName, step, output),
      storeReviewEvaluation: (group, workflowName, reviewStep, reviewOutput, originalOutput) => storeReviewEvaluationFn(group, workflowName, reviewStep, reviewOutput, originalOutput),
      storeEvaluation: (group, workflowName, stepId, step, evaluation, outputSnippet, reviewSnippet) => storeEvaluationFn(group, workflowName, stepId, step, evaluation, outputSnippet, reviewSnippet),
      getLearningRecords: (group, limit) => getLearningRecordsFn(group, limit),
      executeDag: (runId, def, triggerStepId) => this.executeDag(runId, def, triggerStepId),
    };

    logger.info('engine', 'WorkflowEngine initialized');
  }

  // ═══════════════════════════════════════════════════ Public API ═══

  /** Register lifecycle hooks */
  setLifecycle(hooks: StepLifecycle) {
    this.state.lifecycle = { ...this.state.lifecycle, ...hooks };
    logger.info('engine', `Lifecycle hooks registered: ${Object.keys(hooks).join(', ')}`);
  }

  /** Set log level */
  setLogLevel(level: LogLevel) { logger.setLevel(level); }

  /**
   * Execute a workflow definition.
   *
   * Creates a new run instance and starts asynchronous DAG execution.
   * Returns immediately with a WorkflowRunRecord for status tracking.
   */
  execute(def: WorkflowDefinition, group?: string, triggerStepId?: string): WorkflowRunRecord {
    const runId = randomUUID();
    const rec: WorkflowRunRecord = {
      runId, workflowName: def.name, startedAt: Date.now(),
      status: WorkflowStatus.RUNNING,
      steps: new Map(def.steps.map(s => [s.id, StepStatus.PENDING])),
      stepRetries: new Map(), rollbacks: [], compensations: [],
      taskReports: new Map(),
    };
    if (group) rec.group = group;
    this.state.runs.set(runId, rec);
    this.state.latestRuns.set(def.name, runId);
    metrics.workflowRuns.inc();
    logger.info('execute', `Started workflow "${def.name}" (run ${runId.slice(0, 8)}, ${def.steps.length} steps, group=${group || 'none'})`);
    // v0.4: Register abort controller
    const ac = new AbortController();
    this.state.abortControllers.set(runId, ac);

    // v0.4: Save run checkpoint
    if (group) {
      saveRunMeta(group, runId, { workflowName: def.name, startedAt: rec.startedAt, status: 'running' });
    }

    if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_CREATED, { taskId: runId, title: `Workflow: ${def.name}`, stepsTotal: def.steps.length }, 'workflow-engine'));
    // v0.5: DO NOT mark run as completed here — schedule() handles completion
    // when all steps finish via callbacks.
    this.executeDag(runId, def, triggerStepId).catch((err: Error) => {
      const r = this.state.runs.get(runId);
      if (r) { r.status = WorkflowStatus.FAILED; r.completedAt = Date.now(); }
      if (group) {
        completeRunCheckpoint(group, runId, 'failed', err.message || 'Unknown error');
        const stepsCompleted = [...(r?.steps.values() || [])].filter(s => s === StepStatus.COMPLETED).length;
        const stepsFailed = [...(r?.steps.values() || [])].filter(s => s === StepStatus.FAILED).length;
        appendRunHistory(group, {
          runId, workflowName: def.name, group,
          startedAt: rec.startedAt, completedAt: Date.now(),
          status: 'failed', stepsTotal: def.steps.length,
          stepsCompleted, stepsFailed,
          compensations: r?.compensations.length || 0,
        });
      }
      if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, error: err.message }, 'workflow-engine'));
    });
    return rec;
  }

  /** Handle callback from agent — step completed */
  callback(runId: string, stepId: string, output: string): boolean {
    return callbackFn(this.state, this.api, runId, stepId, output);
  }

  /** Handle claim from agent — assign step to claiming agent and trigger */
  claim(runId: string, stepId: string, agentName: string): boolean {
    return claimFn(this.state, this.api, runId, stepId, agentName);
  }

  /** Schedule ready steps in a run */
  schedule(runId: string): void {
    scheduleFn(this.state, this.api, runId);
  }

  /** v0.3 P2: Submit human approval decision and resume DAG execution */
  submitApproval(approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string): boolean {
    const pending = this.state.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.state.pendingApprovals.delete(approvalId);

    const { runId, stepId, node, nodes } = pending;
    const run = this.state.runs.get(runId);
    if (!run) return false;

    // Record human decision as step output
    node.output = `HUMAN_APPROVAL APPROVAL_ID:${approvalId} DECISION:${decision}${comment ? ` COMMENT:${comment}` : ''}`;
    node.status = StepStatus.COMPLETED;
    run.steps.set(stepId, StepStatus.COMPLETED);

    if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_COMPLETED, {
      taskId: runId, stepId, workflow: run.workflowName,
      agent: node.step.agent, action: 'human_approval',
      output: node.output, decision,
      phase: WorkflowPhase.APPROVAL,
    }, 'workflow-engine'));

    // Notify downstream
    if (node.step.notify) {
      const nl = Array.isArray(node.step.notify) ? node.step.notify : [node.step.notify];
      for (const to of nl) {
        if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_REVIEW_COMPLETED, {
          taskId: runId, stepId, workflow: run.workflowName,
          from: node.step.agent, to, decision, approvalId,
        }, 'workflow-engine'));
      }
    }

    // Resume DAG: rebuild definition from stored nodes (preserves dynamically injected review steps)
    const steps = [...nodes.values()].map(n => n.step);
    if (steps.length > 0) {
      const def: WorkflowDefinition = { name: run.workflowName, steps };
      this.executeDag(runId, def).catch((err: Error) => {
        const r = this.state.runs.get(runId);
        if (r) { r.status = WorkflowStatus.FAILED; r.completedAt = Date.now(); }
        if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, error: err.message }, 'workflow-engine'));
      });
    }

    return true;
  }

  /** List all pending human approvals */
  listPendingApprovals(): Array<{ approvalId: string; runId: string; stepId: string; agent: string; prompt: string }> {
    return [...this.state.pendingApprovals.entries()].map(([approvalId, p]) => ({
      approvalId,
      runId: p.runId,
      stepId: p.stepId,
      agent: p.node.step.agent || 'unknown',
      prompt: p.node.step.prompt || '',
    }));
  }

  getRun(idOrName: string): WorkflowRunRecord | undefined {
    const direct = this.state.runs.get(idOrName);
    if (direct) return direct;
    const latestRunId = this.state.latestRuns.get(idOrName);
    if (latestRunId) return this.state.runs.get(latestRunId);
    return undefined;
  }

  listRuns(): WorkflowRunRecord[] { const seen = new Set<string>(); const out: WorkflowRunRecord[] = []; for (const r of this.state.runs.values()) { if (!seen.has(r.runId)) { seen.add(r.runId); out.push(r); } } return out; }

  /** GET /api/workflows — per-group workflow status dashboard data */
  getRunsByGroup(): Record<string, {
    runId: string; workflowName: string; status: string;
    startedAt: number; completedAt?: number;
    durationMs?: number;
    steps: Record<string, string>; retries: number;
    rollbacks: number; compensations: number;
    stepReports: Array<{ stepId: string; agent: string; status: string; summary: string; timestamp: number }>;
    totalRuns: number; completedRuns: number; failedRuns: number;
  }> {
    const seen = new Set<string>();
    const byGroup = new Map<string, WorkflowRunRecord[]>();
    for (const r of this.state.runs.values()) {
      if (seen.has(r.runId)) continue;
      seen.add(r.runId);
      const group = r.group || '_ungrouped';
      if (!byGroup.has(group)) byGroup.set(group, []);
      byGroup.get(group)!.push(r);
    }
    const result: Record<string, any> = {};
    for (const [group, runs] of byGroup) {
      runs.sort((a, b) => b.startedAt - a.startedAt);
      const latest = runs[0];
      const stepsObj: Record<string, string> = {};
      for (const [sid, s] of latest.steps) stepsObj[sid] = s;
      let retries = 0;
      for (const v of latest.stepRetries.values()) retries += v;
      const reports = [...latest.taskReports.values()].map(tr => ({
        stepId: tr.stepId, agent: tr.agent, status: tr.status,
        summary: tr.summary, timestamp: tr.timestamp,
      }));
      result[group] = {
        runId: latest.runId,
        workflowName: latest.workflowName,
        status: latest.status,
        startedAt: latest.startedAt,
        completedAt: latest.completedAt,
        durationMs: latest.completedAt ? latest.completedAt - latest.startedAt : Date.now() - latest.startedAt,
        steps: stepsObj,
        retries,
        rollbacks: latest.rollbacks.length,
        compensations: latest.compensations.length,
        stepReports: reports,
        totalRuns: runs.length,
        completedRuns: runs.filter(r => r.status === WorkflowStatus.COMPLETED).length,
        failedRuns: runs.filter(r => r.status === WorkflowStatus.FAILED).length,
      };
    }
    return result;
  }

  getSystemLoad(): { load1: number; load5: number; load15: number; cpuCount: number; overloaded: boolean } {
    const [l1, l5, l15] = os.loadavg();
    const cpuCount = os.cpus().length;
    const overloaded = l1 / cpuCount > this.state.maxLoad;
    return { load1: l1, load5: l5, load15: l15, cpuCount, overloaded };
  }

  tick(): void {
    const { overloaded, load1, cpuCount } = this.getSystemLoad();

    for (const [rid, run] of this.state.runs) {
      if (run.status !== WorkflowStatus.RUNNING) continue;
      for (const [sid, s] of run.steps) {
        if (s === StepStatus.BLOCKED) {
          const rt = run.stepRetries.get(sid) || 0;
          // v0.3 P2: load-aware — pause retries when system overloaded
          if (overloaded) {
            if (rt === 0) {
              // First-time detection: emit load warning
              run.steps.set(sid, StepStatus.BLOCKED);
              if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_BLOCKED, {
                taskId: rid, stepId: sid, workflow: run.workflowName,
                reason: `system_load: ${(load1 / cpuCount * 100).toFixed(0)}% CPU (threshold: ${(this.state.maxLoad * 100).toFixed(0)}%)`,
                phase: WorkflowPhase.COMPLETED,
              }, 'workflow-engine'));
            }
            continue; // skip scheduling while overloaded
          }
          if (rt < 3) {
            run.steps.set(sid, StepStatus.IN_PROGRESS);
            if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_IN_PROGRESS, {
              taskId: rid, stepId: sid, workflow: run.workflowName,
              action: 'auto-retry', attempt: rt + 1,
            }, 'workflow-engine'));
          }
        }
        // v0.5: Step timeout — if WAITING too long, mark as failed
        if (s === StepStatus.WAITING) {
          const nodes = this.state.runNodes.get(rid);
          const node = nodes?.get(sid);
          if (node && node.notifiedAt > 0) {
            const elapsed = Date.now() - node.notifiedAt;
            const timeout = node.step.timeout || 300000; // 5min default
            if (elapsed > timeout) {
              logger.warn('tick', `Step ${sid} timed out after ${Math.round(elapsed / 1000)}s (run ${rid.slice(0, 8)})`);

              // v1.4: Recovery — check if agent actually completed work before retry/fail
              const agentName = node.step.agent || 'unknown';
              const recoveryResult = checkForCompletedWork(this.state, rid, sid, agentName);
              if (recoveryResult.completed) {
                logger.info('tick', `Step ${sid} timed out but agent completed work — recovering with output: ${recoveryResult.output.slice(0, 100)}`);
                // Process the callback with the recovered output
                this.api.callback(rid, sid, recoveryResult.output);
                continue; // Skip retry/fail logic, move to next step
              }

              // v0.5: Retry on timeout (same as execution failure)
              if (node.retryCount < node.maxRetries) {
                node.retryCount++;
                metrics.workflowStepRetries.inc();
                stateTransition(run, node, StepStatus.PENDING);
                node.notifiedAt = 0;
                logger.info('tick', `${sid} retry ${node.retryCount}/${node.maxRetries} after timeout`);
              } else {
                stateTransition(run, node, StepStatus.FAILED);
                metrics.workflowStepFailures.inc();
                const timeoutErr = toUserError('timeout', { stepId: sid, timeout: `${Math.round(elapsed / 1000)}s` });
                node.error = `[${timeoutErr.title}] ${timeoutErr.message} -- ${timeoutErr.suggestion}`;
                this.state.lifecycle.onStepFailed?.(node.step, node.error);
                // Trigger compensation if onFailure is set
                if (node.onFailure && nodes && nodes.has(node.onFailure)) {
                  const cn = nodes.get(node.onFailure)!;
                  run.compensations.push(node.onFailure);
                  if (cn.status === StepStatus.PENDING) {
                    this.api.schedule(rid);
                  }
                }
              }
              // Clean up notification file
              try {
                const notifPath = path.join(AGENTS_DIR, node.step.agent || 'unknown', '.workflow-notifications', `${rid}_${sid}.json`);
                if (fs.existsSync(notifPath)) fs.unlinkSync(notifPath);
              } catch (e) { logger.error('misc', 'Unexpected error', e); }
              if (this.state.bus) this.state.bus.emit(createEvent(EventType.TASK_BLOCKED, {
                taskId: rid, stepId: sid, workflow: run.workflowName,
                reason: `timeout: ${Math.round(elapsed / 1000)}s`, phase: WorkflowPhase.COMPLETED,
              }, 'workflow-engine'));
              // Continue scheduling to handle downstream
              this.api.schedule(rid);
            }
          }
        }
      }
    }
  }

  getStats(): { totalRuns: number; activeRuns: number; completedRuns: number; failedRuns: number; totalRetries: number; totalRollbacks: number; totalCompensations: number } {
    const seen = new Set<string>(); let a = 0, c = 0, f = 0, tr = 0, rb = 0, cp = 0;
    for (const [, r] of this.state.runs) { if (seen.has(r.runId)) continue; seen.add(r.runId); if (r.status === WorkflowStatus.RUNNING) a++; else if (r.status === WorkflowStatus.COMPLETED) c++; else if (r.status === WorkflowStatus.FAILED) f++; for (const v of r.stepRetries.values()) tr += v; rb += r.rollbacks.length; cp += r.compensations.length; }
    return { totalRuns: seen.size, activeRuns: a, completedRuns: c, failedRuns: f, totalRetries: tr, totalRollbacks: rb, totalCompensations: cp };
  }

  /** v0.4: Cancel a running workflow */
  cancel(runId: string): boolean {
    const ac = this.state.abortControllers.get(runId);
    if (!ac) return false;
    ac.abort();
    this.state.abortControllers.delete(runId);
    return true;
  }

  /** v0.4: Add a step to a running workflow */
  addStep(group: string, step: WorkflowStep): boolean {
    const run = this.findRunByGroup(group);
    if (!run || run.status !== WorkflowStatus.RUNNING) return false;

    const nodes = this.state.runNodes.get(run.runId);
    if (!nodes) return false;

    // Check for duplicate step ID
    if (nodes.has(step.id)) return false;

    // Parse deps — ensure they exist in the DAG
    const deps = (step.dependsOn || []).filter(d => nodes.has(d));
    const node: DagNode = {
      step, deps, dependents: [],
      status: StepStatus.PENDING, output: '', error: '',
      retryCount: 0, maxRetries: step.retry ?? 3,
      rejectCount: 0, maxRejectRetries: step.maxRejectRetries ?? 3,
      onFailure: step.onFailure, onReject: step.onReject, onApprove: step.onApprove,
      routes: step.routes, timeout: step.timeout || 300000, startedAt: 0, notifiedAt: 0,
    };
    nodes.set(step.id, node);

    // Rebuild dependent links
    for (const [id, n] of nodes) {
      n.dependents = [];
      for (const [oid, other] of nodes) {
        if (other.deps.includes(id)) n.dependents.push(oid);
      }
    }

    // Sync to run record
    run.steps.set(step.id, StepStatus.PENDING);

    // Also persist to YAML for recovery
    try {
      const wfPath = path.join(GROUPS_DIR, group, 'workflow.yaml');
      if (fs.existsSync(wfPath)) {
        const raw = fs.readFileSync(wfPath, 'utf-8');
        const def = parseWorkflowYaml(raw);
        if (!def.steps.find(s => s.id === step.id)) {
          def.steps.push(step);
          atomicWrite(wfPath, yaml.dump(def));
        }
      }
    } catch (e) { logger.error('misc', 'Unexpected error', e); }

    logger.info('dag', `Added step ${step.id} to running workflow in ${group}`);
    // Trigger scheduling to pick up the new step
    this.api.schedule(run.runId);
    return true;
  }

  /** v1.1: Delete a step from a running workflow — in-memory DAG + YAML */
  deleteStep(group: string, stepId: string): boolean {
    const run = this.findRunByGroup(group);
    if (!run || run.status !== WorkflowStatus.RUNNING) return false;
    const nodes = this.state.runNodes.get(run.runId);
    if (!nodes) return false;
    const node = nodes.get(stepId);
    if (!node) return false;
    // Can't delete if step is currently running
    if (node.status === StepStatus.WAITING || node.status === StepStatus.IN_PROGRESS) return false;

    // Remove from DAG
    nodes.delete(stepId);
    // Rebuild dependent links
    for (const [, n] of nodes) {
      n.dependents = n.dependents.filter(d => d !== stepId);
      n.deps = n.deps.filter(d => d !== stepId);
    }
    run.steps.delete(stepId);
    logger.info('dag', `Deleted step ${stepId} from running workflow in ${group}`);
    this.api.schedule(run.runId);
    return true;
  }

  /** v1.1: Modify a step in a running workflow — in-memory DAG + YAML */
  modifyStep(group: string, stepId: string, changes: Partial<WorkflowStep>): boolean {
    const run = this.findRunByGroup(group);
    if (!run || run.status !== WorkflowStatus.RUNNING) return false;
    const nodes = this.state.runNodes.get(run.runId);
    if (!nodes) return false;
    const node = nodes.get(stepId);
    if (!node) return false;

    // Apply changes to the step definition
    Object.assign(node.step, changes);
    // Update deps if changed
    if (changes.dependsOn) {
      node.deps = changes.dependsOn.filter(d => nodes.has(d));
      // Rebuild dependent links
      for (const [, n] of nodes) {
        n.dependents = [];
        for (const [oid, other] of nodes) {
          if (other.deps.includes(oid)) n.dependents.push(oid);
        }
      }
    }
    logger.info('dag', `Modified step ${stepId} in running workflow in ${group}`);
    // If step is pending, reschedule to pick up changes
    if (node.status === StepStatus.PENDING) this.api.schedule(run.runId);
    return true;
  }

  /** v0.4: Recover incomplete runs — resume from checkpoint */
  recoverCheckpoints(): Array<{ group: string; runId: string; workflowName: string }> {
    const incomplete = findIncompleteRuns();
    const recovered: Array<{ group: string; runId: string; workflowName: string }> = [];

    for (const { group, runId, meta } of incomplete) {
      logger.info('checkpoint', `Resuming: ${meta.workflowName} (${runId.slice(0, 8)}) in ${group}`);

      const wfPath = path.join(GROUPS_DIR, group, 'workflow.yaml');
      if (!fs.existsSync(wfPath)) {
        logger.warn('checkpoint', `No workflow.yaml in ${group}, marking as failed`);
        completeRunCheckpoint(group, runId, 'failed', 'workflow.yaml not found');
        continue;
      }

      try {
        const raw = fs.readFileSync(wfPath, 'utf-8');
        const def = parseWorkflowYaml(raw);

        const newRunId = runId;
        const completedSteps = meta.steps.filter(s => s.status === 'completed');
        const rec: WorkflowRunRecord = {
          runId: newRunId,
          workflowName: def.name,
          startedAt: meta.startedAt,
          status: WorkflowStatus.RUNNING,
          steps: new Map(def.steps.map(s => [s.id, StepStatus.PENDING])),
          stepRetries: new Map(),
          rollbacks: [],
          compensations: [],
          taskReports: new Map(),
        };

        for (const cs of completedSteps) {
          rec.steps.set(cs.stepId, StepStatus.COMPLETED);
        }

        rec.group = group;
        this.state.runs.set(newRunId, rec);
        this.state.latestRuns.set(def.name, newRunId);

        this.executeDag(newRunId, def).catch((err: Error) => {
          const r = this.state.runs.get(newRunId);
          if (r) { r.status = WorkflowStatus.FAILED; r.completedAt = Date.now(); }
          completeRunCheckpoint(group, newRunId, 'failed');
          logger.error('checkpoint', `Resume failed: ${err.message}`);
        });

        recovered.push({ group, runId: newRunId, workflowName: meta.workflowName });
      } catch (err: unknown) {
        logger.error('checkpoint', `Resume error: ${err instanceof Error ? err.message : String(err)}`);
        completeRunCheckpoint(group, runId, 'failed');
      }
    }
    return recovered;
  }

  /** Get learning records for a group */
  getLearningRecords(group: string, limit = 20): Array<Record<string, unknown>> {
    return getLearningRecordsFn(group, limit);
  }

  /** Get average scores for a group */
  getQualitySummary(group: string) {
    return getQualitySummaryFn(group);
  }

  // ═══════════════════════════════════════════════════ Private Methods ═══

  /** Core DAG execution */
  private async executeDag(runId: string, def: WorkflowDefinition, triggerStepId?: string): Promise<void> {
    const run = this.state.runs.get(runId); if (!run) return;
    const nodes = new Map<string, DagNode>();

    // Store YAML definition for later use (lazy instantiation)
    run._yamlDef = def;

    // Preserve existing node state when rebuilding DAG (e.g. after approval)
    const oldNodes = this.state.runNodes.get(runId);

    const addStep = (s: WorkflowStep) => {
      if (nodes.has(s.id)) return;
      const existingStatus = run.steps.get(s.id) || StepStatus.PENDING;
      const oldNode = oldNodes?.get(s.id);
      nodes.set(s.id, {
        step: s, deps: s.dependsOn || [], dependents: [],
        status: existingStatus,
        output: oldNode?.output || '',
        error: oldNode?.error || '',
        retryCount: oldNode?.retryCount || 0,
        maxRetries: s.retry ?? 3,
        rejectCount: oldNode?.rejectCount || 0,
        maxRejectRetries: s.maxRejectRetries ?? 3,
        onFailure: s.onFailure, onReject: s.onReject, onApprove: s.onApprove,
        routes: s.routes, timeout: s.timeout || 300000,
        startedAt: oldNode?.startedAt || 0, notifiedAt: oldNode?.notifiedAt || 0,
      });
    };

    const rebuildDependents = () => {
      for (const [, node] of nodes) node.dependents = [];
      for (const [id, node] of nodes) {
        for (const [oid, other] of nodes) {
          if (other.deps.includes(id)) node.dependents.push(oid);
        }
      }
    };

    // Store nodes for callback lookup
    this.state.runNodes.set(runId, nodes);

    // ── Instantiate step(s) to trigger ──
    if (triggerStepId) {
      const targetStep = def.steps.find(s => s.id === triggerStepId);
      if (targetStep) {
        addStep(targetStep);
        run.steps.set(targetStep.id, StepStatus.PENDING);
        logger.info('execute', `Triggered step ${targetStep.id}`);
      } else {
        logger.warn('execute', `Step ${triggerStepId} not found in workflow`);
      }
    } else {
      // No specific step — trigger all trigger-type steps
      const triggerSteps = def.steps.filter(s => s.type === 'trigger' || s.trigger);
      for (const s of triggerSteps) {
        addStep(s);
        const node = nodes.get(s.id)!;
        node.status = StepStatus.COMPLETED;
        node.output = JSON.stringify(s.trigger || { type: 'manual' });
        run.steps.set(s.id, StepStatus.COMPLETED);
        logger.info('execute', `Trigger ${s.id} auto-completed`);
      }
    }

    rebuildDependents();

    // ── Start scheduling (callback model) ──
    this.api.schedule(runId);
  }

  /** Find the latest running workflow by group name */
  private findRunByGroup(group: string): WorkflowRunRecord | undefined {
    let latest: WorkflowRunRecord | undefined;
    for (const run of this.state.runs.values()) {
      if (run.group === group && run.status === WorkflowStatus.RUNNING) {
        if (!latest || run.startedAt > latest.startedAt) latest = run;
      }
    }
    return latest;
  }
}
