/**
 * GET /api/system/validate-key — Validate configured API key with a real API call
 *
 * Reads the active API key from settings.json / env vars and makes a lightweight
 * API call to confirm it is valid and working.
 *
 * Returns:
 *   - valid: boolean
 *   - provider: string (anthropic | openai | deepseek)
 *   - message: string
 *   - model: string (confirmed model)
 */

import { NextResponse } from 'next/server';
import { getApiKey, getBaseUrl, getModel } from '@/lib/api-settings';

export const dynamic = 'force-dynamic';

export async function GET() {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const model = getModel();

  if (!apiKey) {
    return NextResponse.json({
      valid: false,
      provider: 'unknown',
      message: 'No API key configured. Set one in Settings or via environment variable.',
      model,
    });
  }

  // Determine provider from baseUrl
  let provider = 'anthropic';
  if (baseUrl.includes('openai')) provider = 'openai';
  else if (baseUrl.includes('deepseek')) provider = 'deepseek';
  else if (baseUrl.includes('anthropic')) provider = 'anthropic';

  try {
    if (provider === 'anthropic') {
      // Lightweight: list models endpoint (much cheaper than a full completion)
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({
          valid: false,
          provider,
          message: `API key rejected (${res.status}): ${res.status === 401 ? 'invalid or expired key' : 'key lacks required permissions'}`,
          model,
        });
      }

      if (res.ok) {
        return NextResponse.json({
          valid: true,
          provider,
          message: 'API key is valid — connection successful',
          model,
        });
      }

      // Some providers don't support /v1/models — try a minimal completion instead
      return await validateWithCompletion(apiKey, baseUrl, provider, model);
    }

    if (provider === 'openai') {
      const res = await fetch(`${baseUrl}/v1/models`, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 401) {
        return NextResponse.json({
          valid: false,
          provider,
          message: 'API key rejected (401): invalid or expired key',
          model,
        });
      }

      if (res.ok) {
        return NextResponse.json({
          valid: true,
          provider,
          message: 'API key is valid — connection successful',
          model,
        });
      }

      return await validateWithCompletion(apiKey, baseUrl, provider, model);
    }

    // DeepSeek or other OpenAI-compatible providers
    return await validateWithCompletion(apiKey, baseUrl, provider, model);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('timeout') || msg.includes('AbortError')) {
      return NextResponse.json({
        valid: false,
        provider,
        message: `Connection timed out — check your network and base URL (${baseUrl})`,
        model,
      });
    }
    return NextResponse.json({
      valid: false,
      provider,
      message: `Validation failed: ${msg}`,
      model,
    });
  }
}

/**
 * Validate by sending a minimal chat completion request.
 * This costs almost nothing but confirms the key is actually usable.
 */
async function validateWithCompletion(
  apiKey: string,
  baseUrl: string,
  provider: string,
  model: string,
): Promise<ReturnType<typeof NextResponse.json>> {
  // Build the appropriate endpoint
  const chatUrl = `${baseUrl.replace(/\/$/, '')}/v1/messages`;

  const isAnthropic = provider === 'anthropic';
  const headers: Record<string, string> = isAnthropic
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    : { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' };

  const body = isAnthropic
    ? { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }
    : { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };

  const endpoint = isAnthropic ? chatUrl : `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        valid: false,
        provider,
        message: `API key rejected (${res.status}): ${res.status === 401 ? 'invalid or expired key' : 'key lacks required permissions'}`,
        model,
      });
    }

    if (res.ok) {
      return NextResponse.json({
        valid: true,
        provider,
        message: 'API key is valid — test request succeeded',
        model,
      });
    }

    // Non-auth error (e.g., 429 rate limit, 400 bad request)
    const errBody = await res.text().catch(() => '');
    return NextResponse.json({
      valid: false,
      provider,
      message: `API returned ${res.status}: ${errBody.slice(0, 200) || 'unknown error'}`,
      model,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({
      valid: false,
      provider,
      message: `Connection failed: ${msg}`,
      model,
    });
  }
}
