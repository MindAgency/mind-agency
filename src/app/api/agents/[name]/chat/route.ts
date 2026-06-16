/**
 * Agent Chat API — SSE streaming chat with an agent
 *
 * POST   /api/agents/{name}/chat → send a message, receive SSE stream
 * GET    /api/agents/{name}/chat → retrieve chat history
 * DELETE /api/agents/{name}/chat → clear chat history
 *
 * Supports CLI commands (/goal, /plan, /rename), group-scoped chat,
 * model override, and idempotent replay (same request within 10s
 * returns the cached SSE stream).
 */

import { NextRequest } from 'next/server';
import { createChatStream, getChatHistory, clearChat, savePartialState } from '@/lib/chat';
import { writeAudit } from '@/lib/audit';
import { handleCliCommand } from '@/lib/cli-commands';
import { validateAgentName, validateMessage } from '@/lib/validation';
import { requireName } from '@/lib/api-utils';

// ── Memory pressure monitor — prevent worker OOM crashes ──
// Next.js runs API routes in Jest worker processes. When heap usage exceeds
// the threshold, we force GC and log a warning. This prevents the worker from
// hitting the V8 heap limit and crashing with "Jest worker encountered 2 child
// process exceptions, exceeding retry limit".
const HEAP_WARNING_MB = 400;
let chatRequestCount = 0;

function checkMemoryPressure(label: string): void {
  chatRequestCount++;
  // Check every 10 requests to avoid overhead
  if (chatRequestCount % 10 !== 0) return;
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  if (heapMB > HEAP_WARNING_MB) {
    console.warn(`[chat] Memory pressure: ${heapMB}MB heap at ${label} (RSS: ${Math.round(mem.rss / 1024 / 1024)}MB)`);
    if (global.gc) {
      global.gc();
      const afterMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log(`[chat] GC reduced heap: ${heapMB}MB -> ${afterMB}MB`);
    }
  }
}

export const dynamic = 'force-dynamic';

// ── SSE connection management (prevents server deadlock) ──
const MAX_SSE_CONNECTIONS = 20;          // max concurrent SSE streams
const SSE_STREAM_TIMEOUT = 120_000;      // 2 min hard timeout per stream
const MAX_SSE_CACHE = 50;               // max cached SSE responses (prevent OOM)
let activeSSECount = 0;

// ── Idempotency cache: same agent + same message within 10s → replay cached SSE ──
const sseCache = new Map<string, { chunks: string[]; ts: number }>();
const SSE_CACHE_TTL = 10_000;

/** Periodically purge expired cache entries + enforce size limit */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sseCache) {
    if (now - v.ts > SSE_CACHE_TTL) sseCache.delete(k);
  }
  // Hard limit: if still too large after TTL purge, evict oldest entries
  if (sseCache.size > MAX_SSE_CACHE) {
    const entries = [...sseCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toDelete = entries.slice(0, sseCache.size - MAX_SSE_CACHE);
    for (const [k] of toDelete) sseCache.delete(k);
  }
}, 15_000).unref?.();

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function replaySSE(chunks: string[]): Response {
  let i = 0;
  const body = new ReadableStream({
    pull(ctrl) {
      if (i < chunks.length) {
        ctrl.enqueue(new TextEncoder().encode(chunks[i++]));
      } else {
        ctrl.close();
      }
    },
  });
  return new Response(body, { headers: sseHeaders });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  checkMemoryPressure(`start:${name}`);

  // ── Connection limit: reject if too many SSE streams active ──
  if (activeSSECount >= MAX_SSE_CONNECTIONS) {
    console.warn(`[chat] SSE connection limit reached (${MAX_SSE_CONNECTIONS}), rejecting request for ${name}`);
    return new Response(JSON.stringify({ error: 'Too many active connections. Please wait and retry.' }), {
      status: 429,
      headers: { 'Retry-After': '5' },
    });
  }

  // Validate agent name
  const nameValidation = validateAgentName(name);
  if (!nameValidation.valid) {
    return new Response(JSON.stringify({ error: nameValidation.errors.join(', ') }), { status: 400 });
  }

  let message = '';
  let group = '';
  let model = '';
  let fresh = false;
  try {
    const body = await request.json();
    message = (body.message || '').trim();
    group = (body.group || '').trim();
    model = (body.model || '').trim();
    fresh = body.fresh === true;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  // Validate message
  const messageValidation = validateMessage(message);
  if (!messageValidation.valid) {
    return new Response(JSON.stringify({ error: messageValidation.errors.join(', ') }), { status: 400 });
  }

  // ── Idempotency check ──
  const cacheKey = `${name}::${group}::${model}::${fresh}::${message}`;
  const cached = sseCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SSE_CACHE_TTL) {
    return replaySSE(cached.chunks);
  }

  // ── CLI command handling (e.g. /goal, /plan, /rename) ──
  const history = getChatHistory(name);
  const sessionId = history.sessionId || '';
  const cliResult = handleCliCommand(name, message, sessionId);
  if (cliResult.handled) {
    // Direct reply (like /goal confirm, /rename confirm)
    // Wrapped as SSE so the frontend's existing stream handler consumes it.
    if (cliResult.directReply) {
      const sseBody = `data: ${JSON.stringify({ type: 'text', content: cliResult.directReply, timestamp: new Date().toISOString() })}\n\ndata: [DONE]\n\n`;
      return new Response(sseBody, { headers: sseHeaders });
    }
    // Commands with optsOverrides (like /plan) — continue to stream with overrides
  }

  // Audit log
  writeAudit({
    agent: name,
    action: 'chat.message',
    resource: group ? `group:${group}` : `agent:${name}`,
    details: message.slice(0, 200),
  });

  // v0.7: Mark agent as active for adaptive heartbeat
  try {
    const { markAgentActive } = require('@/lib/scheduler');
    markAgentActive(name);
  } catch (e) { console.error('[app:api:agents:[name]:chat:route]', e); }

  // SSE stream — pass group/model/overrides/fresh
  const stream = await createChatStream(name, message, group || undefined, model || undefined, cliResult.optsOverrides, fresh);

  // Buffer SSE chunks for caching (lazily, only if the stream completes)
  const chunks: string[] = [];
  let fullReply = '';
  let allEvents: any[] = [];
  let chatSessionId = sessionId || '';
  let connectionCounted = false;

  // Abort controller for client disconnect + timeout
  const abortCtrl = new AbortController();
  const timeoutId = setTimeout(() => {
    abortCtrl.abort();
  }, SSE_STREAM_TIMEOUT);

  // Track client disconnect
  request.signal.addEventListener('abort', () => {
    abortCtrl.abort();
  });

  const sseStream = new ReadableStream({
    async start(controller) {
      activeSSECount++;
      connectionCounted = true;
      console.log(`[chat] SSE opened for ${name} (active: ${activeSSECount})`);

      const reader = stream.getReader();
      try {
        // Race between reading the stream and abort (disconnect/timeout)
        const readLoop = (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            // Decode Uint8Array to ChatEvent if stream emits encoded bytes
            const event: any = value instanceof Uint8Array
              ? JSON.parse(new TextDecoder().decode(value))
              : value;
            // v0.6: Collect events and reply for session save
            if (event.type === 'text') fullReply += event.content || '';
            if (event.type === 'tool_use' || event.type === 'tool_result') allEvents.push(event);
            if ('session_id' in event) chatSessionId = event.session_id || chatSessionId;
            const line = `data: ${JSON.stringify(event)}\n\n`;
            chunks.push(line);
            controller.enqueue(new TextEncoder().encode(line));
          }
        })();

        const abortPromise = new Promise<never>((_, reject) => {
          abortCtrl.signal.addEventListener('abort', () => {
            reject(new Error('Client disconnected or stream timeout'));
          }, { once: true });
        });

        await Promise.race([readLoop, abortPromise]);
      } catch (err: any) {
        // Only send error if controller is still open
        if (!abortCtrl.signal.aborted || err.message?.includes('disconnect')) {
          try {
            const errEvt = JSON.stringify({ type: 'error', content: err.message || String(err), timestamp: new Date().toISOString() });
            chunks.push(`data: ${errEvt}\n\n`);
            controller.enqueue(new TextEncoder().encode(`data: ${errEvt}\n\n`));
          } catch { /* controller already closed */ }
        }
      } finally {
        clearTimeout(timeoutId);
        // v0.6: Save session after stream completes — ensures session is always saved
        try {
          savePartialState(name, { userMessage: message, fullReply, allEvents, sessionId: chatSessionId });
        } catch (e) { console.error(`[chat] route saveSession failed:`, e); }

        // Cancel the inner reader if still pending
        try { reader.cancel().catch(() => {}); } catch { /* ignore */ }

        try {
          const doneLine = `data: [DONE]\n\n`;
          chunks.push(doneLine);
          controller.enqueue(new TextEncoder().encode(doneLine));
          controller.close();
        } catch { /* controller already closed */ }

        // Cache completed response for idempotent replay (before clearing chunks)
        if (chunks.length > 2) {
          sseCache.set(cacheKey, { chunks, ts: Date.now() });
        }

        // Check memory pressure after completing a chat request
        checkMemoryPressure(`done:${name}`);

        // Release large accumulators so GC can reclaim memory before next request
        fullReply = '';
        allEvents = [];
        chunks.length = 0;

        // Decrement connection count
        if (connectionCounted) {
          activeSSECount--;
          connectionCounted = false;
          console.log(`[chat] SSE closed for ${name} (active: ${activeSSECount})`);
        }
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      ...sseHeaders,
      'X-SSE-Timeout': String(SSE_STREAM_TIMEOUT),
    },
  });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const validName = requireName(name);
  if (validName instanceof Response) return validName;
  return Response.json(getChatHistory(validName));
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;
  const validName = requireName(name);
  if (validName instanceof Response) return validName;
  clearChat(validName);
  return Response.json({ ok: true });
}
