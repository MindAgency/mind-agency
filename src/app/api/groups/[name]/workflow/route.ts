/**
 * Workflow API
 *
 * GET    /api/groups/{name}/workflow           → read workflow YAML + runs
 * POST   /api/groups/{name}/workflow           → trigger | approve | reject
 * PUT    /api/groups/{name}/workflow           → update YAML
 * DELETE /api/groups/{name}/workflow           → delete YAML
 */

import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import * as yamlLib from 'js-yaml';
import { getAgency } from '@/lib/agency';
import { parseWorkflowYaml } from '@/lib/event-bus';
import { GROUPS_DIR } from '@/lib/data-dir';
import { triggerWorkflow, approveWorkflow, getRuns, getPendingApprovals } from '@/lib/workflow-bridge';
import { loadRunHistory, loadRunCheckpoints } from '@/lib/workflow-checkpoint';

// Timeout for workflow API operations
const WORKFLOW_TIMEOUT = 15_000;

// ── GET — read workflow definition + runs ──────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { searchParams } = new URL(request.url);

  // ?action=runs — get workflow execution status
  if (searchParams.get('action') === 'runs') {
    try {
      const runs = getRuns().filter(r => r.group === name);
      const approvals = getPendingApprovals(name);
      return NextResponse.json({ runs, pendingApprovals: approvals });
    } catch (err: any) {
      console.error(`[workflow] GET runs error for ${name}:`, err.message);
      return NextResponse.json({ runs: [], pendingApprovals: [], error: err.message });
    }
  }

  // ?action=history — get completed workflow run history (v0.4)
  if (searchParams.get('action') === 'history') {
    const limit = Math.max(1, Math.min(200, parseInt(searchParams.get('limit') || '50', 10) || 50));
    const history = loadRunHistory(name, limit);
    return NextResponse.json({ history });
  }

  // ?action=step&runId=X&stepId=Y — get individual step details including output
  if (searchParams.get('action') === 'step') {
    const runId = searchParams.get('runId');
    const stepId = searchParams.get('stepId');
    if (!runId || !stepId) {
      return NextResponse.json({ error: 'runId and stepId are required' }, { status: 400 });
    }

    try {
      // Try checkpoint data first (persisted to disk)
      const cps = loadRunCheckpoints(name, runId);
      const checkpoint = cps.find(cp => cp.stepId === stepId);

      // Try in-memory engine for live data (with timeout)
      const importPromise = import('@/lib/workflow-bridge');
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Engine import timeout')), 5_000);
      });
      const { getEngine } = await Promise.race([importPromise, timeoutPromise]);
      const engine = getEngine();
      const run = engine.getRun(runId);

      let stepStatus = checkpoint?.status || 'unknown';
      let stepOutput = checkpoint?.output || '';
      let stepError = checkpoint?.error || '';
      let stepStartedAt = checkpoint?.startedAt || 0;
      let stepCompletedAt = checkpoint?.completedAt || 0;
      let stepDurationMs = checkpoint?.durationMs || 0;
      let stepRetries = checkpoint?.retries || 0;

      // Override with live data if available (more up-to-date)
      if (run) {
        const liveStatus = run.steps.get(stepId);
        if (liveStatus) stepStatus = liveStatus;
        // Try to get output from DAG nodes via runNodes
        const nodes = (engine as any).state?.runNodes?.get(runId);
        if (nodes) {
          const node = nodes.get(stepId);
          if (node) {
            if (node.output) stepOutput = node.output;
            if (node.error) stepError = node.error;
            if (node.startedAt) stepStartedAt = node.startedAt;
            if (node.retryCount) stepRetries = node.retryCount;
          }
        }
        // Try task reports
        const report = run.taskReports.get(stepId);
        if (report) {
          stepStatus = report.status || stepStatus;
          if (report.summary) stepOutput = `${report.summary}${report.details ? '\n' + report.details : ''}`;
        }
      }

      // Also try to read auto-saved output file
      if (!stepOutput) {
        try {
          const outPath = path.join(GROUPS_DIR, name, 'outputs', `${stepId}.md`);
          if (fs.existsSync(outPath)) {
            stepOutput = fs.readFileSync(outPath, 'utf-8');
          }
        } catch { /* no saved output */ }
      }

      return NextResponse.json({
        runId, stepId, group: name,
        status: stepStatus,
        output: stepOutput,
        error: stepError,
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
        durationMs: stepDurationMs || (stepStartedAt && stepCompletedAt ? stepCompletedAt - stepStartedAt : 0),
        retries: stepRetries,
      });
    } catch (err: any) {
      console.error(`[workflow] GET step error for ${name}/${runId}/${stepId}:`, err.message);
      return NextResponse.json({
        runId, stepId, group: name,
        status: 'unknown', output: '', error: err.message,
        startedAt: 0, completedAt: 0, durationMs: 0, retries: 0,
      });
    }
  }

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  }

  const raw = await proxy.getWorkflow();
  if (!raw) {
    return NextResponse.json({ name: '', steps: 0, yaml: '' });
  }

  try {
    const def = parseWorkflowYaml(raw);
    const runs = getRuns().filter(r => r.group === name);

    // v0.4: Load checkpoint data for the latest run
    const latestRun = runs[0];
    let checkpoints: Record<string, any> = {};
    if (latestRun) {
      const cps = loadRunCheckpoints(name, latestRun.runId);
      for (const cp of cps) { checkpoints[cp.stepId] = cp; }
    }

    return NextResponse.json({
      name: def.name,
      description: def.description,
      steps: def.steps.length,
      stepsList: def.steps.map(s => ({
        id: s.id, type: s.type, agent: s.agent, action: s.action,
        prompt: s.prompt, priority: s.priority, condition: s.condition,
        dependsOn: s.dependsOn || [], routes: s.routes,
        reviewer: s.reviewer, trigger: s.trigger,
        checkpoint: checkpoints[s.id] || null,
      })),
      yaml: raw,
      runs,
      pendingApprovals: getPendingApprovals(name),
    });
  } catch {
    return NextResponse.json({ name: '', steps: 0, yaml: raw, error: 'parse error' });
  }
}

// ── POST — trigger workflow ─────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  let body: any;
  try { body = await request.json(); } catch { body = {}; }

  // Validate
  if (body.runId && body.stepId && body.claim) {
    // Claim step
    const { getEngine } = await import('@/lib/workflow-bridge');
    const engine = getEngine();
    const agent = body.agent || 'unknown';
    if (!agent || agent === 'unknown') {
      return NextResponse.json({ error: { code: 'VALIDATION_ERROR', message: 'agent is required for claim' } }, { status: 422 });
    }
    const ok = engine.claim(body.runId, body.stepId, agent);
    if (!ok) return NextResponse.json({ error: { code: 'CLAIM_FAILED', message: 'claim failed (run not found, step not waiting, or agent not in step)' } }, { status: 400 });
    return NextResponse.json({ ok: true, runId: body.runId, stepId: body.stepId, agent });
  }

  if (body.runId && body.stepId) {
    // Callback — agent reports step completion
    const { getEngine } = await import('@/lib/workflow-bridge');
    const engine = getEngine();
    const output = `${(body.status || 'COMPLETED').toUpperCase()}: ${body.summary || ''}${body.details ? '\n' + body.details : ''}`;
    const ok = engine.callback(body.runId, body.stepId, output);
    if (!ok) return NextResponse.json({ error: { code: 'CALLBACK_FAILED', message: 'run not found or step not waiting' } }, { status: 400 });
    return NextResponse.json({ ok: true, runId: body.runId, stepId: body.stepId, status: body.status });
  }

  if (body.approvalId && body.decision) {
    // Approval
    const decision = body.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    const result = approveWorkflow(body.approvalId, decision, body.comment);
    if (!result.ok) return NextResponse.json({ error: { code: 'APPROVAL_FAILED', message: result.error } }, { status: 404 });
    return NextResponse.json({ ok: true, approvalId: body.approvalId, decision });
  }

  // Trigger workflow
  const result = await triggerWorkflow(name, body.triggerStepId);
  if ('error' in result) {
    return NextResponse.json({ error: { code: 'TRIGGER_FAILED', message: result.error } }, { status: 400 });
  }
  return NextResponse.json({ ok: true, runId: result.runId, group: name });
}

// ── PUT — update YAML ──────────────────────────────────────

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  let body: any;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  return handleUpdate(name, body);
}

// ── DELETE ─────────────────────────────────────────────────

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  }

  // Clear workflow by saving empty yaml
  await proxy.saveWorkflow('');

  return NextResponse.json({ success: true });
}

// ── Helpers ────────────────────────────────────────────────

async function handleUpdate(group: string, body: any) {
  const agency = getAgency();
  const proxy = agency.getGroup(group);

  if (!proxy.exists()) {
    return NextResponse.json({ error: 'Group not found' }, { status: 404 });
  }

  let yaml = '';
  if (typeof body.yaml === 'string' && body.yaml.trim()) {
    yaml = body.yaml;
    try { parseWorkflowYaml(yaml); } catch {
      return NextResponse.json({ error: 'Invalid YAML: cannot parse workflow' }, { status: 400 });
    }
  } else if (Array.isArray(body.steps)) {
    // Read existing workflow name if not provided
    let wfName = body.name || '';
    if (!wfName) {
      const existingYaml = await proxy.getWorkflow();
      if (existingYaml) {
        try {
          const existing = parseWorkflowYaml(existingYaml);
          wfName = existing.name || group;
        } catch { wfName = group; }
      } else {
        wfName = group;
      }
    }
    // Build structured object, then serialize with yaml.dump (safe, no injection)
    const wfObj: any = { name: wfName, steps: [] };
    if (body.description) wfObj.description = body.description;
    for (const s of body.steps) {
      const step: any = { id: s.id || s.agent || `step_${wfObj.steps.length}`, agent: s.agent || 'unknown', action: s.action || 'execute' };
      if (s.dependsOn) step.dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn : [s.dependsOn];
      if (s.condition) step.condition = s.condition;
      if (s.prompt) step.prompt = s.prompt;
      if (s.priority) step.priority = s.priority;
      if (s.retry) step.retry = s.retry;
      // timeout: positive integer in milliseconds (default 300000 = 5 min)
      if (typeof s.timeout === 'number') {
        if (!Number.isFinite(s.timeout) || s.timeout <= 0) {
          return NextResponse.json(
            { error: { code: 'VALIDATION_ERROR', message: 'timeout must be a positive number in milliseconds (e.g., 300000 = 5 minutes)' } },
            { status: 400 }
          );
        }
        step.timeout = Math.floor(s.timeout);
      }
      if (s.reviewer) step.reviewer = s.reviewer;
      if (s.routes) step.routes = s.routes;
      wfObj.steps.push(step);
    }
    yaml = yamlLib.dump(wfObj, { lineWidth: -1, noRefs: true, quotingType: '"' });
  } else {
    return NextResponse.json({ error: 'Provide yaml string or {name, steps[]}' }, { status: 400 });
  }

  await proxy.saveWorkflow(yaml);
  return NextResponse.json({ success: true, group });
}
