/**
 * GET  /api/system/settings — read current settings
 * PUT  /api/system/settings — update settings (persisted to .mind/settings.json)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgency } from '@/lib/agency';
import { encryptApiKey } from '@/lib/crypto';
import { validateApiKey, validateUrl } from '@/lib/validation';
import { apiOk, apiBadRequest } from '@/lib/api-utils';

interface MindSettings {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  port?: number;
  wsPort?: number;
  heartbeatIntervalMs?: number;
}

export async function GET() {
  const agency = getAgency();
  await agency.system.loadSettings();

  const s = agency.system.settings;
  // Mask API key - never send full key to frontend
  const masked = { ...s, apiKey: s.apiKey ? '••••••••' + s.apiKey.slice(-4) : undefined };
  return NextResponse.json(masked);
}

export async function PUT(request: NextRequest) {
  try {
    const body: MindSettings = await request.json();
    const agency = getAgency();
    await agency.system.loadSettings();

    const current = agency.system.settings;

    // Only update non-undefined fields. API key: only update if not masked.
    if (body.apiKey && !body.apiKey.startsWith('••••')) {
      // Validate API key
      const validation = validateApiKey(body.apiKey);
      if (!validation.valid) {
        return apiBadRequest(validation.errors.join(', '));
      }
      // Encrypt API key before storing
      current.apiKey = encryptApiKey(body.apiKey);
    }
    else if (body.apiKey && body.apiKey.startsWith('••••') && body.apiKey.length === 12) {
      // User re-entered masked value — keep existing
    } else if (body.apiKey === '') {
      delete current.apiKey;
    }

    if (body.baseUrl !== undefined) {
      if (body.baseUrl) {
        // Validate URL
        const validation = validateUrl(body.baseUrl);
        if (!validation.valid) {
          return apiBadRequest(validation.errors.join(', '));
        }
        current.baseUrl = body.baseUrl;
      } else {
        delete current.baseUrl;
      }
    }
    if (body.model !== undefined) {
      if (body.model) current.model = body.model; else delete current.model;
    }
    if (body.port !== undefined) current.port = body.port;
    if (body.wsPort !== undefined) current.wsPort = body.wsPort;
    if (body.heartbeatIntervalMs !== undefined) current.heartbeatIntervalMs = body.heartbeatIntervalMs;

    await agency.system.saveSettings();
    return apiOk({ settings: { ...current, apiKey: current.apiKey ? '••••••••' + current.apiKey.slice(-4) : undefined } } as Record<string, unknown>);
  } catch {
    return apiBadRequest('Invalid JSON');
  }
}
