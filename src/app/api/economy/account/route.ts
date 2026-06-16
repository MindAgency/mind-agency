/**
 * GET /api/economy/account?agent=<name> — get agent token account
 */
import { NextRequest } from 'next/server';
import { getAgentAccount } from '@/lib/token-economy';
import { apiOk, apiBadRequest, apiInternal } from '@/lib/api-utils';

export async function GET(request: NextRequest) {
  const agent = request.nextUrl.searchParams.get('agent');
  if (!agent) return apiBadRequest('agent required');
  try {
    const account = getAgentAccount(agent);
    return apiOk({ account });
  } catch (e: any) {
    return apiInternal(e.message);
  }
}
