export const config = { runtime: 'edge' };

import { errorResponse, json } from '../lib/mcp/http';
import { planNext } from '../lib/control-plane/plan';
import { createRun, findResumableRun } from '../lib/control-plane/store';
import { readOrCreateSessionId, withSessionCookie } from '../lib/mcp/session';

interface CreateRunBody {
  address?: unknown;
  request?: unknown;
}

// GET returns the session's most recent still-in-flight run (if any) — used
// by SilpoAgentService.resumeIfAny() on page load to pick back up a run that
// survived a reload (see lib/control-plane/store.ts's findResumableRun).
// POST starts a new control-plane run — just creates the journal row (status
// 'queued'). Nothing executes yet; the caller drives it forward one step at
// a time via POST /api/runs/[id]/advance.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method === 'GET') {
    try {
      const found = await findResumableRun(session.sessionId);
      if (!found) {
        return withSessionCookie(json({ run: null }, 200), session);
      }
      const next = planNext(found.run, found.steps);
      return withSessionCookie(
        json({ run: found.run, steps: found.steps, next: next.kind === 'done' ? null : next }, 200),
        session,
      );
    } catch (e) {
      return withSessionCookie(errorResponse(e), session);
    }
  }

  if (req.method !== 'POST') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  let body: CreateRunBody;
  try {
    body = await req.json();
  } catch {
    return withSessionCookie(json({ error: 'Invalid JSON body' }, 400), session);
  }

  if (typeof body.address !== 'string' || body.address.trim().length === 0) {
    return withSessionCookie(json({ error: 'address must be a non-empty string' }, 400), session);
  }
  if (typeof body.request !== 'string' || body.request.trim().length === 0) {
    return withSessionCookie(json({ error: 'request must be a non-empty string' }, 400), session);
  }

  try {
    const run = await createRun(session.sessionId, { address: body.address, request: body.request });
    return withSessionCookie(json({ run }, 201), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  }
}
