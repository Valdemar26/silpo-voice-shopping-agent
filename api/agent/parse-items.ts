export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../lib/mcp/http';
import { checkRateLimit } from '../../lib/rate-limit';
import { parseItemsWithClient } from '../../lib/agent/parse-items-core';

interface ParseItemsBody {
  text?: unknown;
}

// Server-side only: keeps ANTHROPIC_API_KEY off the client, same pattern as
// api/tts/speak.ts for the Respeecher key. The actual prompt/tool/call live
// in lib/agent/parse-items-core.ts (shared with evals/runner.ts) — this is
// just the HTTP/rate-limit/validation wrapper around it.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Every request here is a paid Anthropic call — cap it per IP before doing
  // anything else. Shares the same 'agent' counter as check-relevance.ts
  // (one Redis key per IP for both endpoints combined), since both draw on
  // the same "how many Anthropic calls is this IP allowed per minute" budget.
  const rateLimit = await checkRateLimit(req, 'agent', 30);
  if (!rateLimit.allowed) {
    return json({ error: 'Забагато запитів — спробуйте за хвилину' }, 429);
  }

  let body: ParseItemsBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return json({ error: 'text must be a non-empty string' }, 400);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return json({ error: 'Query parsing not configured: missing ANTHROPIC_API_KEY' }, 503);
  }

  try {
    const client = new Anthropic({ apiKey });
    const items = await parseItemsWithClient(client, body.text);
    return json({ items }, 200);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) {
      return json({ error: 'Invalid Anthropic API key' }, 502);
    }
    if (e instanceof Anthropic.RateLimitError) {
      return json({ error: 'Anthropic rate limit exceeded' }, 502);
    }
    if (e instanceof Anthropic.APIError) {
      return json({ error: `Anthropic API error: ${e.message}` }, 502);
    }
    return errorResponse(e);
  }
}
