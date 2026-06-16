/**
 * POST /api/system/token — report token usage from agents
 * GET  /api/system/token — read recent usage summary
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';
import { apiOk, apiBadRequest } from '@/lib/api-utils';

export async function GET() {
  try {
    const agency = getAgency();
    await agency.system.loadTokenRecords();

    const records = agency.system.tokenRecords.slice(-200);

    const byAgent: Record<string, { tokensIn: number; tokensOut: number; cost: number; calls: number }> = {};
    let totalTokens = 0, totalCost = 0;

    for (const r of records) {
      totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
      totalCost += (r.cost || 0);
      if (!byAgent[r.agent]) byAgent[r.agent] = { tokensIn: 0, tokensOut: 0, cost: 0, calls: 0 };
      byAgent[r.agent].tokensIn += (r.inputTokens || 0);
      byAgent[r.agent].tokensOut += (r.outputTokens || 0);
      byAgent[r.agent].cost += (r.cost || 0);
      byAgent[r.agent].calls++;
    }

    return NextResponse.json({
      records: records.slice(-50),
      summary: { totalTokens, totalCost: +totalCost.toFixed(4), byAgent },
    });
  } catch {
    return NextResponse.json({ records: [], summary: { totalTokens: 0, totalCost: 0 } });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const agency = getAgency();

    await agency.system.addTokenRecord({
      timestamp: Date.now(),
      agent: body.agent || 'unknown',
      model: body.model || 'unknown',
      inputTokens: body.tokensIn || 0,
      outputTokens: body.tokensOut || 0,
      cost: body.cost || 0,
    });

    return apiOk();
  } catch {
    return apiBadRequest('invalid json');
  }
}
