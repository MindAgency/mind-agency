/**
 * Group Members API — manage group membership
 *
 * GET    /api/groups/{name}/members  → list all members
 * POST   /api/groups/{name}/members  → invite/kick/set_admin/transfer
 * DELETE /api/groups/{name}/members  → remove a member
 */

import { NextRequest } from 'next/server';
import { getAgency } from '@/lib/agency';
import { apiOk, apiNotFound, apiBadRequest, apiForbidden, apiConflict } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

// ── GET — list members ──

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

  await proxy.loadMembers();
  await proxy.loadConfig();

  return apiOk({
    members: proxy.members.map(m => m.name),
    owner: proxy.config.owner,
    admins: proxy.config.admins,
  });
}

// ── POST — invite/kick/set_admin/transfer ──

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
    proxy.config.admins = proxy.config.admins.filter(a => a !== target);
    await proxy.saveConfig();
    return apiOk({ action: 'transfer', newOwner: target });
  }

  if (action === 'list') {
    return apiOk({
      members: proxy.members.map(m => m.name),
      owner: proxy.config.owner,
      admins: proxy.config.admins,
    });
  }

  return apiBadRequest('Unknown action. Use: invite, kick, set_admin, transfer, list');
}

// ── DELETE — remove a member (alternative to kick) ──

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { searchParams } = new URL(request.url);
  const target = searchParams.get('agent');
  const actor = searchParams.get('by') || 'system';

  if (!target) {
    return apiBadRequest('agent query param required');
  }

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  await proxy.loadConfig();
  await proxy.loadMembers();

  if (!proxy.config.admins.includes(actor) && proxy.config.owner !== actor) {
    return apiForbidden('Not an admin of this group');
  }

  const ok = await proxy.removeMember(target);
  if (!ok) return apiNotFound('Not a member');

  return apiOk({ action: 'remove', agent: target });
}
