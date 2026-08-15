/**
 * auth.ts — Unified authentication middleware for Next.js API routes
 */

import { NextRequest, NextResponse } from 'next/server';

const SERVER_SECRET = process.env.MIND_SERVER_SECRET || '';
const REQUIRE_AUTH = process.env.MIND_REQUIRE_AUTH === '1' || process.env.MIND_REQUIRE_AUTH === 'true';

/**
 * Check if request is authenticated
 * Returns null if authenticated, or error response if not
 */
export function checkAuth(req: NextRequest): NextResponse | null {
  // Skip auth if no secret configured (dev mode)
  if (!SERVER_SECRET && !REQUIRE_AUTH) return null;

  if (!SERVER_SECRET) {
    return NextResponse.json(
      { ok: false, error: 'Authentication is required but MIND_SERVER_SECRET is not configured' },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || authHeader !== `Bearer ${SERVER_SECRET}`) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  return null;
}

/**
 * Get server secret (for WebSocket server)
 */
export function getServerSecret(): string {
  return SERVER_SECRET;
}

/**
 * Check if auth is enabled
 */
export function isAuthEnabled(): boolean {
  return !!SERVER_SECRET || REQUIRE_AUTH;
}
