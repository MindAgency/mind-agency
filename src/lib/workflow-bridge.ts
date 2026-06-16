import { atomicWrite } from "./atomic";
/**
 * Workflow Bridge — unified workflow execution (v1.0).
 *
 * Uses WorkflowEngine with ChatStepExecutor (real AI via chatOnce).
 * human_approval steps pause the DAG and wait for API approval.
 * All runs and pending approvals are stored in-memory (survives within process).
 * Run metadata persisted to Groups/<name>/workflow-state.json.
 *
 * TIMEOUT UNITS: All timeout values in workflow steps are in MILLISECONDS.
 * Common values: 30000 (30s), 60000 (1min), 300000 (5min), 600000 (10min).
 * Default: 300000ms (5 minutes) if not specified.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { GROUPS_DIR } from './data-dir';
import {
  WorkflowEngine, WorkflowStatus,
  parseWorkflowYaml, type WorkflowDefinition,
  type WorkflowRunRecord, type StepStatus,
} from './event-bus';
import { createStepExecutor } from './workflow/executor';
import { loadRunCheckpoints } from './workflow-checkpoint';

// ══════════════════════════════ Singleton Engine ═══════════════════════════

let engine: WorkflowEngine | null = null;

/** Module-level AbortController — cancelled on shutdown to stop all polling loops */
const _shutdownController = new AbortController();

export function getEngine(bus?: any): WorkflowEngine {
  if (!engine) {
    // Try to recover from global (survives module reload)
    engine = (global as any).__workflowEngine || null;
  }
  if (!engine) {
    engine = new WorkflowEngine(bus, createStepExecutor());
    (global as any).__workflowEngine = engine;
  } else if (bus && !(engine as any).bus) {
    (engine as any).bus = bus;
  }
  return engine;
}

// ════════════════════════════ Public API ═════════════════════════════════

/** Trigger a workflow for a group. Runs DAG asynchronously via callback model. */
export async function triggerWorkflow(group: string, triggerStepId?: string): Promise<{ runId: string } | { error: string }> {
  const wfPath = path.join(GROUPS_DIR, group, 'workflow.yaml');
  if (!fs.existsSync(wfPath)) return { error: `no workflow.yaml in ${group}` };

  const yaml = fs.readFileSync(wfPath, 'utf-8');
  let def: WorkflowDefinition;
  try { def = parseWorkflowYaml(yaml); }
  catch { return { error: 'invalid workflow YAML' }; }
  if (!def.name || !def.steps?.length) return { error: 'workflow requires name and steps' };

  const eng = getEngine();
  const run = eng.execute(def, group, triggerStepId);
  run._wfDef = def;
  run._yamlPath = wfPath;

  // Persist initial state to disk immediately
  saveWorkflowState(group, {
    workflowName: def.name,
    runId: run.runId,
    currentStep: '',
    owner: '',
    status: 'running',
    startedAt: run.startedAt,
    history: [],
  });

  // Async completion watcher (fire and forget)
  waitForCompletion(run.runId, group).catch(err => {
    console.error(`[wf] completion watcher error for ${group}:`, err);
  });

  return { runId: run.runId };
}

/** Get all workflow runs (for status display). Falls back to disk if engine is cold. */
export function getRuns(): Array<{
  runId: string; group: string; workflowName: string; status: string;
  stepsTotal: number; stepsDone: number; startedAt: number;
  steps: Record<string, string>; // stepId → status
  pendingApprovals: Array<{ approvalId: string; stepId: string; agent: string; prompt: string }>;
}> {
  // Try in-memory first (recover from global if module was reloaded)
  const eng = getEngine();
  if (eng) {
    const runs = eng.listRuns();
    if (runs.length > 0) {
      const approvals = eng.listPendingApprovals();
      return runs.map(r => ({
        runId: r.runId,
        group: (r as any)._group || (r as any).group || '',
        workflowName: r.workflowName,
        status: r.status,
        stepsTotal: r.steps.size,
        stepsDone: [...r.steps.values()].filter(s => s === 'completed' || s === 'skipped').length,
        startedAt: r.startedAt,
        steps: Object.fromEntries(r.steps),
        pendingApprovals: approvals.filter(a => a.runId === r.runId).map(a => ({
          approvalId: a.approvalId, stepId: a.stepId, agent: a.agent, prompt: a.prompt,
        })),
      }));
    }
  }

  // Fallback to disk (engine cold after restart or hot-reload)
  // Use cached results to avoid blocking the event loop repeatedly
  const now = Date.now();
  if (diskRunsCache && (now - diskRunsCache.ts) < DISK_RUNS_CACHE_TTL) {
    return diskRunsCache.data;
  }

  try {
    if (!fs.existsSync(GROUPS_DIR)) { diskRunsCache = { data: [], ts: now }; return []; }
    const groups = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
    const results: any[] = [];
    for (const g of groups) {
      if (!g.isDirectory() || g.name.startsWith('.')) continue;
      const state = loadWorkflowState(g.name);
      if (state && (state.status === 'running' || state.status === 'completed' || state.status === 'failed')) {
        // Read checkpoint data for step counts
        let stepsTotal = 0, stepsDone = 0;
        const steps: Record<string, string> = {};
        try {
          const cps = loadRunCheckpoints(g.name, state.runId);
          stepsTotal = cps.length;
          for (const cp of cps) {
            steps[cp.stepId] = cp.status;
            if (cp.status === 'completed' || cp.status === 'skipped') stepsDone++;
          }
        } catch { /* no checkpoints */ }
        results.push({
          runId: state.runId, group: g.name, workflowName: state.workflowName,
          status: state.status, stepsTotal, stepsDone, startedAt: state.startedAt,
          steps, pendingApprovals: [],
        });
      }
    }
    diskRunsCache = { data: results, ts: now };
    return results;
  } catch (err) {
    console.error('[workflow-bridge] getRuns disk fallback error:', err);
    return diskRunsCache?.data || [];
  }
}

// Disk fallback cache (avoids blocking the event loop on repeated calls)
let diskRunsCache: { data: ReturnType<typeof getRuns>; ts: number } | null = null;
const DISK_RUNS_CACHE_TTL = 5_000; // 5s cache for disk reads

/** Submit a human approval decision and resume the DAG. */
export function approveWorkflow(
  approvalId: string,
  decision: 'APPROVED' | 'REJECTED',
  comment?: string
): { ok: boolean; error?: string } {
  const eng = getEngine();
  const ok = eng.submitApproval(approvalId, decision, comment);
  if (!ok) return { ok: false, error: 'approval not found or already processed' };

  // Update persisted state
  const pending = eng.listPendingApprovals();
  // Find the run this approval belonged to
  for (const r of eng.listRuns()) {
    const group = (r as any)._group;
    if (group) {
      saveWorkflowState(group, {
        workflowName: r.workflowName,
        runId: r.runId,
        currentStep: '',
        owner: '',
        status: r.status,
        startedAt: r.startedAt,
        history: [],
      });
    }
  }

  return { ok: true };
}

/** Get pending approvals for a specific group. */
export function getPendingApprovals(group: string): Array<{
  approvalId: string; runId: string; stepId: string; agent: string; prompt: string;
}> {
  const eng = getEngine();
  return eng.listPendingApprovals().filter(a => {
    for (const r of eng.listRuns()) {
      if (r.runId === a.runId && (r as any)._group === group) return true;
    }
    return false;
  });
}

// ═══════════════════════════════ Internal ═══════════════════════════════

/** Extend WorkflowRunRecord with metadata fields */
declare module './event-bus' {
  interface WorkflowRunRecord {
    _group?: string;
    _wfDef?: WorkflowDefinition;
    _yamlPath?: string;
  }
}

// ── Group state persistence ─────────────────────────────────

interface GroupWorkflowState {
  workflowName: string;
  runId: string;
  currentStep: string;
  owner: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  history: { step: string; agent: string; result: string; at: number }[];
}

function loadWorkflowState(group: string): GroupWorkflowState | null {
  const fp = path.join(GROUPS_DIR, group, 'workflow-state.json');
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { console.error('[lib:workflow-bridge]', e); }
  return null;
}

function saveWorkflowState(group: string, state: GroupWorkflowState): void {
  const fp = path.join(GROUPS_DIR, group, 'workflow-state.json');
  
  atomicWrite(fp, JSON.stringify(state, null, 2));
}

// ── Completion watcher ────────────────────────────────────

async function waitForCompletion(runId: string, group: string): Promise<void> {
  const eng = getEngine();
  const { signal } = _shutdownController;

  // Use EventBus for event-driven completion (instead of polling)
  return new Promise<void>((resolve) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => { cleanup(); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });

    // Subscribe to task.completed and task.blocked events
    import('./event-bus').then(({ getEventBus, EventType }) => {
      const bus = getEventBus();
      const onTaskComplete = (msg: any) => {
        if (msg.payload?.taskId === runId || msg.payload?.group === group) {
          const run = eng.getRun(runId);
          if (!run) { cleanup(); resolve(); return; }

          if (run.status === WorkflowStatus.COMPLETED) {
            const s = loadWorkflowState(group);
            if (s) { s.status = 'completed'; s.completedAt = run.completedAt || Date.now(); saveWorkflowState(group, s); }
            cleanup(); resolve();
          } else if (run.status === WorkflowStatus.FAILED) {
            const s = loadWorkflowState(group);
            if (s) { s.status = 'failed'; s.completedAt = run.completedAt || Date.now(); saveWorkflowState(group, s); }
            cleanup(); resolve();
          } else {
            // Update progress
            const s = loadWorkflowState(group);
            if (s) {
              s.status = run.status;
              const done: string[] = [];
              for (const [sid, st] of run.steps) {
                if (st === 'completed' || st === 'skipped') done.push(sid);
              }
              s.currentStep = done.join(',');
              saveWorkflowState(group, s);
            }
          }
        }
      };

      bus.subscribe(
        { event: EventType.TASK_COMPLETED },
        { scope: 'events' },
        `wf-wait:${runId}`,
        onTaskComplete
      );
      bus.subscribe(
        { event: EventType.TASK_BLOCKED },
        { scope: 'events' },
        `wf-wait-blocked:${runId}`,
        onTaskComplete
      );

      // Fallback: check immediately in case workflow already completed
      const run = eng.getRun(runId);
      if (!run || run.status === WorkflowStatus.COMPLETED || run.status === WorkflowStatus.FAILED) {
        cleanup(); resolve();
      }
    });
  });
}

// ── Recovery ──────────────────────────────────────────────

export function recoverRunningWorkflows(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;
  const ZOMBIE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
  for (const g of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!g.isDirectory() || g.name.startsWith('.')) continue;
    const state = loadWorkflowState(g.name);
    if (state && state.status === 'running') {
      const elapsed = Date.now() - state.startedAt;
      if (elapsed > ZOMBIE_TIMEOUT_MS) {
        // Zombie workflow — mark as failed
        state.status = 'failed';
        state.completedAt = Date.now();
        saveWorkflowState(g.name, state);
        console.log(`[wf] zombie workflow in ${g.name}: ${state.workflowName} (${state.runId.slice(0, 8)}...) — stuck for ${Math.round(elapsed / 60000)} min, marked as failed`);
      } else {
        console.log(`[wf] recovered workflow in ${g.name}: ${state.workflowName} (${state.runId.slice(0, 8)}...)`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

/** Cancel all polling loops — call from server.ts shutdown handler */
export function cancelAllWatchers(): void {
  _shutdownController.abort();
  console.log('[wf] all completion watchers cancelled');
}
