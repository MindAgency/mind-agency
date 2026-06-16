/**
 * POST /api/economy/transfer — transfer tokens between agents
 */
import { NextRequest } from 'next/server';
import { transfer } from '@/lib/token-economy';
import { apiOk, apiBadRequest, apiInternal } from '@/lib/api-utils';

export async function POST(request: NextRequest) {
  try {
    const { from, to, amount, reason } = await request.json();
    if (!from || !to || !amount) return apiBadRequest('from, to, amount required');
    const ok = await transfer(from, to, Number(amount), reason || 'transfer');
    return apiOk({ ok });
  } catch (e: any) {
    return apiInternal(e.message);
  }
}
