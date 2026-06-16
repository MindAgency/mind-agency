/**
 * Group Files API — file management for group shared directories
 *
 * GET    /api/groups/{name}/files                → list files in group
 * POST   /api/groups/{name}/files  (FormData)     → upload a file to group
 * DELETE /api/groups/{name}/files  { filename }   → delete a file from group
 */

import { NextRequest } from 'next/server';
import { getAgency } from '@/lib/agency';
import { apiOk, apiNotFound, apiBadRequest, apiInternal } from '@/lib/api-utils';

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

  const files = await proxy.getFiles();
  return apiOk({ files });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return apiBadRequest('No file provided');

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await proxy.uploadFile(filename, buffer);
    return apiOk({ filename, size: buffer.length });
  } catch (e: any) {
    return apiInternal(e.message);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const { filename } = await request.json();
  if (!filename) return apiBadRequest('filename required');

  const agency = getAgency();
  const proxy = agency.getGroup(name);

  if (!proxy.exists()) {
    return apiNotFound('Group not found');
  }

  const files = await proxy.getFiles();
  if (!files.includes(filename)) {
    return apiNotFound('File not found');
  }

  // Delete file by uploading empty buffer (workaround since GroupProxy doesn't have deleteFile)
  // TODO: Add deleteFile method to GroupProxy
  const fs = require('fs');
  const path = require('path');
  const { GROUPS_DIR } = require('@/lib/data-dir');
  const fp = path.join(GROUPS_DIR, name, 'files', filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);

  return apiOk();
}
