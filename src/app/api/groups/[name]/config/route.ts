/**
 * Group Config API — load/save group settings.
 *
 * GET  /api/groups/{name}/config → return config
 * PUT  /api/groups/{name}/config → update config (owner/admin only)
 * POST /api/groups/{name}/manage  → invite/kick/set_admin (owner/admin only)
 */

import { NextRequest } from 'next/server';
import { getAgency } from '@/lib/agency';
import { apiOk, apiNotFound, apiBadRequest, apiForbidden, apiConflict } from '@/lib/api-utils';

// ── GET ──────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  await proxy.loadConfig();
  await proxy.loadMembers();

  return apiOk({
    ...proxy.config,
    members: proxy.members.map(m => m.name),
  } as Record<string, unknown>);
}

// ── PUT — update group settings (owner/admins) ──────────

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  let body: { by?: string; owner?: string; admins?: string[]; name?: string; description?: string; announcement?: { title: string; content: string; pinnedBy: string; pinnedAt?: number } | null };
  try { body = await request.json(); } catch {
    return apiBadRequest('Invalid JSON');
  }

  const actor = (body.by || 'system').trim();

  await proxy.loadConfig();

  // Update simple fields
  if (body.admins !== undefined) proxy.config.admins = body.admins;
  if (body.name !== undefined) proxy.config.name = body.name;
  if (body.description !== undefined) proxy.config.description = body.description;

  // Announcement: null = remove, object = set
  if (body.announcement !== undefined) {
    if (body.announcement === null) {
      delete proxy.config.announcement;
    } else {
      proxy.config.announcement = {
        title: body.announcement.title || '',
        content: body.announcement.content || '',
        author: body.announcement.pinnedBy || actor,
        timestamp: body.announcement.pinnedAt || Date.now(),
      };
    }
  }

  await proxy.saveConfig();
  return apiOk({ config: proxy.config } as Record<string, unknown>);
}

// ── POST — membership management (invite/kick/set_admin) ──

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  let body: { action?: string; by?: string; agent?: string; admin?: boolean };
  try { body = await request.json(); } catch {
    return apiBadRequest('Invalid JSON');
  }

  const actor = body.by?.trim() || 'system';
  const action = body.action || '';
  const target = body.agent?.trim();

  if (!target && action !== 'list') {
    return apiBadRequest('agent required');
  }

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  await proxy.loadConfig();
  await proxy.loadMembers();

  if (action === 'invite') {
    if (!proxy.config.admins.includes(actor) && proxy.config.owner !== actor) {
      return apiForbidden('Not an admin of this group');
    }
    const ok = await proxy.addMember(target!);
    if (!ok) return apiConflict('Already a member or missing');
    return apiOk({ action: 'invite', agent: target });
  }

  if (action === 'kick') {
    if (!proxy.config.admins.includes(actor) && proxy.config.owner !== actor) {
      return apiForbidden('Not an admin of this group');
    }
    const ok = await proxy.removeMember(target!);
    if (!ok) return apiNotFound('Not a member');
    return apiOk({ action: 'kick', agent: target });
  }

  if (action === 'set_admin') {
    if (proxy.config.owner !== actor) {
      return apiForbidden('Only the group owner can set admins');
    }
    if (body.admin) {
      if (!proxy.config.admins.includes(target!)) proxy.config.admins.push(target!);
    } else {
      proxy.config.admins = proxy.config.admins.filter(a => a !== target);
    }
    await proxy.saveConfig();
    return apiOk({ action: 'set_admin', agent: target, admin: body.admin });
  }

  if (action === 'transfer') {
    if (proxy.config.owner !== actor) {
      return apiForbidden('Only the group owner can transfer ownership');
    }
    proxy.config.owner = target!;
    proxy.config.admins = proxy.config.admins.filter(a => a !== target); // remove from admins if was admin
    await proxy.saveConfig();
    return apiOk({ action: 'transfer', newOwner: target });
  }

  return apiBadRequest('Unknown action. Use: invite, kick, set_admin, transfer');
}
