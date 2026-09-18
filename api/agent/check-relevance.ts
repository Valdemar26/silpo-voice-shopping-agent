export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../lib/mcp/http';
import { checkRateLimit } from '../../lib/rate-limit';
import { checkRelevanceWithClient } from '../../lib/agent/check-relevance-core';

interface CheckRelevanceBody {
  query?: unknown;
  candidateName?: unknown;
}

// Server-side only: keeps ANTHROPIC_API_KEY off the client, same pattern as
// api/agent/parse-items.ts. The actual prompt/tool/call live in
// lib/agent/check-relevance-core.ts (shared with evals/runner.ts) — this is
// just the HTTP/rate-limit/validation wrapper around it.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  // Shares the 'agent' counter with parse-items.ts — see comment there.
  const rateLimit = await checkRateLimit(req, 'agent', 30);
  if (!rateLimit.allowed) {
    return json({ error: 'Забагато запитів — спробуйте за хвилину' }, 429);
  }

  let body: CheckRelevanceBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return json({ error: 'query must be a non-empty string' }, 400);
  }
  if (typeof body.candidateName !== 'string' || body.candidateName.trim().length === 0) {
    return json({ error: 'candidateName must be a non-empty string' }, 400);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    return json({ error: 'Relevance check not configured: missing ANTHROPIC_API_KEY' }, 503);
  }

  try {
    const client = new Anthropic({ apiKey });
    const relevant = await checkRelevanceWithClient(client, body.query, body.candidateName);
    return json({ relevant }, 200);
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
