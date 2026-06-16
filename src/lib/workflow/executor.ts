/**
 * Workflow Engine — Step Executor
 *
 * The execNode() method, notifyAgent() method, and step executor classes
 * (SimulatedStepExecutor, ChatStepExecutor).
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, MIND_DIR, GROUPS_DIR } from '../data-dir';
import { broadcastWs } from '../ws-embedded';
import { enqueueTask } from '../task-queue';
import { checkToolPermission } from '../permission-engine';
import { EventBus, EventType, createEvent } from '../event-bus';
import { metrics } from '../metrics';
import { atomicWrite } from '../atomic';
import { CircuitBreaker } from '../circuit-breaker';
import { toUserError } from '../errors';
import {
  type EngineState,
  type EngineAPI,
  type WorkflowStep,
  type WorkflowRunRecord,
  type StepExecutor,
  type DagNode,
  StepStatus,
  WorkflowPhase,
  phaseForAction,
  parseReviewFindings,
  getAgents,
  logger,
} from './types';

// ═══════════════════════════════════════════════════ Executor Classes ═══

/** Simulated executor — synthetic outputs for dev/testing, ChatDev-style reviews */
export class SimulatedStepExecutor implements StepExecutor {
  async execute(step: WorkflowStep, ctx: Record<string, string>): Promise<string> {
    const a = (step.action || '').toLowerCase();
    const agent = step.agent || 'unknown';
    const action = step.action || 'execute';
    const stepId = step.id || 'unknown_step';
    const prompt = (step.prompt || '').trim();

    // Header with metadata for all outputs
    const header = `[${stepId}] Agent: ${agent} | Action: ${action}`;
    const promptSnippet = prompt ? `\nPrompt: ${prompt.slice(0, 300)}${prompt.length > 300 ? '...' : ''}` : '';

    if (a.includes('review') || a.includes('audit')) {
      // ChatDev-style: precise file:line findings
      const findings = [
        `ISSUE|src/lib/event-bus.ts:173|backpressure check may race with unsubscribe|Move backpressure increment after filter match, use atomic counter`,
        `ISSUE|src/lib/scheduler.ts:38|tick() does not await pollAllAgents, may lose errors|Add try/catch around await and emit poll.error on failure`,
      ];
      // If context contains prior review findings, add a fix-verification note
      const prevReview = Object.values(ctx).find(v => v.includes('ISSUE|'));
      if (prevReview) {
        findings.push(`ISSUE|src/lib/event-bus.ts:173|prior fix not verified — re-review needed|Re-check backpressure logic after fix`);
      }
      const decision = prevReview ? 'APPROVED_WITH_NOTES' : 'APPROVED';
      return `REVIEW_COMPLETE ${header}${promptSnippet}\nDECISION:${decision}\nFindings (${findings.length}):\n${findings.join('\n')}`;
    }
    if (a.includes('approve')) {
      return `APPROVED ${header}${promptSnippet}\nDecision: The requested action meets all quality criteria and is approved for execution.`;
    }
    if (a.includes('reject')) {
      return `REJECTED ${header}${promptSnippet}\nReason: Output does not meet the required standards. Please revise and resubmit.`;
    }
    if (a.includes('deploy')) {
      return `DEPLOYED+PASSED ${header}${promptSnippet}\nDeployment completed successfully. Health check: all endpoints responding. No errors in logs.`;
    }
    if (a.includes('verify') || a.includes('test')) {
      const testCount = Math.floor(Math.random() * 20) + 10;
      const passed = testCount - Math.floor(Math.random() * 3);
      return `VERIFIED ${header}${promptSnippet}\nTest results: ${passed}/${testCount} passed, ${testCount - passed} skipped, 0 failed.\nAll critical paths verified.`;
    }
    if (a.includes('fix') || a.includes('修复')) {
      // Fixer step: extract findings from context and produce targeted fixes
      const allFindings = Object.values(ctx).flatMap(v => parseReviewFindings(v));
      if (allFindings.length > 0) {
        return `FIXED ${allFindings.length} issues ${header}${promptSnippet}\n${allFindings.map(f => `FIXED|${f.file}:${f.line}|${f.desc}`).join('\n')}`;
      }
      return `FIXED ${header}${promptSnippet}\nNo issues found in upstream review. Codebase is clean.`;
    }
    if (a.includes('notify')) {
      const targets = Array.isArray(step.notify) ? step.notify.join(', ') : (step.notify || 'all agents');
      return `NOTIFIED ${header}${promptSnippet}\nNotification sent to: ${targets}. Delivery confirmed.`;
    }
    if (a.includes('research')) {
      return `RESEARCH_COMPLETE ${header}${promptSnippet}\nResearch summary: Analyzed the topic from multiple angles. Key findings: (1) Current approach is viable with minor adjustments, (2) Alternative approaches exist but offer marginal gains, (3) Recommended path forward documented below.\n\nDetailed findings:\n- Primary analysis completed\n- Cross-referenced with existing documentation\n- Confidence level: high`;
    }
    if (a.includes('design')) {
      return `DESIGN_COMPLETE ${header}${promptSnippet}\nDesign artifact created. Components: architecture overview, data flow diagram, API schema. All requirements covered. Ready for review.`;
    }
    if (a.includes('create') || a.includes('generate') || a.includes('写') || a.includes('生成')) {
      return `CREATED ${header}${promptSnippet}\nArtifact generated successfully. Output written to the designated location. Preview: document contains structured content matching the requested format.`;
    }
    return `COMPLETED ${header}${promptSnippet}\nTask executed successfully. All objectives met.`;
  }
}

/** Production executor — calls agent via chatOnce (real AI) with model fallback */
export class ChatStepExecutor implements StepExecutor {
  async execute(step: WorkflowStep, ctx: Record<string, string>): Promise<string> {
    const { chatOnce } = await import('../chat');
    // v1.1: Build context from upstream steps — smart truncation, not fixed 500 chars
    // Total context budget: 4000 chars. Split proportionally among upstream outputs.
    const entries = Object.entries(ctx);
    const totalLen = entries.reduce((sum, [, v]) => sum + v.length, 0);
    const BUDGET = 4000;
    const ctxStr = entries
      .map(([k, v]) => {
        if (k.includes('.')) {
          // Task report field (e.g., "step1.status", "step1.summary")
          return `[${k}]: ${v}`;
        }
        // Proportional truncation: give more space to larger outputs
        const limit = entries.length === 1 ? BUDGET : Math.max(500, Math.floor(BUDGET * v.length / totalLen));
        const truncated = v.length > limit ? v.slice(0, limit) + `\n...(共 ${v.length} 字，截取前 ${limit} 字)` : v;
        return `[上游步骤 ${k} 的输出]\n${truncated}`;
      })
      .join('\n\n');

    // v1.2: Query learning records — inject past feedback so agent avoids repeating mistakes
    const agent = step.agent || 'unknown';
    let learningHint = '';
    try {
      const evalDir = path.join(MIND_DIR, 'learning');
      if (fs.existsSync(evalDir)) {
        // Search all group learning files for this agent's past rejections
        const files = fs.readdirSync(evalDir).filter(f => f.startsWith('learning-') && f.endsWith('.jsonl'));
        const pastRejections: string[] = [];
        for (const f of files) {
          const lines = fs.readFileSync(path.join(evalDir, f), 'utf-8').split('\n').filter(Boolean);
          for (const line of lines.slice(-30)) { // Last 30 records per group
            try {
              const r = JSON.parse(line);
              if (r.agent === agent && r.evaluation?.verdict === 'NEEDS_REVISION' && r.evaluation?.feedback) {
                pastRejections.push(`[${r.stepId || r.workflow}] ${r.evaluation.feedback.slice(0, 200)}`);
              }
            } catch (e) { logger.error('misc', 'Unexpected error', e); }
          }
        }
        if (pastRejections.length > 0) {
          const unique = [...new Set(pastRejections)].slice(-3); // Last 3 unique rejections
          learningHint = `\n\n---\n\n【历史反馈 — 请避免以下问题】\n${unique.map((r, i) => `${i + 1}. ${r}`).join('\n')}`;
        }
      }
    } catch (e) { logger.error('misc', 'Unexpected error', e); }

    // v0.4: Step is a notification — agent does the work and reports via task tool
    const promptSuffix = `\n\n---\n\n【重要】完成任务后，请用 task 工具报告结果：
task(action="report", step_id="${step.id}", status="APPROVED 或 REJECTED", summary="你的结果摘要", details="详细说明")
这一步的结果会被工作流引擎读取。`;

    const prompt = ctxStr
      ? `[工作流上下文]\n${ctxStr}\n\n---\n\n你的任务:\n${step.prompt}${learningHint}${promptSuffix}`
      : `${step.prompt}${learningHint}${promptSuffix}`;

    // ── Permission check — every step execution goes through the engine ──
    const action = step.action || 'execute';
    const perm = checkToolPermission(agent, `workflow_step_${action}`, { stepId: step.id, action });
    if (!perm.allowed) {
      throw new Error(`步骤 ${step.id} (${action}) 需要审批: ${perm.message}`);
    }

    // ── Execution with model fallback ──
    let models = ['mimo-v2.5'];
    try {
      const settingsPath = path.join(MIND_DIR, 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.model) models = [settings.model];
      }
    } catch (e) { logger.error('misc', 'Unexpected error', e); }
    let lastError: unknown;

    for (let i = 0; i < models.length; i++) {
      try {
        logger.info('executor', `ChatStepExecutor → ${agent} (${action}) model=${models[i]} len=${prompt.length}`);
        // Pass model override to chatOnce — this sidesteps ANTHROPIC_MODEL env var
        const { createChatStream } = await import('../chat');
        const stream = await createChatStream(agent, prompt, undefined, models[i]);
        const reader = stream.getReader();
        let reply = '';
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.type === 'text') reply += value.content || '';
            if (value.type === 'error') throw new Error(value.content || 'Unknown error');
          }
        } finally {
          reader.releaseLock();
        }

        // v0.4: Read structured result from task report file
        const reportDir = path.join(MIND_DIR, 'agents', agent, '.task-reports');
        const reportPath = path.join(reportDir, `${step.id}.json`);
        if (fs.existsSync(reportPath)) {
          try {
            const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
            logger.info('executor', `ChatStepExecutor ← ${agent} task_report=${report.summary?.slice(0, 100)}`);
            // Clean up the report file
            fs.unlinkSync(reportPath);
            return `${report.status}: ${report.summary}${report.details ? '\n' + report.details : ''}`;
          } catch (e) { logger.error('misc', 'Unexpected error', e); }
        }

        // Fallback: use text output if agent didn't write to memory
        logger.info('executor', `ChatStepExecutor ← ${agent} text=${reply.slice(0, 100)} (no memory entry)`);
        return reply || `EMPTY_REPLY ACTION:${action} AGENT:${agent}`;
      } catch (e: unknown) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn('executor', `ChatStepExecutor ${models[i]} failed: ${msg}${i < models.length - 1 ? ' → trying fallback ' + models[i + 1] : ''}`);
        // Continue to next fallback model
      }
    }

    throw new Error(`ChatStepExecutor exhausted all models: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

export function createStepExecutor(): StepExecutor {
  // Use simulated mode when:
  // 1. Explicitly set via env var, OR
  // 2. No API key configured (check settings.json first, then env vars)
  const { getApiKey } = require('../api-settings');
  const hasApiKey = !!getApiKey();
  const isSimulated = process.env.WORKFLOW_EXECUTOR === 'simulated' || !hasApiKey;
  if (isSimulated) {
    logger.info('executor', 'Using SimulatedStepExecutor (no API key or explicit simulated mode)');
  }
  return isSimulated ? new SimulatedStepExecutor() : new ChatStepExecutor();
}

// ═══════════════════════════════════════════════════ Recovery ═══

/**
 * Check if the agent actually completed the work despite a timeout.
 *
 * When the AI takes too long to respond, the timeout fires before the callback
 * is processed. This function checks for evidence that the agent completed:
 *   1. Task report file exists in .task-reports/ (agent wrote via task tool)
 *   2. Notification file was deleted (callback was already processed)
 *
 * @returns An object indicating whether work was completed and the output if found.
 */
export function checkForCompletedWork(
  state: EngineState,
  runId: string,
  stepId: string,
  agent: string,
): { completed: boolean; output: string } {
  // Check 1: Task report file exists — agent used the task tool to report results
  try {
    const reportDir = path.join(MIND_DIR, 'agents', agent, '.task-reports');
    const reportPath = path.join(reportDir, `${stepId}.json`);
    if (fs.existsSync(reportPath)) {
      try {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
        if (report && report.status && report.summary) {
          // Clean up the report file
          fs.unlinkSync(reportPath);
          logger.info('recovery', `Found task report for ${stepId}: ${report.summary.slice(0, 100)}`);
          return {
            completed: true,
            output: `${report.status}: ${report.summary}${report.details ? '\n' + report.details : ''}`,
          };
        }
      } catch (e) {
        logger.warn('recovery', `Failed to read task report for ${stepId}`, e);
      }
    }
  } catch (e) {
    logger.warn('recovery', `Error checking task reports for ${agent}/${stepId}`, e);
  }

  // Check 2: Notification file was deleted — callback was already processed
  // If the notification file doesn't exist, the callback handler already cleaned it up
  try {
    const notifDir = path.join(AGENTS_DIR, agent, '.workflow-notifications');
    const notifPath = path.join(notifDir, `${runId}_${stepId}.json`);
    if (!fs.existsSync(notifDir) || !fs.existsSync(notifPath)) {
      // Notification was processed — check if the step was already transitioned
      const run = state.runs.get(runId);
      if (run) {
        const nodes = state.runNodes.get(runId);
        const node = nodes?.get(stepId);
        // If the node is still WAITING but the notification is gone,
        // the callback was likely processed but the step state wasn't updated
        // (race condition between timeout and callback)
        if (node && node.status === StepStatus.WAITING) {
          // Check if there's output from a previous callback attempt
          // The callback function stores output in node.output before transitioning
          if (node.output && node.output.length > 10) {
            logger.info('recovery', `Notification deleted for ${stepId} — callback was processed, recovering`);
            return { completed: true, output: node.output };
          }
        }
      }
    }
  } catch (e) {
    logger.warn('recovery', `Error checking notification for ${agent}/${stepId}`, e);
  }

  return { completed: false, output: '' };
}

// ═══════════════════════════════════════════════════ execNode ═══

/** Execute a single DAG node */
export async function execNode(
  state: EngineState,
  api: EngineAPI,
  runId: string,
  node: DagNode,
  nodes: Map<string, DagNode>,
): Promise<void> {
  const run = state.runs.get(runId); if (!run) return;
  const sid = node.step.id;
  const phase = phaseForAction(node.step.action || '');

  // ── Trigger steps: auto-complete immediately ──
  if (node.step.type === 'trigger') {
    api.transition(run, node, StepStatus.COMPLETED);
    node.output = JSON.stringify(node.step.trigger || { type: 'manual' });
    state.lifecycle.onStepCompleted?.(node.step, node.output);
    api.evaluatePostStep(runId, node, nodes, node.output);
    api.schedule(runId);
    return;
  }

  // ── Lifecycle: before execute ──
  const context: Record<string, string> = {};
  for (const [depId, depNode] of nodes) {
    if (node.deps.includes(depId) && depNode.output) context[depId] = depNode.output;
  }
  try {
    await state.lifecycle.onBeforeExecute?.(node.step, context);
  } catch (e) {
    logger.warn('exec', `onBeforeExecute failed for ${sid}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Human approval: pause DAG, wait for POST /workflows/approve ──
  if (node.step.action === 'human_approval') {
    const approvalId = randomUUID().slice(0, 8);
    api.transition(run, node, StepStatus.IN_PROGRESS);
    node.output = `AWAITING_HUMAN_APPROVAL approvalId=${approvalId}`;
    state.pendingApprovals.set(approvalId, { runId, stepId: sid, node, nodes });
    if (state.bus) state.bus.emit(createEvent(EventType.TASK_REVIEW_REQUESTED, {
      taskId: runId, stepId: sid, workflow: run.workflowName,
      agent: node.step.agent, action: 'human_approval',
      approvalId, phase: WorkflowPhase.APPROVAL,
      prompt: node.step.prompt,
    }, 'workflow-engine'));

    // Push notification to browser so the human user sees the approval request
    try {
      const group = run.group || '';
      broadcastWs('wf_approval', {
        runId, approvalId, stepId: sid, group,
        workflow: run.workflowName,
        agent: node.step.agent,
        prompt: (node.step.prompt || '').slice(0, 200),
      });
    } catch (e) { logger.error('misc', 'Unexpected error', e); }

    return; // Pause — resume via submitApproval()
  }

  if (state.bus) state.bus.emit(createEvent(EventType.TASK_IN_PROGRESS, { taskId: runId, stepId: sid, workflow: run.workflowName, agent: node.step.agent, action: node.step.action, phase }, 'workflow-engine'));

  // v1.2: Budget check — verify agent has enough balance
  const budgetAgent = node.step.agent || 'unknown';
  if (node.step.budget && node.step.budget > 0) {
    try {
      const { getBalance, withdraw } = await import('../token-economy');
      const balance = await getBalance(budgetAgent);
      if (balance < node.step.budget) {
        logger.warn('exec', `${budgetAgent} insufficient balance for ${sid}: has ${balance}, needs ${node.step.budget}`);
        const balanceErr = toUserError('insufficient_balance', { agent: budgetAgent, needed: String(node.step.budget), balance: String(balance) });
        node.error = `[${balanceErr.title}] ${balanceErr.message} -- ${balanceErr.suggestion}`;
        api.transition(run, node, StepStatus.FAILED);
        metrics.workflowStepFailures.inc();
        state.lifecycle.onStepFailed?.(node.step, node.error);
        run.rollbacks.push({ stepId: sid, reason: node.error, timestamp: Date.now() });
        if (state.bus) state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, stepId: sid, workflow: run.workflowName, agent: budgetAgent, reason: node.error, retriesExhausted: true, phase }, 'workflow-engine'));
        return;
      }
      // Deduct budget
      await withdraw(budgetAgent, node.step.budget, sid);
      logger.info('exec', `Deducted ${node.step.budget} tokens from ${budgetAgent} for ${sid}`);
    } catch (e) { logger.error('misc', 'Unexpected error', e); }
  }

  // v1.5: Build context from ALL completed upstream steps (transitive closure),
  // not just direct deps. This ensures downstream steps always receive upstream outputs
  // even if the DAG has missing intermediate dependencies.
  const ctx: Record<string, string> = {};
  const visited = new Set<string>();
  const queue = [...node.deps];
  while (queue.length > 0) {
    const depId = queue.shift()!;
    if (visited.has(depId)) continue;
    visited.add(depId);
    const dn = nodes.get(depId);
    if (dn?.output) ctx[depId] = dn.output;
    // v0.4: Include task report in downstream context
    const report = run.taskReports.get(depId);
    if (report) {
      ctx[`${depId}.status`] = report.status;
      ctx[`${depId}.summary`] = report.summary;
      ctx[`${depId}.details`] = report.details;
    }
    // Walk upstream: add deps of this dependency
    if (dn?.deps) {
      for (const upstreamId of dn.deps) {
        if (!visited.has(upstreamId)) queue.push(upstreamId);
      }
    }
  }

  try {
    // Circuit breaker: check if agent is allowed to execute
    const execAgent = node.step.agent || 'unknown';
    let cb = state.circuitBreakers.get(execAgent);
    if (!cb) {
      cb = new CircuitBreaker(3, 60000); // 3 failures, 60s cooldown
      state.circuitBreakers.set(execAgent, cb);
    }
    if (!cb.canExecute()) {
      const cbMsg = `Agent "${execAgent}" circuit is OPEN (failures: ${cb.getFailures()}). Cooling down.`;
      logger.warn('exec', cbMsg);
      node.error = cbMsg;
      api.transition(run, node, StepStatus.FAILED);
      metrics.workflowStepFailures.inc();
      state.lifecycle.onStepFailed?.(node.step, cbMsg);
      run.rollbacks.push({ stepId: sid, reason: cbMsg, timestamp: Date.now() });
      if (state.bus) state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, stepId: sid, workflow: run.workflowName, agent: execAgent, reason: cbMsg, retriesExhausted: true, phase }, 'workflow-engine'));
      api.schedule(runId);
      return;
    }

    // Simulated executor: execute directly without callback model
    if (state.executor instanceof SimulatedStepExecutor) {
      logger.info('exec', `Simulated mode: executing ${sid} directly (no callback needed)`);
      // Must go through IN_PROGRESS first (state machine requirement)
      api.transition(run, node, StepStatus.IN_PROGRESS);
      const output = await state.executor.execute(node.step, ctx);
      node.output = output;
      api.transition(run, node, StepStatus.COMPLETED);
      state.lifecycle.onStepCompleted?.(node.step, output);
      api.evaluatePostStep(runId, node, nodes, output);
      api.schedule(runId);
      return;
    }

    // v0.5: Callback model — notify agent, wait for callback
    api.notifyAgent(runId, node, nodes, ctx);

    // Set timeout — if callback doesn't come, fail the step
    const timeout = node.step.timeout || 600000; // 10 min default
    const timeoutTimer = setTimeout(() => {
      if (node.status === StepStatus.WAITING) {
        // v1.4: Recovery — check if agent actually completed work before marking FAILED
        const agentName = node.step.agent || 'unknown';
        const recoveryResult = checkForCompletedWork(state, runId, sid, agentName);
        if (recoveryResult.completed) {
          logger.info('exec', `Step ${sid} timed out but agent completed work — recovering with output: ${recoveryResult.output.slice(0, 100)}`);
          // Process the callback with the recovered output
          api.callback(runId, sid, recoveryResult.output);
          return;
        }

        api.transition(run, node, StepStatus.FAILED);
        const timeoutUserErr = toUserError('timeout', { stepId: sid, timeout: `${Math.round(timeout / 1000)}s` });
        node.error = `[${timeoutUserErr.title}] ${timeoutUserErr.message} -- ${timeoutUserErr.suggestion}`;
        state.lifecycle.onStepFailed?.(node.step, node.error);
        logger.warn('exec', `Step ${sid} timed out after ${timeout}ms`);
        api.schedule(runId);
      }
    }, timeout);
    // Store timer for cleanup
    node._timeoutTimer = timeoutTimer;

    return;  // DAG continues when agent calls workflow_callback
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    node.error = msg;
    // v1.5: Clear timeout timer to prevent memory leaks on failure
    if (node._timeoutTimer) {
      clearTimeout(node._timeoutTimer);
      node._timeoutTimer = undefined;
    }
    // Record failure in circuit breaker
    const failAgent = node.step.agent || 'unknown';
    const cbFail = state.circuitBreakers.get(failAgent);
    if (cbFail) cbFail.recordFailure();
    api.transition(run, node, StepStatus.FAILED);
    metrics.workflowStepFailures.inc();
    state.lifecycle.onStepFailed?.(node.step, msg);
    run.rollbacks.push({ stepId: sid, reason: msg, timestamp: Date.now() });
    if (state.bus) state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, stepId: sid, workflow: run.workflowName, agent: node.step.agent, reason: msg, retriesExhausted: true, phase }, 'workflow-engine'));

    // v1.2: Token economy — auto-deduct on step failure
    if (node.step.reward && node.step.reward > 0) {
      const failAgent = node.step.agent || 'unknown';
      try {
        const { penalize } = await import('../token-economy');
        await penalize(failAgent, Math.floor(node.step.reward * 0.2), msg.slice(0, 100));
        logger.info('exec', `Penalized ${failAgent} with ${Math.floor(node.step.reward * 0.2)} tokens for failed ${sid}`);
      } catch (err) {
        logger.warn('exec', `Failed to penalize ${failAgent}`, err);
      }
    }

    // Re-trigger scheduling so downstream steps / compensations can proceed
    api.schedule(runId);
  }
}

// ═══════════════════════════════════════════════════ notifyAgent ═══

/** Notify agent(s) to execute a step (fire-and-forget) */
export function notifyAgent(
  state: EngineState,
  api: EngineAPI,
  runId: string,
  node: DagNode,
  nodes: Map<string, DagNode>,
  ctx: Record<string, string>,
): void {
  const run = state.runs.get(runId);
  if (!run) return;
  const sid = node.step.id;
  const agents = getAgents(node.step);
  const isClaim = node.step.type === 'claim';

  // Build notification prompt with callback instructions
  // v1.5: Smart proportional truncation — total context budget 4000 chars,
  // split proportionally among upstream outputs (matching ChatStepExecutor logic)
  const entries = Object.entries(ctx);
  const totalLen = entries.reduce((sum, [, v]) => sum + v.length, 0);
  const CTX_BUDGET = 4000;
  const ctxStr = entries
    .map(([k, v]) => {
      if (k.includes('.')) {
        // Task report field (e.g., "step1.status", "step1.summary")
        return `[${k}]: ${v}`;
      }
      // Proportional truncation: give more space to larger outputs
      const limit = entries.length === 1 ? CTX_BUDGET : Math.max(500, Math.floor(CTX_BUDGET * v.length / totalLen));
      const truncated = v.length > limit ? v.slice(0, limit) + `\n...(共 ${v.length} 字，截取前 ${limit} 字)` : v;
      return `[上游步骤 ${k} 的输出]\n${truncated}`;
    })
    .join('\n\n');

  let callbackInstr: string;
  if (isClaim) {
    // Claim step: agent claims ownership, then triggers workflow
    callbackInstr = `\n\n【重要】这是一个认领步骤。请调用 workflow_claim MCP 工具来认领此任务。
工具调用格式：workflow_claim(runId="${runId}", stepId="${sid}")
认领后，你将成为此步骤的执行者，使用你自己的方式完成任务。`;
  } else {
    // Normal step: agent executes and reports via callback
    callbackInstr = `\n\n【重要】完成任务后，你必须调用 workflow_callback MCP 工具来报告结果。这是完成步骤的唯一方式。
工具调用格式：workflow_callback(runId="${runId}", stepId="${sid}", status="COMPLETED", summary="你的结果摘要", details="详细说明")
如果不调用此工具，工作流将无法推进到下一步。`;
  }

  const prompt = ctxStr
    ? `[工作流上下文]\n${ctxStr}\n\n---\n\n你的任务:\n${node.step.prompt}${callbackInstr}`
    : `${node.step.prompt}${callbackInstr}`;

  // Notify all agents
  for (const agent of agents) {
    if (state.bus) {
      state.bus.emit(createEvent(EventType.TASK_ASSIGNED, {
        taskId: runId, stepId: sid, workflow: run.workflowName,
        agent, action: node.step.action,
        prompt, phase: phaseForAction(node.step.action),
        isClaim,
      }, 'workflow-engine'));
    }

    // Persist notification to agent's directory
    try {
      const notifDir = path.join(AGENTS_DIR, agent, '.workflow-notifications');
      if (!fs.existsSync(notifDir)) fs.mkdirSync(notifDir, { recursive: true });
      const notifPath = path.join(notifDir, `${runId}_${sid}.json`);
      atomicWrite(notifPath, JSON.stringify({ runId, stepId: sid, prompt, isClaim, createdAt: Date.now() }));
    } catch (e) {
      logger.error('notify', `Failed to write notification for ${agent}`, e);
    }

    // Add to agent's task queue
    enqueueTask(agent, {
      runId, stepId: sid, workflow: run.workflowName,
      prompt: node.step.prompt || '',
      priority: (node.step.priority as any) || 'normal',
    });
  }

  node.status = StepStatus.WAITING;
  node.notifiedAt = Date.now();
  run.steps.set(sid, StepStatus.WAITING);

  logger.info('notify', `Notified ${agents.join(', ')} for ${sid} (run ${runId.slice(0, 8)})${isClaim ? ' [CLAIM]' : ''}`);

  // Push real-time status to frontend
  try {
    broadcastWs('wf_step_status', {
      runId, stepId: sid, status: 'waiting',
      workflow: run.workflowName, agents,
      group: run.group || '',
    });
  } catch (e) { logger.error('misc', 'Unexpected error', e); }
}
