/**
 * API Route Handler Wrapper
 *
 * Wraps Next.js route handlers to catch ALL errors -- including webpack module
 * loading failures during hot-reload -- and return proper JSON responses.
 */

import { NextRequest, NextResponse } from 'next/server';

type RouteContext = { params: Promise<Record<string, string>> };

export function safeHandler(
  handler: (request: NextRequest, context: RouteContext) => Promise<Response | NextResponse | void>
) {
  return async (request: NextRequest, context: RouteContext) => {
    try {
      const result = await handler(request, context);
      if (result === undefined || result === null) {
        return NextResponse.json({ ok: true });
      }
      return result;
    } catch (err: any) {
      const message = err?.message || String(err);
      const isModuleError = message.includes('webpack_modules') || message.includes('Cannot find module');
      console.error(`[api-handler] ${isModuleError ? 'Module error' : 'Error'}:`, message);
      return NextResponse.json(
        { error: { code: 'INTERNAL_ERROR', message: isModuleError ? 'Server reloading, retry in a moment' : message } },
        { status: 500 }
      );
    }
  };
}
