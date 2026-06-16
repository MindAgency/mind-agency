/**
 * Learning Records API — workflow step evaluation history
 *
 * GET    /api/learning?group=<name>&limit=N  → get learning records for a group
 * POST   /api/learning                       → manually add a learning record
 *
 * Returns evaluation scores, verdicts, and feedback for completed workflow steps.
 * Supports filtering by agent and workflow name.
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

export const GET = safeHandler(async (request: NextRequest) => {
  const { getLearningProxy } = await import('@/lib/learning-proxy');
  const { searchParams } = new URL(request.url);
  const group = searchParams.get('group');
  const limit = parseInt(searchParams.get('limit') || '20');
  const agent = searchParams.get('agent');
  const workflow = searchParams.get('workflow');

  const learningProxy = getLearningProxy();

  if (!group) {
    // List all groups with learning records
    const allRecords = await learningProxy.getAllRecords();
    const groups = [...new Set(allRecords.map(r => r.group).filter(Boolean))];
    return NextResponse.json({ groups });
  }

  let records = await learningProxy.getGroupRecords(group);

  // Filter by agent if specified
  if (agent) {
    records = records.filter(r => r.agent === agent);
  }
  // Filter by workflow if specified
  if (workflow) {
    records = records.filter(r => r.workflow === workflow);
  }

  records = records.slice(-limit);

  // Compute summary
  const totals = records.map(r => r.evaluation?.score || 0);
  const approved = records.filter(r => r.evaluation?.verdict === 'APPROVED').length;
  const needsRevision = records.filter(r => r.evaluation?.verdict === 'NEEDS_REVISION').length;
  const summary = {
    avgTotal: totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
    count: records.length,
    approved,
    needsRevision,
    approvalRate: records.length > 0 ? Math.round(approved / records.length * 100) : 0,
  };

  // Extract common feedback themes
  const feedbacks = records
    .map(r => r.evaluation?.feedback)
    .filter(Boolean);
  const commonFeedback = feedbacks.slice(-5); // Last 5 feedback items

  return NextResponse.json({ records, summary, commonFeedback });
});

// POST /api/learning — manually add a learning record
export const POST = safeHandler(async (request: NextRequest) => {
  const body = await request.json();
  const { group, workflow, stepId, action, agent, evaluation, outputSnippet } = body;

  if (!group || !evaluation) {
    return NextResponse.json({ error: 'group and evaluation required' }, { status: 400 });
  }

  const { getLearningProxy } = await import('@/lib/learning-proxy');
  const learningProxy = getLearningProxy();

  const record = {
    timestamp: Date.now(),
    group,
    workflow: workflow || 'manual',
    stepId: stepId || 'manual',
    action: action || 'evaluate',
    agent: agent || 'user',
    evaluation,
  };

  await learningProxy.addRecord(group, record);

  return NextResponse.json({ success: true, record });
});
