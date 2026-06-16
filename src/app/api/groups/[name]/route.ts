/**
 * Group Chat API — messages and metadata for a group
 *
 * GET    /api/groups/{name}              → get group members, messages, and info
 * POST   /api/groups/{name}              → send a message to group chat
 * DELETE /api/groups/{name}?owner=<name>  → delete a group (owner only)
 *
 * GET responses are cached for 10 seconds (skip with ?nocache=1).
 * Messages are broadcast to connected clients via WebSocket in real time.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getGroupRegistry } from '@/lib/group-registry';
import { broadcastWs } from '@/lib/ws-embedded';
import { apiOk, apiNotFound, apiBadRequest, apiForbidden } from '@/lib/api-utils';

// Simple cache for group API responses (10s TTL for fresh chat data)
const groupApiCache = new Map<string, { data: any; ts: number }>();
const GROUP_API_TTL = 10_000; // 10s

export async function GET(request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;

  // Check cache first (skip if ?nocache=1)
  const noCache = request.nextUrl.searchParams.get('nocache') === '1';
  if (!noCache) {
    const cached = groupApiCache.get(name);
    if (cached && (Date.now() - cached.ts) < GROUP_API_TTL) {
      return NextResponse.json(cached.data);
    }
  }

  const registry = getGroupRegistry();
  const proxy = registry.getOrCreate(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  // Parse limit from query params (default: 20)
  const limit = Math.min(Math.max(parseInt(request.nextUrl.searchParams.get('limit') || '20', 10) || 20, 1), 200);

  // Load members and messages via proxy
  await proxy.loadMembers();
  const members = proxy.members.map(m => m.name);
  const messages = await proxy.getMessages(limit);

  // Group info from config
  await proxy.loadConfig();
  const info = {
    name: proxy.config.name,
    description: proxy.config.description,
    owner: proxy.config.owner,
    admins: proxy.config.admins,
    announcement: proxy.config.announcement,
  };

  const result = { group: name, members, messages, messageCount: messages.length, info };

  // Cache the result
  groupApiCache.set(name, { data: result, ts: Date.now() });

  return NextResponse.json(result);
}

// ── POST /api/groups/[name] — send a message directly to group chat ──

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const registry = getGroupRegistry();
  const proxy = registry.getOrCreate(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  let from = 'system';
  let message = '';
  try {
    const body = await request.json();
    from = (body.from || 'system').trim();
    message = (body.message || '').trim();
  } catch {
    return apiBadRequest('Invalid JSON');
  }
  if (!message) return apiBadRequest('Empty message');
  if (!/^[a-zA-Z0-9_-]+$/.test(from) && from !== 'system') {
    return apiBadRequest('Invalid sender name');
  }

  // Send message via proxy
  await proxy.sendMessage(from, message);

  // Push to all connected clients in real time
  broadcastWs('group_message', { group: name, from, message, date: new Date().toISOString() });

  return apiOk({ from, date: new Date().toISOString() });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  // Auth check: only owner can delete group
  const { searchParams } = new URL(request.url);
  const owner = searchParams.get('owner');
  if (!owner) {
    return apiForbidden('owner param required for authorization');
  }

  const registry = getGroupRegistry();
  const proxy = registry.getOrCreate(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  // Check ownership
  const config = (proxy as any).config || {};
  if (config.owner && config.owner !== owner) {
    return apiForbidden('Only group owner can delete the group');
  }

  // Remove group via registry (this will clean up the proxy)
  registry.remove(name);

  // Also remove the directory
  const fs = require('fs');
  const path = require('path');
  const { GROUPS_DIR } = require('@/lib/data-dir');
  const groupDir = path.join(GROUPS_DIR, name);
  if (fs.existsSync(groupDir)) {
    fs.rmSync(groupDir, { recursive: true, force: true });
  }

  return apiOk();
}
