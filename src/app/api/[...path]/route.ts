/**
 * Catch-all API route — returns JSON errors for unknown endpoints.
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const p = await context.params;
  return NextResponse.json({ error: 'Not found', path: '/' + (p.path || []).join('/') }, { status: 404 });
}

export async function POST(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const p = await context.params;
  return NextResponse.json({ error: 'Not found', path: '/' + (p.path || []).join('/') }, { status: 404 });
}

export async function PUT(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const p = await context.params;
  return NextResponse.json({ error: 'Not found', path: '/' + (p.path || []).join('/') }, { status: 404 });
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const p = await context.params;
  return NextResponse.json({ error: 'Not found', path: '/' + (p.path || []).join('/') }, { status: 404 });
}
