import { getRedis } from './mcp/redis';

const WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

// Vercel Edge Functions sit behind a proxy, so the real client address only
// shows up in x-forwarded-for (first entry) — req itself has no .ip.
function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

/**
 * Fixed-window per-IP rate limit backed by a single Redis counter (INCR + a
 * one-time EXPIRE on the first hit in the window). Good enough to stop a
 * runaway client from burning paid LLM/TTS calls — not a general-purpose
 * limiter (no sliding window, no burst allowance).
 */
export async function checkRateLimit(req: Request, bucket: string, limit: number): Promise<RateLimitResult> {
  const key = `ratelimit:${bucket}:${clientIp(req)}`;
  const redis = getRedis();

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, WINDOW_SECONDS);
  }

  return { allowed: count <= limit, remaining: Math.max(0, limit - count), limit };
}
