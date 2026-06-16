import { NextRequest, NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

/**
 * POST /api/orchestrate
 *
 * Lets a coordinator agent decompose a goal into tasks, create a workflow,
 * and trigger it — enabling autonomous team coordination.
 *
 * Body: { goal: string, group: string, coordinator: string, members?: string[], confirm?: boolean }
 *
 * Flow:
 * 1. AI decomposes goal into workflow steps
 * 2. If confirm=false (default): return plan for user review, don't trigger
 * 3. If confirm=true: write YAML, trigger workflow
 */
export const POST = safeHandler(async (request: NextRequest) => {
  const fs = await import('fs');
  const path = await import('path');
  const { MIND_DIR, GROUPS_DIR } = await import('@/lib/data-dir');
  const { getAgency } = await import('@/lib/agency');

  const body = await request.json();
  const { goal, group, coordinator, members, confirm } = body;

  if (!goal || !group || !coordinator) {
    return NextResponse.json({ error: 'goal, group, and coordinator required' }, { status: 400 });
  }

  const agency = getAgency();
  const groupProxy = agency.getGroup(group);

  if (!groupProxy.exists()) {
    return NextResponse.json({ error: `Group "${group}" not found` }, { status: 404 });
  }

  // Get group members if not provided
  let teamMembers = members || [];
  if (teamMembers.length === 0) {
    await groupProxy.loadMembers();
    teamMembers = groupProxy.members
      .map(m => m.name)
      .filter(name => name.toLowerCase() !== coordinator.toLowerCase());
  }

  if (teamMembers.length === 0) {
    return NextResponse.json({
      error: `No team members found in group "${group}". Invite agents first.`,
      suggestion: `Use group_invite to add members, then retry.`
    }, { status: 400 });
  }

  // Use AI to decompose the goal into workflow steps
  const { chatOnce } = await import('@/lib/chat');

  const decomposePrompt = `你是一个项目管理专家。请将以下目标分解为具体的工作流步骤。

目标: ${goal}

可用团队成员: ${teamMembers.join(', ')}
协调者: ${coordinator}

请根据每个成员的能力分配任务。每个任务需要:
- id: 步骤ID (英文, 如 step1, step2)
- agent: 执行者
- action: 动作类型 (create/review/verify/fix/deploy)
- prompt: 具体任务描述 (中文, 详细明确)
- dependsOn: 依赖的步骤ID数组 (哪些步骤必须先完成)

规则:
1. 至少有一个创作步骤 (create)
2. 至少有一个审查步骤 (review), 审查者不能是创作者
3. 审查通过后才能发布
4. 步骤之间有合理的依赖关系
5. 每个步骤的 prompt 要足够详细，让 agent 知道具体做什么

请用以下 JSON 格式回复（不要加 markdown 代码块标记）:
{
  "name": "工作流名称",
  "description": "简短描述",
  "steps": [
    {
      "id": "step1",
      "agent": "成员名",
      "action": "create",
      "prompt": "详细任务描述",
      "dependsOn": [],
      "evaluate": true
    }
  ]
}`;

  const { reply } = await chatOnce(coordinator, decomposePrompt, group, { noMcp: true });

  // Parse the decomposition
  let decomposition;
  try {
    const jsonMatch = reply.match(/\{[\s\S]*\}/);
    if (jsonMatch) decomposition = JSON.parse(jsonMatch[0]);
  } catch (e) { console.error('[app:api:orchestrate:route]', e); }

  if (!decomposition || !decomposition.steps || decomposition.steps.length === 0) {
    return NextResponse.json({
      error: 'Failed to decompose goal into tasks',
      rawReply: reply.slice(0, 500),
    }, { status: 422 });
  }

  // Add default reviewer if not specified
  const steps = decomposition.steps;
  const creators = steps.filter((s: any) => s.action === 'create').map((s: any) => s.agent);
  for (const step of steps) {
    if (step.action === 'review' && !step.reviewer) {
      step.reviewer = step.agent;
    }
    // Auto-assign reviewer for create steps: pick a different team member
    if (step.action === 'create' && !step.reviewer) {
      const otherMember = teamMembers.find((m: string) => m !== step.agent);
      if (otherMember) step.reviewer = otherMember;
    }
  }

  // Create workflow YAML
  const workflowName = decomposition.name || `orchestrated-${Date.now().toString(36)}`;
  const workflowDesc = decomposition.description || goal;

  const yamlSteps = steps.map((s: any) => {
    const lines: string[] = [];
    lines.push(`  - id: ${s.id}`);
    lines.push(`    agent: ${s.agent}`);
    lines.push(`    action: ${s.action || 'execute'}`);
    lines.push(`    prompt: "${(s.prompt || '').replace(/"/g, '\\"')}"`);
    if (s.dependsOn && s.dependsOn.length > 0) {
      lines.push(`    dependsOn: [${s.dependsOn.join(', ')}]`);
    }
    if (s.reviewer) lines.push(`    reviewer: ${s.reviewer}`);
    if (s.onReject) lines.push(`    onReject: ${s.onReject}`);
    if (s.evaluate) lines.push(`    evaluate: true`);
    return lines.join('\n');
  }).join('\n');

  const yaml = `name: ${workflowName}
description: ${workflowDesc}
steps:
${yamlSteps}
`;

  // Write workflow file to group
  const wfDir = path.join(GROUPS_DIR, group, 'workflows');
  if (!fs.existsSync(wfDir)) fs.mkdirSync(wfDir, { recursive: true });
  const wfPath = path.join(wfDir, `${workflowName}.yaml`);
  fs.writeFileSync(wfPath, yaml, 'utf-8');

  // v1.2: Only trigger if confirm=true — otherwise return plan for user review
  let triggered = false;
  if (confirm) {
    const { default: http } = await import('http');
    await new Promise<void>((resolve, reject) => {
      const postData = JSON.stringify({ name: workflowName, description: workflowDesc, steps, group });
      const req = http.request({
        hostname: '127.0.0.1',
        port: 3001,
        path: '/workflows/run',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try { const r = JSON.parse(data); console.log(`[orchestrate] Trigger result:`, r); } catch (e) { console.error('[app:api:orchestrate:route]', e); }
          resolve();
        });
      });
      req.on('error', (e) => {
        console.log(`[orchestrate] Trigger failed: ${e.message}`);
        resolve();
      });
      req.write(postData);
      req.end();
    });
    triggered = true;
  }

  // Log orchestration
  const auditDir = path.join(MIND_DIR, 'audit');
  if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
  const auditEntry = {
    type: 'orchestration',
    coordinator,
    group,
    goal,
    workflowName,
    stepsCount: steps.length,
    members: teamMembers,
    timestamp: new Date().toISOString(),
  };
  fs.appendFileSync(path.join(auditDir, 'orchestration.jsonl'), JSON.stringify(auditEntry) + '\n');

  return NextResponse.json({
    success: true,
    workflowName,
    description: workflowDesc,
    steps: steps.map((s: any) => ({
      id: s.id,
      agent: s.agent,
      action: s.action,
      prompt: (s.prompt || '').slice(0, 200),
      dependsOn: s.dependsOn || [],
      reviewer: s.reviewer,
    })),
    triggered,
    message: triggered
      ? `工作流已触发，${steps.length} 个步骤`
      : `计划已生成，请审核后调用 orchestrate(confirm=true) 触发`,
    yaml,
  });
});

// GET /api/orchestrate — list orchestration history
export const GET = safeHandler(async () => {
  const fs = await import('fs');
  const path = await import('path');
  const { MIND_DIR } = await import('@/lib/data-dir');

  const auditFile = path.join(MIND_DIR, 'audit', 'orchestration.jsonl');
  if (!fs.existsSync(auditFile)) {
    return NextResponse.json({ history: [] });
  }
  const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean);
  const history = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-20);
  return NextResponse.json({ history });
});
