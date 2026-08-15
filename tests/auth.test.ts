import { describe, it, expect, vi, afterEach } from 'vitest';

const OLD_ENV = { ...process.env };

async function loadAuth() {
  vi.resetModules();
  return import('../src/lib/auth');
}

afterEach(() => {
  process.env = { ...OLD_ENV };
  vi.resetModules();
});

describe('auth', () => {
  it('allows requests when auth is not configured', async () => {
    delete process.env.MIND_SERVER_SECRET;
    delete process.env.MIND_REQUIRE_AUTH;

    const { checkAuth, isAuthEnabled } = await loadAuth();

    expect(isAuthEnabled()).toBe(false);
    expect(checkAuth(new Request('http://localhost/api/test') as any)).toBeNull();
  });

  it('requires a matching bearer token when a server secret is configured', async () => {
    process.env.MIND_SERVER_SECRET = 'secret';
    delete process.env.MIND_REQUIRE_AUTH;

    const { checkAuth, isAuthEnabled } = await loadAuth();

    expect(isAuthEnabled()).toBe(true);
    expect(checkAuth(new Request('http://localhost/api/test', {
      headers: { authorization: 'Bearer secret' },
    }) as any)).toBeNull();

    const response = checkAuth(new Request('http://localhost/api/test') as any);
    expect(response?.status).toBe(401);
  });

  it('fails closed when auth is required but no server secret is configured', async () => {
    delete process.env.MIND_SERVER_SECRET;
    process.env.MIND_REQUIRE_AUTH = 'true';

    const { checkAuth, isAuthEnabled } = await loadAuth();

    expect(isAuthEnabled()).toBe(true);
    const response = checkAuth(new Request('http://localhost/api/test') as any);
    expect(response?.status).toBe(500);
  });
});
