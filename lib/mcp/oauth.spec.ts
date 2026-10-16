import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake Redis backend good enough to exercise the real lib/mcp/redis.ts
// wrapper functions AND lib/redis-lock.ts's Lua-script calls — mocked at the
// '@upstash/redis' package boundary (not './redis') so every real function in
// between (getTokens, saveTokens, acquireLock, setIfLockHeld, ...) runs
// unmodified against it.
interface StoredEntry {
  value: unknown;
  expiresAt: number | null;
}

const store = new Map<string, StoredEntry>();

function isExpired(entry: StoredEntry): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= Date.now();
}

function rawGet(key: string): unknown {
  const entry = store.get(key);
  if (!entry || isExpired(entry)) {
    store.delete(key);
    return null;
  }
  return entry.value;
}

vi.mock('@upstash/redis', () => {
  class FakeRedis {
    get = vi.fn(async (key: string) => rawGet(key));

    set = vi.fn(async (key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) => {
      if (opts?.nx && rawGet(key) !== null) return null;
      store.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
      return 'OK';
    });

    del = vi.fn(async (key: string) => {
      const had = rawGet(key) !== null;
      store.delete(key);
      return had ? 1 : 0;
    });

    // Dispatches on arity rather than script text: 1 key => release
    // semantics, 2 keys => setIfLockHeld semantics — matches the only two
    // scripts lib/redis-lock.ts sends.
    eval = vi.fn(async (_script: string, keys: string[], args: unknown[]) => {
      if (keys.length === 1) {
        const [key] = keys;
        const [token] = args as [string];
        if (rawGet(key) === token) {
          store.delete(key);
          return 1;
        }
        return 0;
      }

      const [lockKey, dataKey] = keys;
      const [token, value, ttlRaw] = args as [string, unknown, string];
      if (rawGet(lockKey) === token) {
        const ttlSeconds = ttlRaw === '' ? null : Number(ttlRaw);
        store.set(dataKey, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
        return 1;
      }
      return 0;
    });
  }

  return { Redis: FakeRedis };
});

process.env['UPSTASH_REDIS_REST_URL'] = 'https://fake-upstash.example';
process.env['UPSTASH_REDIS_REST_TOKEN'] = 'fake-token';

import { getClientCredentials, getTokens, saveClientCredentials, saveTokens } from './redis';
import { ensureValidAccessToken, ReauthRequiredError, TOKEN_ENDPOINT } from './oauth';

const SESSION_ID = 'session-1';

describe('ensureValidAccessToken', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('two concurrent calls with an expired token issue exactly one refresh fetch and agree on the result', async () => {
    await saveClientCredentials({ client_id: 'client-1' });
    await saveTokens(SESSION_ID, {
      access_token: 'old-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 10_000,
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-token', refresh_token: 'refresh-token', expires_in: 3600 }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([ensureValidAccessToken(SESSION_ID), ensureValidAccessToken(SESSION_ID)]);

    expect(a).toBe('new-token');
    expect(b).toBe('new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TOKEN_ENDPOINT);
  });

  it('invalid_client from the refresh call deletes mcp:client and the session tokens, and throws ReauthRequiredError', async () => {
    await saveClientCredentials({ client_id: 'client-1' });
    await saveTokens(SESSION_ID, {
      access_token: 'old-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() - 10_000,
    });

    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: false,
      status: 400,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: 'invalid_client' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(ensureValidAccessToken(SESSION_ID)).rejects.toThrow(ReauthRequiredError);

    expect(await getClientCredentials()).toBeNull();
    expect(await getTokens(SESSION_ID)).toBeNull();
  });
});
