import { NextRequest, NextResponse } from 'next/server';
import { callManagedHttpTool } from '@/lib/tool-registry';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 });
    const result = await callManagedHttpTool(body.name, body.input || {});
    return NextResponse.json({ result });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
