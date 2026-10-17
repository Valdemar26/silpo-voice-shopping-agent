export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { planNext } from '../../../lib/control-plane/plan';
import { getRunWithSteps } from '../../../lib/control-plane/store';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

// The [id] segment is parsed straight from the URL path rather than relied on
// via a platform query-param convention — this always works regardless of
// how Vercel's file-system routing wires bracket segments for a given
// runtime, since the full original path is always present on req.url.
function runIdFromPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1];
}

export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'GET') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  const runId = runIdFromPath(req);

  try {
    const result = await getRunWithSteps(runId);
    if (!result || result.run.sessionId !== session.sessionId) {
      return withSessionCookie(json({ error: 'Run not found' }, 404), session);
    }
    // Same { run, steps, next } shape as advance.ts/approve.ts — needed both
    // for the initial resume (SilpoAgentService.resumeIfAny()) and for
    // re-syncing after a 409 from POST /api/runs/[id]/approve.
    const next = planNext(result.run, result.steps);
    return withSessionCookie(json({ ...result, next: next.kind === 'done' ? null : next }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  }
}
