// Manual smoke test against the real Upstash instance — run with:
//   npx tsx --env-file=.env.local scripts/smoke-redis-lock.ts
// Not run automatically; it talks to live Redis and cleans up its own keys.
import { getRedis } from '../lib/mcp/redis';
import { acquireLock, releaseLock, setIfLockHeld } from '../lib/redis-lock';

const LOCK_KEY = 'smoke:lock:mutex';
const DATA_KEY = 'smoke:lock:data';
const PLAIN_KEY = 'smoke:lock:plain';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok: ${message}`);
}

async function main(): Promise<void> {
  const redis = getRedis();

  try {
    // 1. acquire -> release with a foreign token -> lock still in place ->
    // release with our own token -> gone.
    const token = await acquireLock(LOCK_KEY, 30);
    assert(token !== null, 'acquireLock returns a token');

    await releaseLock(LOCK_KEY, 'not-the-real-token');
    const stillThere = await redis.get(LOCK_KEY);
    assert(stillThere === token, 'release with a foreign token leaves the lock in place');

    await releaseLock(LOCK_KEY, token as string);
    const gone = await redis.get(LOCK_KEY);
    assert(gone === null, 'release with the real token removes the lock');

    // 2. setIfLockHeld with the right token writes; with a foreign token it
    // doesn't.
    const token2 = await acquireLock(LOCK_KEY, 30);
    assert(token2 !== null, 'acquireLock returns a token (second lock)');

    const wroteWithForeignToken = await setIfLockHeld(LOCK_KEY, 'not-the-real-token', DATA_KEY, { hello: 'world' }, 30);
    assert(wroteWithForeignToken === false, 'setIfLockHeld with a foreign token does not write');
    assert((await redis.get(DATA_KEY)) === null, 'data key is still empty after the foreign-token attempt');

    const wroteWithRealToken = await setIfLockHeld(LOCK_KEY, token2 as string, DATA_KEY, { hello: 'world' }, 30);
    assert(wroteWithRealToken === true, 'setIfLockHeld with the real token writes');

    // 3. Format parity: a value written via setIfLockHeld must read back via
    // getRedis().get() exactly like one written via plain set() — this is
    // the format getTokens()/saveTokens() rely on.
    const sameValue = { hello: 'world' };
    await redis.set(PLAIN_KEY, sameValue);

    const viaLock = await redis.get(DATA_KEY);
    const viaPlainSet = await redis.get(PLAIN_KEY);
    assert(JSON.stringify(viaLock) === JSON.stringify(viaPlainSet), 'setIfLockHeld value matches a plain set() value when read back');
    console.log('viaLock:', viaLock, 'viaPlainSet:', viaPlainSet);

    await releaseLock(LOCK_KEY, token2 as string);

    console.log('\nAll smoke checks passed.');
  } finally {
    await redis.del(LOCK_KEY);
    await redis.del(DATA_KEY);
    await redis.del(PLAIN_KEY);
    console.log('cleaned up smoke:lock:* keys');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
