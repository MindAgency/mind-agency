/**
 * GET /api/groups/{name}/search?q=<query> — Search group chat messages
 *
 * Returns messages containing the search query with surrounding context.
 * Results are limited to the last 20 messages in the group.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const q = request.nextUrl.searchParams.get('q')?.trim().toLowerCase();
  if (!q) return NextResponse.json({ results: [] });

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return NextResponse.json({ results: [] });
  }

  const messages = await proxy.getMessages(20);
  const results: { from: string; date: string; body: string; matchAround: string }[] = [];

  for (const msg of messages) {
    if (!msg.body.toLowerCase().includes(q)) continue;
    const ctxStart = Math.max(0, msg.body.toLowerCase().indexOf(q) - 40);
    const matchAround = msg.body.slice(ctxStart, ctxStart + 120);
    results.push({ from: msg.from, date: msg.date, body: msg.body, matchAround });
  }

  return NextResponse.json({ results, total: results.length });
}
