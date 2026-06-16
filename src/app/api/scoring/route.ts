/**
 * Scoring API — content quality evaluation
 *
 * POST /api/scoring          → evaluate content quality (AI reviewer or heuristic)
 * GET  /api/scoring          → view scoring history or group learning records
 *
 * Evaluates content across four dimensions: quality, completeness, clarity,
 * and actionability. Uses a specified reviewer agent or falls back to
 * heuristic evaluation (fast, no AI call).
 */

import { NextRequest, NextResponse } from 'next/server';
import { safeHandler } from '@/lib/api-handler';

/** Heuristic evaluation — fast, free, no AI call */
function heuristicEvaluate(content: string, type: string) {
  const len = content.length;
  const hasTitle = /^#/.test(content);
  const hasList = /^[-*]\s/m.test(content) || /^\d+\.\s/m.test(content);
  const paragraphCount = content.split(/\n\n/).length;
  const hasDialogue = /["「」]/.test(content);

  const quality = Math.min(10, Math.max(5, Math.floor(len / 200) + (hasTitle ? 2 : 0) + (paragraphCount > 3 ? 1 : 0)));
  const completeness = Math.min(10, Math.max(5, Math.floor(len / 150) + (hasList ? 2 : 0) + 3));
  const clarity = Math.min(10, Math.max(5, (hasTitle ? 3 : 0) + (paragraphCount > 2 ? 2 : 0) + 3));
  const actionability = Math.min(10, Math.max(5, Math.floor(len / 200) + (hasDialogue ? 1 : 0) + 3));
  const total = quality + completeness + clarity + actionability;

  return {
    scores: { quality, completeness, clarity, actionability },
    total,
    percentage: Math.round(total / 40 * 100),
    feedback: `启发式评估 (${type}): 长度=${len}, 标题=${hasTitle}, 列表=${hasList}, 段落=${paragraphCount}`,
    verdict: total >= 32 ? 'APPROVED' : total >= 24 ? 'NEEDS_REVISION' : 'POOR',
  };
}

// POST /api/scoring/evaluate — evaluate content quality
// Uses reviewer's evaluation if provided, otherwise heuristic
export const POST = safeHandler(async (request: NextRequest) => {
  const body = await request.json();
  const { content, type, reviewer, group } = body;

  if (!content || !type) {
    return NextResponse.json({ error: 'content and type required' }, { status: 400 });
  }

  let result;

  if (reviewer && reviewer !== 'system') {
    // Use specified reviewer agent for evaluation
    const { chatOnce } = await import('@/lib/chat');
    const evalPrompt = `你是一个严格的质量评审员。请评估以下内容的质量。

内容类型: ${type}

内容:
${content.slice(0, 5000)}

请从以下维度评分 (每项1-10分):
1. quality — 内容质量
2. completeness — 完整性
3. clarity — 表达清晰度
4. actionability — 可执行性

请用 JSON 格式回复（不要加代码块标记）:
{"quality": N, "completeness": N, "clarity": N, "actionability": N, "feedback": "改进建议", "verdict": "APPROVED 或 NEEDS_REVISION"}`;

    try {
      const { reply } = await chatOnce(reviewer, evalPrompt, undefined, { noMcp: true });
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const eval_ = JSON.parse(jsonMatch[0]);
        const total = (eval_.quality || 5) + (eval_.completeness || 5) + (eval_.clarity || 5) + (eval_.actionability || 5);
        result = {
          scores: { quality: eval_.quality || 5, completeness: eval_.completeness || 5, clarity: eval_.clarity || 5, actionability: eval_.actionability || 5 },
          total,
          percentage: Math.round(total / 40 * 100),
          feedback: eval_.feedback || '',
          verdict: eval_.verdict || (total >= 32 ? 'APPROVED' : 'NEEDS_REVISION'),
        };
      }
    } catch (e: any) {
      console.log(`[scoring] Reviewer ${reviewer} failed: ${e.message}, falling back to heuristic`);
    }
  }

  // Fallback to heuristic if no reviewer or reviewer failed
  if (!result) {
    result = heuristicEvaluate(content, type);
  }

  const { getScoringProxy } = await import('@/lib/scoring-proxy');
  const scoringProxy = getScoringProxy();

  // Store scoring record
  await scoringProxy.addRecord({
    timestamp: Date.now(),
    agent: reviewer || 'heuristic',
    group: group || 'default',
    score: result.total,
    maxScore: 40,
    reason: result.feedback,
  });

  // Also store in learning records if group is provided
  if (group) {
    const { getLearningProxy } = await import('@/lib/learning-proxy');
    const learningProxy = getLearningProxy();
    await learningProxy.addRecord(group, {
      timestamp: Date.now(),
      agent: reviewer || 'heuristic',
      group,
      workflow: type,
      stepId: 'direct-eval',
      action: type,
      evaluation: {
        verdict: result.verdict as 'APPROVED' | 'NEEDS_REVISION' | 'REJECTED',
        feedback: result.feedback,
        score: result.total,
      },
    });
  }

  return NextResponse.json({ success: true, ...result });
});

// GET /api/scoring/history — view scoring history
// GET /api/scoring/history?group=<name> — view learning records for a group
export const GET = safeHandler(async (request: NextRequest) => {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'all';
  const group = searchParams.get('group');

  // If group is specified, return learning records
  if (group) {
    const { getLearningProxy } = await import('@/lib/learning-proxy');
    const learningProxy = getLearningProxy();
    const records = await learningProxy.getGroupRecords(group);
    const recentRecords = records.slice(-50);

    const totals = records.map(r => r.evaluation?.score || 0);
    const approved = records.filter(r => r.evaluation?.verdict === 'APPROVED').length;
    const needsRevision = records.filter(r => r.evaluation?.verdict === 'NEEDS_REVISION').length;
    const summary = {
      avgTotal: totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0,
      count: records.length,
      approved,
      needsRevision,
    };

    return NextResponse.json({ records: recentRecords, summary });
  }

  // Default: return scoring history
  const { getScoringProxy } = await import('@/lib/scoring-proxy');
  const scoringProxy = getScoringProxy();
  const records = await scoringProxy.getGroupRecords(type === 'all' ? 'default' : type);
  const history = records.slice(-20);

  return NextResponse.json({ history });
});
