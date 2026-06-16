/**
 * Shared API utilities — consistent error/success format and validation.
 *
 * Error format: { error: { code: string, message: string, details?: unknown } }
 * Success format: { ok: true, ...data }
 */

import { NextResponse } from 'next/server';

// ── Error codes ──────────────────────────────────────────────
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CONFLICT: 'CONFLICT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ── Error response helpers ───────────────────────────────────

export function apiError(code: ErrorCode, message: string, status: number, details?: unknown) {
  return NextResponse.json(
    { error: { code, message, ...(details ? { details } : {}) } },
    { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
  );
}

export function apiNotFound(message: string) {
  return apiError(ErrorCode.NOT_FOUND, message, 404);
}

export function apiBadRequest(message: string) {
  return apiError(ErrorCode.VALIDATION_ERROR, message, 400);
}

export function apiValidation(message: string, details?: unknown) {
  return apiError(ErrorCode.VALIDATION_ERROR, message, 422, details);
}

export function apiForbidden(message: string) {
  return apiError(ErrorCode.FORBIDDEN, message, 403);
}

export function apiConflict(message: string) {
  return apiError(ErrorCode.CONFLICT, message, 409);
}

export function apiInternal(message: string) {
  return apiError(ErrorCode.INTERNAL_ERROR, message, 500);
}

export function apiUpstream(message: string) {
  return apiError(ErrorCode.UPSTREAM_ERROR, message, 502);
}

// ── Success response helpers ─────────────────────────────────

export function apiOk(data?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...data });
}

export function apiCreated(data?: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...data }, { status: 201 });
}

// ── Validation helpers ───────────────────────────────────────

const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateName(name: string | undefined | null): string | null {
  if (!name || !NAME_REGEX.test(name)) return null;
  return name;
}

export function requireName(name: string | undefined | null): string | NextResponse {
  const valid = validateName(name);
  if (!valid) return apiValidation('Invalid name: must be alphanumeric with hyphens/underscores');
  return valid;
}

// ── Parse body helper ────────────────────────────────────────

export async function parseBody(request: Request): Promise<{ body: Record<string, unknown> | null; error?: NextResponse }> {
  try {
    const body = await request.json();
    return { body };
  } catch {
    return { body: null, error: apiBadRequest('Invalid JSON body') };
  }
}
