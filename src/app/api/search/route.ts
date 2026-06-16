import { NextRequest, NextResponse } from 'next/server';
import { runWebSearch } from '@/lib/web-search';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.query) return NextResponse.json({ error: 'query required' }, { status: 400 });
    const result = await runWebSearch(body.query, {
      provider: body.provider,
      maxResults: body.maxResults,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
