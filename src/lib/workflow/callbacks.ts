/**
 * Workflow Engine — Callbacks & Post-Step Evaluation
 *
 * The callback() method, claim() method, route evaluation, review branching,
 * and learning record management.
 */

import fs from 'fs';
import path from 'path';
import { AGENTS_DIR, GROUPS_DIR, MIND_DIR } from '../data-dir';
import { atomicWrite } from '../atomic';
import { broadcastWs } from '../ws-embedded';
import { completeTask, enqueueTask } from '../task-queue';
import { saveStepCheckpoint } from '../workflow-checkpoint';
import { EventType, createEvent } from '../event-bus';
import { metrics } from '../metrics';
import { CircuitBreaker } from '../circuit-breaker';
import { toUserError } from '../errors';
import {
  type EngineState,
  type EngineAPI,
  type WorkflowStep,
  type WorkflowRunRecord,
  type WorkflowDefinition,
  type TaskReport,
  type DagNode,
  type WorkflowStepRoute,
  StepStatus,
  WorkflowStatus,
  WorkflowPhase,
  phaseForAction,
  getAgents,
  logger,
} from './types';

// ═══════════════════════════════════════════════════ callback ═══

/** Handle callback from agent — step completed */
export function callback(
  state: EngineState,
  api: EngineAPI,
  runId: string,
  stepId: string,
  output: string,
): boolean {
  const run = state.runs.get(runId);
  if (!run || run.status !== WorkflowStatus.RUNNING) {
    logger.warn('callback', `Callback FAILED: run ${runId.slice(0, 8)} not found or not running (status: ${run?.status})`);
    return false;
  }
  const nodes = state.runNodes.get(runId);
  if (!nodes) {
    logger.warn('callback', `Callback FAILED: no nodes for run ${runId.slice(0, 8)}`);
    return false;
  }
  const node = nodes.get(stepId);
  if (!node || node.status !== StepStatus.WAITING) {
    logger.warn('callback', `Callback FAILED: step ${stepId} not found or not waiting (status: ${node?.status})`);
    return false;
  }

  logger.info('callback', `Callback: ${stepId} ← ${output.slice(0, 100)} (run ${runId.slice(0, 8)})`);

  // v1.5: Clear timeout timer to prevent memory leaks and stale callbacks
  if (node._timeoutTimer) {
    clearTimeout(node._timeoutTimer);
    node._timeoutTimer = undefined;
  }

  // Complete task in agent's task queue
  const agentName = node.step.agent || 'unknown';

  // v1.0 P1: Detect placeholder/fake outputs — mark as FAILED instead of COMPLETED
  const PLACEHOLDER_PATTERNS = [
    /^Agent acknowledged task$/i,
    /^EMPTY_REPLY\b/i,
    /^\s*$/,  // Empty or whitespace-only
    /^COMPLETED ACTION:\w+ AGENT:\w+$/i,  // Simulated output without real content
  ];
  const isPlaceholder = PLACEHOLDER_PATTERNS.some(p => p.test(output.trim()));
  const isFailed = /FAILED|ERROR/i.test(output) || isPlaceholder;
  completeTask(agentName, runId, stepId, output.slice(0, 500), isFailed ? 'failed' : 'completed');

  // Clean up notification file
  try {
    const notifPath = path.join(AGENTS_DIR, agentName, '.workflow-notifications', `${runId}_${stepId}.json`);
    if (fs.existsSync(notifPath)) fs.unlinkSync(notifPath);
  } catch (e) { logger.error('misc', 'Unexpected error', e); }

  // v1.2: Auto-save agent output to file (since LLM may not call Write tool)
  const outGroup = run.group as string | undefined;
  if (outGroup && output && output.length > 50) {
    try {
      const outDir = path.join(GROUPS_DIR, outGroup, 'outputs');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const outFile = path.join(outDir, `${stepId}.md`);
      atomicWrite(outFile, `# ${stepId}\n\nAgent: ${agentName}\nAction: ${node.step.action || 'execute'}\n\n---\n\n${output}`);
      logger.info('callback', `Auto-saved output to ${outFile}`);
    } catch (e) {
      logger.warn('callback', `Failed to auto-save output: ${e}`);
    }
  }

  // Set output and transition step status
  node.output = output;
  const cbSuccess = state.circuitBreakers.get(agentName);

  if (isPlaceholder) {
    // v1.0 P1: Placeholder output → mark as FAILED, not COMPLETED
    api.transition(run, node, StepStatus.FAILED);
    const placeholderMsg = output.trim() === ''
      ? 'Agent returned empty output — no work performed'
      : `Agent returned placeholder output: "${output.trim().slice(0, 80)}" — no real work performed`;
    node.error = `[EMPTY_OUTPUT] ${placeholderMsg} -- Please retry with a real response or check agent configuration.`;
    metrics.workflowStepFailures.inc();
    state.lifecycle.onStepFailed?.(node.step, node.error);
    run.rollbacks.push({ stepId, reason: node.error, timestamp: Date.now() });
    if (cbSuccess) cbSuccess.recordFailure();
    if (state.bus) state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, stepId, workflow: run.workflowName, agent: agentName, reason: node.error, retriesExhausted: false, phase: WorkflowPhase.COMPLETED }, 'workflow-engine'));
    logger.warn('callback', `Step ${stepId} FAILED: placeholder output detected`);
  } else if (isFailed) {
    // Agent-reported failure
    api.transition(run, node, StepStatus.FAILED);
    const userErr = toUserError(output, { stepId, agent: agentName });
    node.error = `[${userErr.title}] ${userErr.message} -- ${userErr.suggestion}`;
    metrics.workflowStepFailures.inc();
    state.lifecycle.onStepFailed?.(node.step, node.error);
    run.rollbacks.push({ stepId, reason: node.error, timestamp: Date.now() });
    if (cbSuccess) cbSuccess.recordFailure();
    if (state.bus) state.bus.emit(createEvent(EventType.TASK_BLOCKED, { taskId: runId, stepId, workflow: run.workflowName, agent: agentName, reason: node.error, retriesExhausted: false, phase: WorkflowPhase.COMPLETED }, 'workflow-engine'));
    logger.warn('callback', `Step ${stepId} reported failure: ${userErr.title}`);
  } else {
    // Successful completion
    api.transition(run, node, StepStatus.COMPLETED);
    if (cbSuccess) cbSuccess.recordSuccess();
    state.lifecycle.onStepCompleted?.(node.step, output);
  }

  // Track step duration metric
  if (node.startedAt > 0) {
    metrics.workflowStepDuration.observe(Date.now() - node.startedAt);
  }

  // v1.2: Token economy — auto-reward on step completion (fire-and-forget)
  // Only reward if step actually completed (not failed or placeholder)
  if (!isPlaceholder && !isFailed && node.step.reward && node.step.reward > 0) {
    import('../token-economy').then(async ({ reward }) => {
      const isGoodQuality = output.length > 100;
      await reward(agentName, node.step.reward!, stepId, isGoodQuality ? 'bonus' : 'normal');
      logger.info('callback', `Rewarded ${agentName} with ${node.step.reward} tokens for ${stepId}`);
    }).catch(e => logger.warn('callback', `Failed to reward ${agentName}: ${e}`));
  }

  // Save checkpoint
  const grp = run.group as string | undefined;
  const checkpointStatus = isPlaceholder || isFailed ? 'failed' : 'completed';
  if (grp) saveStepCheckpoint(grp, runId, { stepId, status: checkpointStatus, output, retries: node.retryCount, timestamp: Date.now(), startedAt: node.startedAt, completedAt: Date.now(), durationMs: Date.now() - node.startedAt });

  if (state.bus && !isPlaceholder && !isFailed) {
    state.bus.emit(createEvent(EventType.TASK_COMPLETED, { taskId: runId, stepId, workflow: run.workflowName, agent: node.step.agent, action: node.step.action, output }, 'workflow-engine'));
  }

  // Push real-time status to frontend
  try {
    const wsStatus = isPlaceholder || isFailed ? 'failed' : 'completed';
    broadcastWs('wf_step_status', {
      runId, stepId, status: wsStatus,
      workflow: run.workflowName, agent: agentName,
      group: run.group || '',
      ...(node.error ? { error: node.error } : {}),
    });
  } catch (e) { logger.error('misc', 'Unexpected error', e); }

  // Read task report if exists
  const reportDir = path.join(MIND_DIR, 'agents', agentName, '.task-reports');
  const reportPath = path.join(reportDir, `${stepId}.json`);
  if (fs.existsSync(reportPath)) {
    try {
      const report: TaskReport = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
      run.taskReports.set(stepId, report);
      fs.unlinkSync(reportPath);
    } catch (e) { logger.error('misc', 'Unexpected error', e); }
  }

  // Evaluate routes
  evaluatePostStep(state, api, runId, node, nodes, output);

  // Re-schedule to pick up steps that became ready after dependency changes
  // (e.g. route evaluation clearing deps on target steps)
  api.schedule(runId);

  return true;
}

// ═══════════════════════════════════════════════════ claim ═══

/** Handle claim from agent — assign step to claiming agent and trigger */
export function claim(
  state: EngineState,
  api: EngineAPI,
  runId: string,
  stepId: string,
  agentName: string,
): boolean {
  const run = state.runs.get(runId);
  if (!run || run.status !== WorkflowStatus.RUNNING) return false;
  const nodes = state.runNodes.get(runId);
  if (!nodes) return false;
  const node = nodes.get(stepId);
  if (!node || node.status !== StepStatus.WAITING) return false;
  if (node.step.type !== 'claim') return false;

  // Check if agent is in the step's agent list
  const agents = getAgents(node.step);
  if (!agents.includes(agentName)) return false;

  // Update step agent to claiming agent
  node.step.agent = agentName;
  node.step.type = 'step'; // Convert to normal step

  logger.info('claim', `Claimed: ${stepId} ← ${agentName} (run ${runId.slice(0, 8)})`);

  // Emit claim event
  if (state.bus) {
    state.bus.emit(createEvent(EventType.TASK_ASSIGNED, {
      taskId: runId, stepId, workflow: run.workflowName,
      agent: agentName, action: node.step.action,
      prompt: node.step.prompt || '', phase: phaseForAction(node.step.action),
      claimed: true,
    }, 'workflow-engine'));
  }

  // Persist updated notification for the claiming agent
  try {
    const notifDir = path.join(AGENTS_DIR, agentName, '.workflow-notifications');
    if (!fs.existsSync(notifDir)) fs.mkdirSync(notifDir, { recursive: true });
    const notifPath = path.join(notifDir, `${runId}_${stepId}.json`);
    atomicWrite(notifPath, JSON.stringify({ runId, stepId, agent: agentName, claimed: true, prompt: node.step.prompt, createdAt: Date.now() }));
  } catch (e) {
    logger.error('claim', `Failed to write claim notification`, e);
  }

  // Add to claiming agent's task queue
  enqueueTask(agentName, {
    runId, stepId, workflow: run.workflowName,
    prompt: node.step.prompt || '',
    priority: (node.step.priority as any) || 'normal',
  });

  return true;
}

// ═══════════════════════════════════════════════════ evaluatePostStep ═══

/** Evaluate routes, review branching, and continue DAG after step completion */
export function evaluatePostStep(
  state: EngineState,
  api: EngineAPI,
  runId: string,
  node: DagNode,
  nodes: Map<string, DagNode>,
  output: string,
): void {
  const run = state.runs.get(runId);
  if (!run) return;
  const sid = node.step.id;

  // ── Lazy instantiation: instantiate downstream steps from YAML ──
  const yamlDef = run._yamlDef;
  if (yamlDef) {
    for (const depId of node.dependents) {
      if (nodes.has(depId)) continue; // already instantiated
      const depStep = yamlDef.steps.find(s => s.id === depId);
      if (!depStep) continue;
      // Instantiate the downstream step
      nodes.set(depId, {
        step: depStep, deps: depStep.dependsOn || [], dependents: [],
        status: StepStatus.PENDING, output: '', error: '',
        retryCount: 0, maxRetries: depStep.retry ?? 3,
        rejectCount: 0, maxRejectRetries: depStep.maxRejectRetries ?? 3,
        onFailure: depStep.onFailure, onReject: depStep.onReject, onApprove: depStep.onApprove,
        routes: depStep.routes, timeout: depStep.timeout || 300000, startedAt: 0, notifiedAt: 0,
      });
      // Rebuild dependent links for the new node
      for (const [oid, other] of nodes) {
        if (other.deps.includes(depId)) nodes.get(depId)!.dependents.push(oid);
      }
      node.dependents.push(depId);
      run.steps.set(depId, StepStatus.PENDING);
      logger.debug('route', `Lazy-instantiated step ${depId} (from YAML)`);
    }
  }

  // Route evaluation — pass step status for status functions
  const stepStatus = StepStatus.COMPLETED;
  if (node.routes && node.routes.length > 0) {
    const matchedRoute = node.routes.find(r => evalRouteCondition(r.when, output, stepStatus));
    if (matchedRoute && nodes.has(matchedRoute.step)) {
      logger.info('route', `${sid} routed to ${matchedRoute.step} (when: ${matchedRoute.when})`);
      for (const depId of node.dependents) {
        const dep = nodes.get(depId);
        if (dep && (dep.status === StepStatus.PENDING || dep.status === StepStatus.BLOCKED)) {
          dep.status = StepStatus.SKIPPED;
          run.steps.set(depId, StepStatus.SKIPPED);
        }
      }
      const target = nodes.get(matchedRoute.step);
      if (target) target.deps = target.deps.filter(d => d !== sid);
      return;
    }
  }

  // Auto-review injection
  if (node.step.reviewer) {
    const reviewId = `${sid}_review`;
    const reviewPrompt = node.step.reviewPrompt || `请审查以下步骤的输出。\n\n步骤: ${node.step.action} (由 ${node.step.agent} 执行)\n输出:\n${output.slice(0, 2000)}\n\n请检查是否正确、完整、符合要求。回复 APPROVED 或 REJECTED 及原因。`;
    const reviewStep: WorkflowStep = { id: reviewId, agent: node.step.reviewer, action: 'review', prompt: reviewPrompt, dependsOn: [sid], priority: 'high' };
    if (!nodes.has(reviewId)) {
      nodes.set(reviewId, { step: reviewStep, deps: [sid], dependents: [], status: StepStatus.PENDING, output: '', error: '', retryCount: 0, maxRetries: 2, rejectCount: 0, maxRejectRetries: 3, timeout: 300000, startedAt: 0, notifiedAt: 0 });
      node.dependents.push(reviewId);
      run.steps.set(reviewId, StepStatus.PENDING);
    }
  } else if (node.step.evaluate) {
    // v1.0: No reviewer — fallback to self-evaluation (heuristic, no AI call)
    const grp = run.group as string | undefined;
    api.storeSelfEvaluation(grp, run.workflowName, node.step, output);
  }

  // Re-schedule after dependency modifications (route evaluation, review injection)
  // so steps that just became ready are picked up immediately
  api.schedule(runId);

  // Review branching
  if (sid.endsWith('_review')) {
    const originalId = sid.replace(/_review$/, '');
    const originalNode = nodes.get(originalId);
    if (originalNode) {
      // v1.0: Store learning record from review output (reviewer IS the evaluator)
      if (originalNode.step.evaluate) {
        const grp = run.group as string | undefined;
        api.storeReviewEvaluation(grp, run.workflowName, node.step, output, originalNode.output || '');
      }

      if (/REJECTED/i.test(output)) {
        const onReject = originalNode.onReject || originalNode.step.onReject;
        if (onReject === 'fail') {
          originalNode.status = StepStatus.FAILED;
          const reviewErr = toUserError('review_rejected', { stepId: originalId, reason: output.slice(0, 200) });
          originalNode.error = `[${reviewErr.title}] ${reviewErr.message} -- ${reviewErr.suggestion}`;
          run.steps.set(originalId, StepStatus.FAILED);
        } else if (onReject && onReject !== 'retry' && nodes.has(onReject)) {
          const target = nodes.get(onReject)!;
          target.step = { ...target.step, prompt: `${target.step.prompt}\n\n---\n\n【审查反馈 #${originalNode.rejectCount + 1}】${originalId} 被拒绝，原因：${output.slice(0, 1000)}` };
          target.deps = target.deps.filter(d => d !== sid);
        } else if (originalNode.rejectCount < originalNode.maxRejectRetries) {
          originalNode.rejectCount++;
          api.transition(run, originalNode, StepStatus.PENDING);
          originalNode.output = '';
          // v1.1: Preserve original prompt, append numbered rejection history
          const rawPrompt = originalNode.step.prompt || '';
          const feedbackIdx = rawPrompt.lastIndexOf('\n\n---\n\n【审查反馈');
          const originalPrompt = feedbackIdx > 0 ? rawPrompt.slice(0, feedbackIdx) : rawPrompt;
          const rejectionNum = originalNode.rejectCount;
          const rejectionBlock = `\n\n---\n\n【历次审查反馈】\n${originalNode.rejectCount > 1 ? `第 1-${rejectionNum - 1} 次反馈见上文。\n` : ''}第 ${rejectionNum} 次被拒绝，原因：${output.slice(0, 1000)}\n\n请综合所有反馈，重新提交。注意不要重复犯之前的错误。`;
          originalNode.step = { ...originalNode.step, prompt: originalPrompt + rejectionBlock };
          run.steps.set(originalId, StepStatus.PENDING);
        } else {
          originalNode.status = StepStatus.FAILED;
          const maxRejErr = toUserError('review_rejected', { stepId: originalId, reason: `已重试 ${originalNode.maxRejectRetries} 次仍未通过` });
          originalNode.error = `[${maxRejErr.title}] ${maxRejErr.message} -- ${maxRejErr.suggestion}`;
          run.steps.set(originalId, StepStatus.FAILED);
        }
      } else if (/APPROVED/i.test(output)) {
        const onApprove = originalNode.onApprove || originalNode.step.onApprove;
        if (onApprove && nodes.has(onApprove)) {
          const target = nodes.get(onApprove);
          if (target) target.deps = target.deps.filter(d => d !== sid);
        }
      }
    }
  }

  // Re-schedule after review branching modified dependencies (retry, approve target)
  api.schedule(runId);
}

// ═══════════════════════════════════════════════════ Route Condition Evaluator ═══

/** v0.8: Route condition evaluator — GitHub Actions-style expressions */
export function evalRouteCondition(when: string, output: string, stepStatus?: string): boolean {
  if (!when) return false;
  const out = output.toLowerCase().trim();

  // 1. Status functions: success(), failure(), always()
  if (/^success\(\)$/i.test(when)) return stepStatus === 'completed' || stepStatus === undefined;
  if (/^failure\(\)$/i.test(when)) return stepStatus === 'failed';
  if (/^always\(\)$/i.test(when)) return true;

  // 2. NOT: !condition
  if (when.startsWith('!')) return !evalRouteCondition(when.slice(1).trim(), output, stepStatus);

  // 3. AND/OR compound conditions
  const andParts = when.split(/\s+AND\s+/i);
  if (andParts.length > 1) return andParts.every(p => evalRouteCondition(p.trim(), output, stepStatus));
  const orParts = when.split(/\s+OR\s+/i);
  if (orParts.length > 1) return orParts.some(p => evalRouteCondition(p.trim(), output, stepStatus));

  // 4. String functions: contains(), startsWith(), endsWith()
  const containsMatch = when.match(/^contains\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)$/i);
  if (containsMatch) return out.includes(containsMatch[2].toLowerCase());
  const startsMatch = when.match(/^startsWith\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)$/i);
  if (startsMatch) return out.startsWith(startsMatch[2].toLowerCase());
  const endsMatch = when.match(/^endsWith\(\s*['"](.+?)['"]\s*,\s*['"](.+?)['"]\s*\)$/i);
  if (endsMatch) return out.endsWith(endsMatch[2].toLowerCase());

  // 5. Score threshold: "score > 30", "total >= 28"
  const scoreMatch = when.match(/^(score|total)\s*([><=!]+)\s*(\d+)$/i);
  if (scoreMatch) {
    const op = scoreMatch[2];
    const threshold = parseInt(scoreMatch[3]);
    let score = 0;
    const totalMatch = output.match(/(?:total[=:]\s*)?(\d+)\s*\/\s*40/i);
    if (totalMatch) score = parseInt(totalMatch[1]);
    else {
      const numMatch = output.match(/\b(\d{1,2})\b/);
      if (numMatch) score = parseInt(numMatch[1]);
    }
    if (op === '>') return score > threshold;
    if (op === '>=') return score >= threshold;
    if (op === '<') return score < threshold;
    if (op === '<=') return score <= threshold;
    if (op === '==') return score === threshold;
    if (op === '!=') return score !== threshold;
    return false;
  }

  // 6. Regex: "regex:pattern"
  const regexMatch = when.match(/^regex:(.+)$/i);
  if (regexMatch) {
    try { return new RegExp(regexMatch[1], 'i').test(output); } catch { return false; }
  }

  // "output contains X" or just "X"
  const outputContainsMatch = when.match(/^output\s+contains\s+(.+)$/i);
  if (outputContainsMatch) return out.includes(outputContainsMatch[1].toLowerCase().trim());
  // "output == X"
  const eqMatch = when.match(/^output\s*==\s*(.+)$/i);
  if (eqMatch) return out === eqMatch[1].toLowerCase().trim();
  // "output != X"
  const neqMatch = when.match(/^output\s*!=\s*(.+)$/i);
  if (neqMatch) return out !== neqMatch[1].toLowerCase().trim();
  // Shorthand: just "APPROVED" → output contains APPROVED
  return out.includes(when.toLowerCase().trim());
}

// ═══════════════════════════════════════════════════ Learning Records & Evaluation ═══

/** Consolidated evaluation storage — handles both review and self-evaluation */
export function storeEvaluation(
  group: string | undefined,
  workflowName: string,
  stepId: string,
  step: WorkflowStep,
  evaluation: Record<string, unknown>,
  outputSnippet: string,
  reviewSnippet?: string,
): void {
  const evalDir = path.join(MIND_DIR, 'learning');
  if (!fs.existsSync(evalDir)) fs.mkdirSync(evalDir, { recursive: true });

  const record = {
    id: Date.now().toString(36),
    group,
    workflow: workflowName,
    stepId,
    action: step.action,
    agent: step.agent,
    evaluation,
    outputSnippet: outputSnippet.slice(0, 500),
    ...(reviewSnippet ? { reviewSnippet: reviewSnippet.slice(0, 500) } : {}),
    timestamp: new Date().toISOString(),
  };

  const logFile = path.join(evalDir, `learning-${group || 'global'}.jsonl`);
  fs.appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf-8');
  logger.info('eval', `evaluation ${stepId}: total=${evaluation.total}/40 verdict=${evaluation.verdict}`);
}

/** Store a learning record from review output */
export function storeReviewEvaluation(
  group: string | undefined,
  workflowName: string,
  reviewStep: WorkflowStep,
  reviewOutput: string,
  originalOutput: string,
): void {
  const isApproved = /APPROVED/i.test(reviewOutput);
  const isRejected = /REJECTED/i.test(reviewOutput);

  const feedbackText = reviewOutput
    .replace(/^(APPROVED|REJECTED)\s*[:\-]?\s*/i, '')
    .trim()
    .slice(0, 500) || 'No feedback provided';

  const hasDetail = feedbackText.length > 50;
  const baseScore = isApproved ? 8 : isRejected ? 4 : 5;
  const detailBonus = hasDetail ? 1 : 0;

  const evaluation = {
    quality: Math.min(10, baseScore + detailBonus),
    completeness: Math.min(10, baseScore + (isApproved ? 1 : 0)),
    clarity: Math.min(10, baseScore + detailBonus),
    actionability: Math.min(10, baseScore + (isApproved ? 1 : 0)),
    total: 0,
    feedback: feedbackText,
    verdict: isApproved ? 'APPROVED' : isRejected ? 'NEEDS_REVISION' : 'UNKNOWN',
    reviewer: reviewStep.agent,
  };
  evaluation.total = evaluation.quality + evaluation.completeness + evaluation.clarity + evaluation.actionability;

  const originalId = reviewStep.id?.replace(/_review$/, '') || reviewStep.id;
  storeEvaluation(group, workflowName, originalId, reviewStep, evaluation, originalOutput, reviewOutput);
}

/** Store a self-evaluation record */
export function storeSelfEvaluation(
  group: string | undefined,
  workflowName: string,
  step: WorkflowStep,
  output: string,
): void {
  const len = output.length;
  const hasStructure = /^#|^-|^\d+\./m.test(output);
  const hasDetail = len > 200;
  const hasResult = /完成|DONE|SUCCESS|APPROVED/i.test(output);

  const evaluation = {
    quality: Math.min(10, 5 + (hasDetail ? 2 : 0) + (hasResult ? 1 : 0)),
    completeness: Math.min(10, 5 + (hasDetail ? 2 : 0) + (len > 500 ? 1 : 0)),
    clarity: Math.min(10, 5 + (hasStructure ? 2 : 0)),
    actionability: Math.min(10, 5 + (hasResult ? 2 : 0)),
    total: 0,
    feedback: 'Self-evaluation (no reviewer configured)',
    verdict: hasResult ? 'APPROVED' : 'UNKNOWN',
    reviewer: 'self',
  };
  evaluation.total = evaluation.quality + evaluation.completeness + evaluation.clarity + evaluation.actionability;

  storeEvaluation(group, workflowName, step.id, step, evaluation, output);
}

/**
 * v1.1: Self-improvement — review the entire workflow execution after completion.
 * Analyzes rejections, timing, scores, and writes improvement suggestions.
 */
export function reviewWorkflowExecution(
  state: EngineState,
  group: string | undefined,
  run: WorkflowRunRecord,
  nodes: Map<string, DagNode>,
): void {
  const evalDir = path.join(MIND_DIR, 'learning');
  if (!fs.existsSync(evalDir)) fs.mkdirSync(evalDir, { recursive: true });

  const durationMs = (run.completedAt || Date.now()) - run.startedAt;
  const stepStats: Array<{
    id: string; agent: string; action: string;
    status: string; durationMs: number; retries: number; rejected: boolean;
  }> = [];

  for (const [id, node] of nodes) {
    if (node.step.type === 'trigger') continue;
    stepStats.push({
      id,
      agent: node.step.agent || 'unknown',
      action: node.step.action || 'execute',
      status: node.status,
      durationMs: node.startedAt ? Date.now() - node.startedAt : 0,
      retries: node.retryCount,
      rejected: node.rejectCount > 0,
    });
  }

  const totalSteps = stepStats.length;
  const completedSteps = stepStats.filter(s => s.status === 'completed').length;
  const failedSteps = stepStats.filter(s => s.status === 'failed').length;
  const rejectedSteps = stepStats.filter(s => s.rejected).length;
  const totalRetries = stepStats.reduce((sum, s) => sum + s.retries, 0);
  const avgDuration = totalSteps > 0 ? Math.round(stepStats.reduce((sum, s) => sum + s.durationMs, 0) / totalSteps) : 0;
  const longestStep = stepStats.sort((a, b) => b.durationMs - a.durationMs)[0];

  // Read existing learning records for trend analysis
  const existingRecords = getLearningRecords(group || 'global', 20);
  const prevAvgScore = existingRecords.length > 0
    ? existingRecords.reduce((sum: number, r: any) => sum + (r.evaluation?.total || 0), 0) / existingRecords.length
    : 0;

  // Build improvement suggestions
  const suggestions: string[] = [];
  if (rejectedSteps > 0) {
    suggestions.push(`${rejectedSteps}/${totalSteps} 个步骤被拒绝 — 考虑优化任务描述或分配给更合适的 agent`);
  }
  if (totalRetries > 0) {
    suggestions.push(`共重试 ${totalRetries} 次 — 审查标准可能过严，或任务定义不够明确`);
  }
  if (longestStep && longestStep.durationMs > avgDuration * 2) {
    suggestions.push(`步骤 "${longestStep.id}" 耗时 ${Math.round(longestStep.durationMs / 1000)}s，远超平均 ${Math.round(avgDuration / 1000)}s — 考虑拆分或并行化`);
  }
  if (failedSteps > 0) {
    suggestions.push(`${failedSteps} 个步骤失败 — 检查错误原因，可能需要人工介入`);
  }
  if (rejectedSteps === 0 && failedSteps === 0 && totalRetries === 0) {
    suggestions.push('所有步骤一次通过 — 流程顺畅，可考虑提高质量标准');
  }

  // Store workflow review record
  const reviewRecord = {
    id: Date.now().toString(36),
    type: 'workflow_review',
    group,
    workflow: run.workflowName,
    runId: run.runId,
    summary: {
      totalSteps,
      completedSteps,
      failedSteps,
      rejectedSteps,
      totalRetries,
      avgDurationMs: avgDuration,
      totalDurationMs: durationMs,
      prevAvgScore: Math.round(prevAvgScore),
    },
    stepStats: stepStats.map(s => ({
      id: s.id, agent: s.agent, action: s.action,
      status: s.status, durationMs: s.durationMs, retries: s.retries, rejected: s.rejected,
    })),
    suggestions,
    timestamp: new Date().toISOString(),
  };

  const logFile = path.join(evalDir, `workflow-reviews-${group || 'global'}.jsonl`);
  fs.appendFileSync(logFile, JSON.stringify(reviewRecord) + '\n', 'utf-8');
  logger.info('eval', `Workflow review: ${run.workflowName} — ${completedSteps}/${totalSteps} completed, ${rejectedSteps} rejected, ${suggestions.length} suggestions`);
}

// ═══════════════════════════════════════════════════ Learning Records ═══

/** Get learning records for a group — agents can query this for past outcomes */
export function getLearningRecords(group: string, limit = 20): Array<Record<string, unknown>> {
  const logFile = path.join(MIND_DIR, 'learning', `learning-${group}.jsonl`);
  if (!fs.existsSync(logFile)) return [];
  const lines = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-limit);
}

/** Get average scores for a group — quick quality overview */
export function getQualitySummary(group: string): { avgTotal: number; count: number; approved: number; needsRevision: number } {
  const records = getLearningRecords(group, 100);
  if (records.length === 0) return { avgTotal: 0, count: 0, approved: 0, needsRevision: 0 };
  const totals = records.map((r: any) => r.evaluation?.total || 0);
  const approved = records.filter((r: any) => r.evaluation?.verdict === 'APPROVED').length;
  const needsRevision = records.filter((r: any) => r.evaluation?.verdict === 'NEEDS_REVISION').length;
  return {
    avgTotal: Math.round(totals.reduce((a: number, b: number) => a + b, 0) / totals.length),
    count: records.length,
    approved,
    needsRevision,
  };
}
