import { NextRequest, NextResponse } from 'next/server';
import { deleteMemory, listMemory, readMemory, searchMemory, writeMemory } from '@/lib/memory';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ name: string }>;
}

export async function GET(request: NextRequest, { params }: Params) {
  const { name } = await params;
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  const query = searchParams.get('q');

  if (key) return NextResponse.json({ memory: readMemory(name, key) });
  if (query) return NextResponse.json({ memories: await searchMemory(name, query) });
  return NextResponse.json({ memories: listMemory(name) });
}

export async function POST(request: NextRequest, { params }: Params) {
  const { name } = await params;
  const body = await request.json();
  if (!body.key || !body.content) return NextResponse.json({ error: 'key and content required' }, { status: 400 });
  return NextResponse.json({ memory: writeMemory(name, body.key, body.content) }, { status: 201 });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const { name } = await params;
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  return NextResponse.json({ success: deleteMemory(name, key) });
}
