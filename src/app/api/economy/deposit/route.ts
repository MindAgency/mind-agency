/**
 * POST /api/economy/deposit — deposit tokens to agent
 */
import { NextRequest } from 'next/server';
import { deposit } from '@/lib/token-economy';
import { apiOk, apiBadRequest, apiInternal } from '@/lib/api-utils';

export async function POST(request: NextRequest) {
  try {
    const { agent, amount, from, reason } = await request.json();
    if (!agent || !amount) return apiBadRequest('agent and amount required');
    const balance = await deposit(agent, Number(amount), reason || 'deposit');
    return apiOk({ balance });
  } catch (e: any) {
    return apiInternal(e.message);
  }
}
