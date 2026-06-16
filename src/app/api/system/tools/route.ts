import { NextRequest, NextResponse } from 'next/server';
import { deleteManagedTool, listManagedTools, upsertManagedTool } from '@/lib/tool-registry';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ tools: listManagedTools() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  if (!body.name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const tool = upsertManagedTool({
    name: body.name,
    description: body.description || '',
    type: body.type || 'http',
    enabled: !!body.enabled,
    risk: body.risk || 'medium',
    inputSchema: body.inputSchema,
    endpoint: body.endpoint,
    method: body.method || 'POST',
    headers: body.headers,
  });
  return NextResponse.json({ tool });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const name = searchParams.get('name');
  if (!name) return NextResponse.json({ error: 'name required' }, { status: 400 });
  const success = deleteManagedTool(name);
  return NextResponse.json({ success });
}
