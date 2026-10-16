import { getRedis } from './mcp/redis';

// GET-then-DEL would race: another holder could acquire the lock between our
// GET and our DEL, and we'd delete *their* lock instead of a no-op. The Lua
// script makes the check-and-delete atomic on the Redis side.
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

// Same race as release, but for a conditional write: only SET the data key
// while we still provably hold the lock. ARGV[3] == "" means "no TTL" (a
// plain SET) — Lua has no way to pass "omit this argument" otherwise.
const SET_IF_LOCK_HELD_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  if ARGV[3] == "" then
    redis.call("set", KEYS[2], ARGV[2])
  else
    redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3])
  end
  return 1
end
return 0
`;

/**
 * Acquires a mutex at `key` for `ttlSeconds`. Returns a random token on
 * success (required to release or write-guard the lock later), or `null` if
 * someone else already holds it.
 */
export async function acquireLock(key: string, ttlSeconds: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const result = await getRedis().set(key, token, { nx: true, ex: ttlSeconds });
  return result === 'OK' ? token : null;
}

/**
 * Releases the lock at `key`, but only if `token` is still the value stored
 * there (i.e. we still hold it — it didn't expire and get picked up by
 * someone else in the meantime). A no-op otherwise.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  await getRedis().eval(RELEASE_SCRIPT, [key], [token]);
}

/**
 * Writes `value` to `dataKey` only while `lockKey` is still held by `token`.
 * Returns whether the write happened. `value` is passed through to the same
 * per-element serializer the Upstash client uses for a plain `.set(key,
 * value)` call, so a value written this way is read back by `getRedis().get()`
 * exactly like one written via `.set()` — callers can mix the two freely.
 * Omit `ttlSeconds` for a write with no expiry (same as `.set()` with no
 * `ex` option).
 */
export async function setIfLockHeld(
  lockKey: string,
  token: string,
  dataKey: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<boolean> {
  const result = await getRedis().eval<[string, unknown, string], number>(
    SET_IF_LOCK_HELD_SCRIPT,
    [lockKey, dataKey],
    [token, value, ttlSeconds === undefined ? '' : String(ttlSeconds)],
  );
  return result === 1;
}

/**
 * Acquires `key`, runs `fn(token)`, and releases the lock in `finally`
 * regardless of how `fn` exits. Returns `null` without calling `fn` if the
 * lock could not be acquired.
 */
export async function withLock<T>(
  key: string,
  ttlSeconds: number,
  fn: (token: string) => Promise<T>,
): Promise<T | null> {
  const token = await acquireLock(key, ttlSeconds);
  if (!token) return null;

  try {
    return await fn(token);
  } finally {
    await releaseLock(key, token);
  }
}
