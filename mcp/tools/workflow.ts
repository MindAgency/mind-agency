/**
 * MCP Server — Workflow tools
 *
 * Tools: workflow_create, workflow_trigger, workflow_status, workflow_approve, workflow_cancel
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import * as yaml from 'js-yaml';
import { groupsDir, exists, appendToChat, triggerPoll, emitBusEvent, writeAudit, httpPost, fetchJSON, fetchPost, WS_BASE_URL, PROJECT_ROOT } from './shared';

export interface ToolDef { name: string; description: string; inputSchema: any; }

export function workflowTools(): ToolDef[] {
  return [
    { name: 'workflow_callback', description: '报告工作流步骤完成结果。当 workflow 引擎通知你执行任务后，用此工具回调结果。', inputSchema: { type: 'object', properties: { runId: { type: 'string', description: '工作流运行 ID' }, stepId: { type: 'string', description: '步骤 ID' }, status: { type: 'string', description: 'APPROVED | REJECTED | COMPLETED | FAILED' }, summary: { type: 'string', description: '结果摘要' }, details: { type: 'string', description: '详细说明' } }, required: ['runId', 'stepId', 'status', 'summary'] } },
    { name: 'workflow_claim', description: '认领工作流中的认领步骤（claim type）。认领后你将成为此步骤的执行者。', inputSchema: { type: 'object', properties: { runId: { type: 'string', description: '工作流运行 ID' }, stepId: { type: 'string', description: '步骤 ID' } }, required: ['runId', 'stepId'] } },
    { name: 'workflow_create', description: '创建一个 Workflow YAML 文件到群组中。步骤可设置 reward（完成奖励）和 budget（执行预算）。', inputSchema: { type: 'object', properties: { group: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, steps: { type: 'string', description: '步骤列表（JSON 数组字符串）。每步可含: id, agent, action, prompt, reward(数字), budget(数字)' }, trigger: { type: 'string', description: '触发方式：manual/file_change/schedule/event' }, cron: { type: 'string', description: '定时触发的 cron 表达式（仅 schedule 类型）' }, reviewer: { type: 'string', description: '默认审查者 Agent（可选，每步自动审查）' }, onReject: { type: 'string', description: '审查拒绝后的行为：retry（自动重做）或 fail（直接失败）' }, maxRejectRetries: { type: 'number', description: '审查拒绝后最大重试次数（默认 3）' } }, required: ['group', 'name', 'steps'] } },
    { name: 'workflow_trigger', description: '触发群组的工作流。', inputSchema: { type: 'object', properties: { group: { type: 'string', description: '群组名称' }, triggerStepId: { type: 'string', description: '触发指定步骤（可选）' } }, required: ['group'] } },
    { name: 'workflow_status', description: '查询工作流运行状态和触发器状态。', inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: [] } },
    { name: 'workflow_approve', description: '审批工作流中的人工审批节点。', inputSchema: { type: 'object', properties: { group: { type: 'string' }, approvalId: { type: 'string' }, decision: { type: 'string' } }, required: ['group', 'approvalId', 'decision'] } },
    { name: 'workflow_cancel', description: '取消一个正在运行的工作流。', inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] } },
    { name: 'workflow_add_step', description: '向运行中的工作流动态添加步骤。', inputSchema: { type: 'object', properties: { group: { type: 'string' }, step_id: { type: 'string' }, agent: { type: 'string' }, action: { type: 'string' }, prompt: { type: 'string' }, depends_on: { type: 'string', description: '依赖的步骤ID，逗号分隔' }, reviewer: { type: 'string', description: '审查者 Agent' }, onReject: { type: 'string', description: '审查拒绝后的行为：retry 或 fail' }, maxRejectRetries: { type: 'number', description: '审查拒绝后最大重试次数' } }, required: ['group', 'step_id', 'agent', 'action', 'prompt'] } },
    { name: 'workflow_delete_step', description: '从运行中的工作流删除步骤。', inputSchema: { type: 'object', properties: { group: { type: 'string' }, step_id: { type: 'string' } }, required: ['group', 'step_id'] } },
    { name: 'workflow_modify_step', description: '修改运行中工作流的步骤属性。', inputSchema: { type: 'object', properties: { group: { type: 'string' }, step_id: { type: 'string' }, agent: { type: 'string' }, action: { type: 'string' }, prompt: { type: 'string' }, reviewer: { type: 'string' }, onReject: { type: 'string', description: '审查拒绝后的行为：retry 或 fail' } }, required: ['group', 'step_id'] } },
    { name: 'learning_query', description: '查询群组的学习记录和质量评估历史。了解过去哪些做法有效、哪些需要改进。', inputSchema: { type: 'object', properties: { group: { type: 'string', description: '群组名称' }, limit: { type: 'number', description: '返回记录数量（默认 10）' }, agent: { type: 'string', description: '按 Agent 过滤' }, workflow: { type: 'string', description: '按工作流名称过滤' } }, required: ['group'] } },
    { name: 'orchestrate', description: '自主协调团队完成目标。第一步：不带 confirm 参数，查看分解计划。第二步：确认无误后带 confirm=true 触发。', inputSchema: { type: 'object', properties: { goal: { type: 'string', description: '要完成的目标' }, group: { type: 'string', description: '群组名称' }, confirm: { type: 'boolean', description: '确认计划并触发。首次调用设为 false 或不填，查看计划后再设为 true 触发。' }, members: { type: 'string', description: '可选：指定团队成员（JSON 数组字符串）。不指定则自动从群组获取。' } }, required: ['goal', 'group'] } },
  ];
}

// ── Response helpers ──────────────────────────────────────
function respondOk(respond: (id: string, msg: any) => void, id: string, text: string): void {
  respond(id, { content: [{ type: 'text', text }] });
}

function respondError(respond: (id: string, msg: any) => void, id: string, text: string): void {
  respond(id, { content: [{ type: 'text', text }], isError: true });
}

export async function handleWorkflowTool(
  name: string, args: any, agentName: string,
  respond: (id: string, msg: any) => void, id: string
): Promise<boolean> {
  const a = args;

  if (name === 'workflow_callback') {
    const { runId, stepId, status, summary, details } = a;
    if (!runId || !stepId || !status || !summary) { respondError(respond, id, 'runId, stepId, status, summary required'); return true; }
    const output = `${status}: ${summary}${details ? '\n' + details : ''}`;
    httpPost(`${WS_BASE_URL}/workflows/callback`, { runId, stepId, output });
    emitBusEvent('task.completed', { taskId: `workflow:${runId}`, stepId, by: agentName, status });
    respondOk(respond, id, `步骤 ${stepId} 结果已报告: ${status}`);
    return true;
  }

  if (name === 'workflow_claim') {
    const { runId, stepId } = a;
    if (!runId || !stepId) { respondError(respond, id, 'runId, stepId required'); return true; }
    httpPost(`${WS_BASE_URL}/workflows/claim`, { runId, stepId, agent: agentName });
    emitBusEvent('task.claimed', { taskId: `workflow:${runId}`, stepId, by: agentName });
    respondOk(respond, id, `已认领步骤 ${stepId}`);
    return true;
  }

  if (name === 'workflow_create') {
    const { group, name: wfName, description, steps: stepsJson } = a;
    if (!group || !wfName || !stepsJson) { respondError(respond, id, `错误：缺少必填参数。需要: group="${group || '???'}", name="${wfName || '???'}", steps（JSON 数组）`); return true; }
    let steps;
    try { steps = JSON.parse(stepsJson); } catch { respondError(respond, id, 'steps must be valid JSON array'); return true; }
    if (!Array.isArray(steps) || steps.length === 0) { respondError(respond, id, '错误：steps 不能为空数组。请提供至少一个步骤，格式: [{"id":"step1","agent":"Alice","action":"review","prompt":"..."}]'); return true; }

    // Validate step ID uniqueness
    const stepIds = steps.map((s: any) => s.id).filter(Boolean);
    const dupIds = stepIds.filter((id: string, i: number) => stepIds.indexOf(id) !== i);
    if (dupIds.length > 0) {
      respondError(respond, id, `错误：存在重复的步骤 ID: ${[...new Set(dupIds)].join(', ')}。每个步骤必须有唯一的 ID。`);
      return true;
    }

    // Validate each step has required fields (trigger steps don't need agent)
    for (const step of steps) {
      if (!step.id) { respondError(respond, id, '错误：每个步骤必须有 id 字段'); return true; }
      const isTrigger = step.type === 'trigger' || step.trigger;
      if (!isTrigger && !step.agent) { respondError(respond, id, `错误：步骤 "${step.id}" 缺少 agent 字段`); return true; }
    }

    // v0.4: Validate agent existence (skip trigger steps)
    const agentsDir = path.join(PROJECT_ROOT, 'Agents');
    for (const step of steps) {
      const isTrigger = step.type === 'trigger' || step.trigger;
      if (isTrigger) continue;
      if (step.agent && step.agent !== 'unknown') {
        const agentDir = path.join(agentsDir, step.agent);
        if (!fs.existsSync(agentDir)) {
          respondOk(respond, id, `警告：Agent "${step.agent}" 不存在于 Agents/ 目录。步骤 ${step.id} 将无法执行。`);
          // Don't block creation — just warn
        }
      }
    }

    // v0.4: Add default reviewer to all steps if specified
    if (a.reviewer) {
      for (const step of steps) {
        if (!step.reviewer) step.reviewer = a.reviewer;
      }
    }

    // v0.5: Add default onReject to all steps if specified
    if (a.onReject) {
      for (const step of steps) {
        if (!step.onReject) step.onReject = a.onReject;
      }
    }
    if (a.maxRejectRetries) {
      for (const step of steps) {
        if (!step.maxRejectRetries) step.maxRejectRetries = a.maxRejectRetries;
      }
    }

    // v0.4: Build trigger config
    const triggerConfig: any = a.trigger ? { type: a.trigger } : undefined;
    if (a.trigger === 'schedule' && a.cron) {
      triggerConfig.cron = a.cron;
    }

    const wfDef: any = { name: wfName, description: description || '', steps };
    if (triggerConfig) wfDef.trigger = triggerConfig;
    const wfPath = path.join(groupsDir(), group, 'workflow.yaml');
    fs.writeFileSync(wfPath, yaml.dump(wfDef), 'utf-8');
    appendToChat(group, agentName, `创建了 workflow "${wfName}" (${steps.length} steps)`);
    triggerPoll(agentName, group);
    respondOk(respond, id, `created workflow "${wfName}" in ${group}. Use workflow_trigger to start it.`);
    return true;
  }

  if (name === 'workflow_trigger') {
    const { group } = a;
    if (!group) { respondError(respond, id, 'group required'); return true; }
    const wfPath = path.join(groupsDir(), group, 'workflow.yaml');
    if (!exists(wfPath)) { respondError(respond, id, `no workflow.yaml in ${group}`); return true; }

    // Read YAML to get workflow name
    const yamlContent = fs.readFileSync(wfPath, 'utf-8');
    const wfDef = yaml.load(yamlContent) as any;
    const workflowName = wfDef?.name || 'default';

    httpPost(`${WS_BASE_URL}/workflows/run`, { group, workflow: workflowName, triggerStepId: a.triggerStepId });
    emitBusEvent('task.created', { title: `Workflow triggered for ${group}`, agent: agentName, group });
    respondOk(respond, id, `workflow triggered for group "${group}"`);

    return true;
  }

  if (name === 'workflow_status') {
    const { group } = a;
    try {
      const statsRaw = await fetchJSON(`${WS_BASE_URL}/workflows/stats`);
      const stats = statsRaw as any;
      let statsText = stats
        ? `Workflows: ${stats.totalRuns} total, ${stats.activeRuns} active, ${stats.completedRuns} completed, ${stats.failedRuns} failed`
        : 'No workflow stats available';
      if (group) {
        const runs = (stats?.runs || []).filter((r: any) => r.group === group);
        statsText += `\n\n${group}: ${runs.length} run(s)`;
        for (const r of runs) statsText += `\n  - ${r.workflowName} (${r.runId.slice(0, 8)}): ${r.status}`;
      }
      respondOk(respond, id, statsText);
    } catch { respondError(respond, id, 'workflow stats unavailable'); }
    return true;
  }

  if (name === 'workflow_approve') {
    const { group, approvalId, decision } = a;
    if (!group || !approvalId || !decision) { respondError(respond, id, 'group, approvalId, decision required'); return true; }
    httpPost(`${WS_BASE_URL}/workflows/approve`, { approvalId, decision });
    emitBusEvent('task.completed', { taskId: `workflow:${group}`, by: agentName, decision, approvalId });
    respondOk(respond, id, `approval ${decision} submitted for ${approvalId}`);
    return true;
  }

  if (name === 'workflow_cancel') {
    const { group } = a;
    if (!group) { respondError(respond, id, 'group required'); return true; }
    try {
      const runsRaw = await fetchJSON(`${WS_BASE_URL}/workflows/stats`);
      const runs = (runsRaw as any)?.runs || [];
      const activeRun = runs.find((r: any) => r.group === group && r.status === 'running');
      if (!activeRun) { respondOk(respond, id, `no active workflow in ${group}`); return true; }
      httpPost(`${WS_BASE_URL}/workflows/cancel`, { runId: activeRun.runId });
      respondOk(respond, id, `workflow cancelled for ${group}`);
    } catch { respondError(respond, id, 'failed to cancel workflow'); }
    return true;
  }

  if (name === 'workflow_add_step') {
    const { group, step_id, agent, action, prompt, depends_on, reviewer, onReject, maxRejectRetries } = a;
    if (!group || !step_id || !agent || !action || !prompt) {
      respondError(respond, id, 'group, step_id, agent, action, prompt required'); return true;
    }
    // Write to YAML blueprint
    const yaml = require('js-yaml');
    const wfPath = path.join(PROJECT_ROOT, 'Groups', group, 'workflow.yaml');
    if (!fs.existsSync(wfPath)) { respondError(respond, id, `workflow.yaml not found in ${group}`); return true; }
    const def = yaml.load(fs.readFileSync(wfPath, 'utf-8'));
    const newStep: any = { id: step_id, agent, action, prompt };
    if (depends_on) newStep.dependsOn = depends_on.split(',').map((s: string) => s.trim());
    if (reviewer) newStep.reviewer = reviewer;
    if (onReject) newStep.onReject = onReject;
    if (maxRejectRetries) newStep.maxRejectRetries = maxRejectRetries;
    def.steps.push(newStep);
    fs.writeFileSync(wfPath, yaml.dump(def, { lineWidth: -1 }), 'utf-8');
    respondOk(respond, id, `step ${step_id} added to ${group} workflow (blueprint updated)`);
    return true;
  }

  if (name === 'workflow_delete_step') {
    const { group, step_id } = a;
    if (!group || !step_id) { respondError(respond, id, 'group and step_id required'); return true; }
    const yaml = require('js-yaml');
    const wfPath = path.join(PROJECT_ROOT, 'Groups', group, 'workflow.yaml');
    if (!fs.existsSync(wfPath)) { respondError(respond, id, `workflow.yaml not found in ${group}`); return true; }
    const def = yaml.load(fs.readFileSync(wfPath, 'utf-8'));
    const before = def.steps.length;
    def.steps = def.steps.filter((s: any) => s.id !== step_id);
    if (def.steps.length === before) { respondError(respond, id, `step ${step_id} not found`); return true; }
    fs.writeFileSync(wfPath, yaml.dump(def, { lineWidth: -1 }), 'utf-8');
    respondOk(respond, id, `step ${step_id} deleted from ${group} workflow (blueprint updated)`);
    return true;
  }

  if (name === 'workflow_modify_step') {
    const { group, step_id, agent, action, prompt, reviewer, onReject } = a;
    if (!group || !step_id) { respondError(respond, id, 'group and step_id required'); return true; }
    const yaml = require('js-yaml');
    const wfPath = path.join(PROJECT_ROOT, 'Groups', group, 'workflow.yaml');
    if (!fs.existsSync(wfPath)) { respondError(respond, id, `workflow.yaml not found in ${group}`); return true; }
    const def = yaml.load(fs.readFileSync(wfPath, 'utf-8'));
    const step = def.steps.find((s: any) => s.id === step_id);
    if (!step) { respondError(respond, id, `step ${step_id} not found`); return true; }
    if (agent) step.agent = agent;
    if (action) step.action = action;
    if (prompt) step.prompt = prompt;
    if (reviewer) step.reviewer = reviewer;
    if (onReject) step.onReject = onReject;
    fs.writeFileSync(wfPath, yaml.dump(def, { lineWidth: -1 }), 'utf-8');
    respondOk(respond, id, `step ${step_id} modified in ${group} workflow (blueprint updated)`);
    return true;
  }

  if (name === 'learning_query') {
    const { group, limit, agent, workflow } = a;
    if (!group) { respondError(respond, id, 'group required'); return true; }
    try {
      const params = new URLSearchParams({ group });
      if (limit) params.set('limit', String(limit));
      if (agent) params.set('agent', agent);
      if (workflow) params.set('workflow', workflow);
      const data: any = await fetchJSON(`${WS_BASE_URL}/api/learning?${params}`);
      const records = data.records || [];
      const summary = data.summary || {};
      const feedback = data.commonFeedback || [];
      let text = `📚 学习记录 (${group})\n`;
      text += `总记录: ${summary.count || 0} | 平均分: ${summary.avgTotal || 0}/40 | 通过率: ${summary.approvalRate || 0}%\n`;
      if (feedback.length > 0) {
        text += `\n最近反馈:\n`;
        for (const f of feedback.slice(-3)) {
          text += `  • ${f}\n`;
        }
      }
      if (records.length > 0) {
        text += `\n最近记录:\n`;
        for (const r of records.slice(-5)) {
          const ev = r.evaluation || {};
          text += `  [${r.stepId}] ${r.action} → ${ev.verdict || '?'} (${ev.total || 0}/40)\n`;
        }
      }
      respondOk(respond, id, text);
    } catch (e: any) {
      respondError(respond, id, `查询失败: ${e.message}`);
    }
    return true;
  }

  if (name === 'orchestrate') {
    const { goal, group, confirm, members } = a;
    if (!goal || !group) { respondError(respond, id, 'goal and group required'); return true; }
    try {
      const apiBase = process.env.MIND_API_URL || 'http://127.0.0.1:3000';
      const data = await fetchPost(`${apiBase}/api/orchestrate`, {
        goal, group, coordinator: agentName, confirm: !!confirm,
        members: members ? JSON.parse(members) : undefined,
      });

      if (data.error) {
        respondError(respond, id, `❌ 编排失败: ${data.error}\n${data.suggestion || ''}`);
      } else if (!data.triggered) {
        // Show plan for user review
        let text = `📋 工作流计划 — 请审核\n`;
        text += `🎯 目标: ${data.description}\n`;
        text += `📊 ${data.steps.length} 个步骤:\n`;
        for (const s of data.steps) {
          text += `  ${s.id}: ${s.agent} (${s.action})${s.reviewer ? ` → 审查: ${s.reviewer}` : ''}\n`;
          text += `    任务: ${s.prompt}\n`;
          if (s.dependsOn?.length) text += `    依赖: ${s.dependsOn.join(', ')}\n`;
        }
        text += `\n✅ 确认无误后，调用 orchestrate(goal="${goal.slice(0, 30)}...", group="${group}", confirm=true) 触发`;
        respondOk(respond, id, text);
      } else {
        let text = `🎯 工作流已触发: ${data.workflowName}\n`;
        text += `📝 ${data.description}\n`;
        text += `📊 ${data.steps.length} 个步骤:\n`;
        for (const s of data.steps) {
          text += `  ${s.id}: ${s.agent} (${s.action})${s.dependsOn?.length ? ` ← [${s.dependsOn.join(', ')}]` : ''}\n`;
        }
        respondOk(respond, id, text);
      }
    } catch (e: any) {
      respondError(respond, id, `❌ 编排失败: ${e.message}`);
    }
    return true;
  }

  return false;
}
