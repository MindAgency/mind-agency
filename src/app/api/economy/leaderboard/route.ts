/**
 * GET /api/economy/leaderboard — get token leaderboard
 */
import { getLeaderboard } from '@/lib/token-economy';
import { apiOk, apiInternal } from '@/lib/api-utils';

export async function GET() {
  try {
    const leaderboard = getLeaderboard();
    return apiOk({ leaderboard });
  } catch (e: any) {
    return apiInternal(e.message);
  }
}
