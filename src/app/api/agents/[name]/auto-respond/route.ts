/**
 * POST /api/agents/{name}/auto-respond — Trigger agent auto-respond
 *
 * Evaluates signal-driven autonomous response rules for the specified
 * agent. Returns whether a reply was triggered and its content.
 */

import { NextRequest, NextResponse } from 'next/server';
import { autoRespond } from '@/lib/auto-respond';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return NextResponse.json({ error: 'Invalid agent name' }, { status: 400 });
  }
  const result = await autoRespond(name);
  return NextResponse.json(result);
}
