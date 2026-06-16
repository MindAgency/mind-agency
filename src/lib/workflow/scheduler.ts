/**
 * Workflow Engine — Scheduler
 *
 * The schedule() method, lazy instantiation of DAG steps, and ready-step detection.
 */

import fs from 'fs';
import path from 'path';
import { GROUPS_DIR } from '../data-dir';
import { atomicWrite } from '../atomic';
import { EventType, createEvent } from '../event-bus';
import {
  saveStepCheckpoint, completeRunCheckpoint,
  appendRunHistory, cleanupCheckpoints,
} from '../workflow-checkpoint';
import { autoRespond } from '../auto-respond';
import { getAgents } from './types';
import {
  type EngineState,
  type EngineAPI,
  type WorkflowRunRecord,
  type DagNode,
  StepStatus,
  WorkflowStatus,
  WorkflowPhase,
  phaseForAction,
  logger,
} from './types';

// ═══════════════════════════════════════════════════ schedule ═══

/** Schedule ready steps in a run (callback model) */
export function schedule(state: EngineState, api: EngineAPI, runId: string): void {
  if (state.scheduling.has(runId)) return;
  state.scheduling.add(runId);
  try {
    const run = state.runs.get(runId);
    if (!run || run.status !== WorkflowStatus.RUNNING) return;

    // Check abort
    const ac = state.abortControllers.get(runId);
    if (ac?.signal.aborted) {
      run.status = WorkflowStatus.FAILED;
      run.completedAt = Date.now();
    } else {
      _scheduleInner(state, api, runId, run);
    }

  } catch (e) {
    logger.error('schedule', `Schedule error`, e);
  } finally { state.scheduling.delete(runId); }
}

function _scheduleInner(state: EngineState, api: EngineAPI, runId: string, run: WorkflowRunRecord): void {
  const currentNodes = state.runNodes.get(runId);
  if (!currentNodes) return;

  // ── Lazy instantiation: find steps from YAML whose deps are all completed ──
  const yamlDef = run._yamlDef;
  if (yamlDef) {
    for (const yamlStep of yamlDef.steps) {
      if (currentNodes.has(yamlStep.id)) continue; // already instantiated
      const deps = yamlStep.dependsOn || [];
      // Steps with no deps are entry points — instantiate them as ready
      if (deps.length === 0) {
        currentNodes.set(yamlStep.id, {
          step: yamlStep, deps, dependents: [],
          status: StepStatus.PENDING, output: '', error: '',
          retryCount: 0, maxRetries: yamlStep.retry ?? 3,
          rejectCount: 0, maxRejectRetries: yamlStep.maxRejectRetries ?? 3,
          onFailure: yamlStep.onFailure, onReject: yamlStep.onReject, onApprove: yamlStep.onApprove,
          routes: yamlStep.routes, timeout: yamlStep.timeout || 600000, startedAt: 0, notifiedAt: 0,
        });
        run.steps.set(yamlStep.id, StepStatus.PENDING);
        logger.debug('schedule', `Lazy-instantiated entry point ${yamlStep.id}`);
        continue;
      }
      const allDepsCompleted = deps.every(d => {
        const dn = currentNodes.get(d);
        return dn && (dn.status === StepStatus.COMPLETED || dn.status === StepStatus.SKIPPED);
      });
      if (allDepsCompleted) {
        // Instantiate this step
        logger.info('schedule', `Lazy-instantiated ${yamlStep.id} (deps: ${deps.join(', ')})`);
        currentNodes.set(yamlStep.id, {
          step: yamlStep, deps, dependents: [],
          status: StepStatus.PENDING, output: '', error: '',
          retryCount: 0, maxRetries: yamlStep.retry ?? 3,
          rejectCount: 0, maxRejectRetries: yamlStep.maxRejectRetries ?? 3,
          onFailure: yamlStep.onFailure, onReject: yamlStep.onReject, onApprove: yamlStep.onApprove,
          routes: yamlStep.routes, timeout: yamlStep.timeout || 600000, startedAt: 0, notifiedAt: 0,
        });
        run.steps.set(yamlStep.id, StepStatus.PENDING);
        logger.debug('schedule', `Lazy-instantiated ${yamlStep.id}`);
      }
    }
    // Rebuild dependents
    for (const [, node] of currentNodes) node.dependents = [];
    for (const [id, node] of currentNodes) {
      for (const [oid, other] of currentNodes) {
        if (other.deps.includes(id)) node.dependents.push(oid);
      }
    }
  }

  // Find ready steps
  const ready: DagNode[] = [];
  for (const [id, node] of currentNodes) {
    if (node.status === StepStatus.COMPLETED || node.status === StepStatus.FAILED || node.status === StepStatus.IN_PROGRESS || node.status === StepStatus.WAITING) continue;
    const depsOk = node.deps.every(depId => {
      const dn = currentNodes.get(depId);
      return dn && (dn.status === StepStatus.COMPLETED || dn.status === StepStatus.SKIPPED);
    });
    if (!depsOk) {
      const depStatuses = node.deps.map(d => `${d}:${currentNodes.get(d)?.status || 'missing'}`).join(', ');
      logger.debug('schedule', `${id} blocked (deps: ${depStatuses})`);
      node.status = StepStatus.BLOCKED; run.steps.set(id, StepStatus.BLOCKED); continue;
    }
    ready.push(node);
  }

  if (ready.length === 0) {
    // Check if there are any active steps (waiting for agent callback)
    const hasActive = [...currentNodes.values()].some(n =>
      n.status === StepStatus.WAITING || n.status === StepStatus.IN_PROGRESS
    );
    if (hasActive) return; // Still have work in progress, don't end yet

    // Check if there are pending/blocked steps that might get new dependencies
    const hasPending = [...currentNodes.values()].some(n =>
      n.status === StepStatus.PENDING || n.status === StepStatus.BLOCKED
    );
    if (hasPending) return; // More steps waiting, don't end yet

    // No active, no pending — workflow is done
    let failed = false;
    for (const [, n] of currentNodes) { if (n.status === StepStatus.FAILED) failed = true; }
    run.status = failed ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
    run.completedAt = Date.now();
    logger.info('schedule', `Run ${runId.slice(0, 8)} ${run.status}`);

    // Emit a final TASK_COMPLETED event for the run itself so that
    // workflow-bridge.ts waitForCompletion handler picks up the status change
    // and persists it to workflow-state.json.
    if (state.bus) {
      state.bus.emit(createEvent(EventType.TASK_COMPLETED, {
        taskId: runId,
        workflow: run.workflowName,
        status: run.status,
        group: run.group || '',
        completedAt: run.completedAt,
      }, 'workflow-engine'));
    }

    // Directly persist the final status to workflow-state.json
    // (belt-and-suspenders: the event handler in workflow-bridge.ts may have already resolved)
    const grp = run.group as string | undefined;
    if (grp) {
      try {
        const statePath = path.join(GROUPS_DIR, grp, 'workflow-state.json');
        if (fs.existsSync(statePath)) {
          const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
          stateData.status = run.status === WorkflowStatus.COMPLETED ? 'completed' : 'failed';
          stateData.completedAt = run.completedAt || Date.now();
          atomicWrite(statePath, JSON.stringify(stateData, null, 2));
          logger.info('schedule', `Persisted workflow-state.json for ${grp}: ${stateData.status}`);
        }
      } catch (e) {
        logger.warn('schedule', `Failed to persist workflow-state.json for ${grp}`, e);
      }
    }
    api.reviewWorkflowExecution(grp, run, currentNodes);
    if (grp) {
      completeRunCheckpoint(grp, runId, run.status === WorkflowStatus.COMPLETED ? 'completed' : 'failed');
      const stepsCompleted = [...(run.steps.values())].filter(s => s === StepStatus.COMPLETED).length;
      const stepsFailed = [...(run.steps.values())].filter(s => s === StepStatus.FAILED).length;
      appendRunHistory(grp, {
        runId, workflowName: run.workflowName, group: grp,
        startedAt: run.startedAt, completedAt: Date.now(),
        status: run.status === WorkflowStatus.COMPLETED ? 'completed' : 'failed',
        stepsTotal: currentNodes.size, stepsCompleted, stepsFailed,
        compensations: run.compensations.length || 0,
      });
      cleanupCheckpoints(grp);
    }
    return;
  }

  for (const node of ready) {
    api.execNode(runId, node, currentNodes).then(() => {
      // After execNode completes (notification written), immediately trigger
      // the agent's auto-respond so it processes the workflow notification
      // without waiting for the next polling cycle.
      const agents = getAgents(node.step);
      for (const agent of agents) {
        autoRespond(agent, { groupName: run.group, force: true }).catch((err: unknown) => {
          logger.warn('schedule', `autoRespond failed for ${agent}: ${err instanceof Error ? err.message : String(err)}`);
          // Fallback: if autoRespond fails (e.g. agent queue busy, AI provider down),
          // re-schedule so the step stays alive and can be retried by the next poll cycle
          api.schedule(runId);
        });
      }
    }).catch((err: unknown) => {
      logger.error('schedule', `execNode failed for ${node.step.id}: ${err instanceof Error ? err.message : String(err)}`);
      // Re-trigger scheduling so the workflow doesn't stall
      api.schedule(runId);
    });
  }
}
