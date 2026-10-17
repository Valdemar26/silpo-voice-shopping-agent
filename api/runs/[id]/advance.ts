export const config = { runtime: 'edge' };

import Anthropic from '@anthropic-ai/sdk';
import { errorResponse, json } from '../../../lib/mcp/http';
import { executeStep, type ExecuteContext } from '../../../lib/control-plane/execute';
import { planNext } from '../../../lib/control-plane/plan';
import { acquireRunLock, appendStep, getRunWithSteps, releaseRunLock, updateRun } from '../../../lib/control-plane/store';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

// .../api/runs/<id>/advance — id is the second-to-last path segment. Parsed
// from the URL directly rather than relied on via a platform query-param
// convention — see the same comment in api/runs/[id]/index.ts.
function runIdFromPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2];
}

// Executes exactly one control-plane step and appends it to the journal.
// Approval and crash-recovery are out of scope here — a 'failed' run just
// sits there until something else (not built yet) decides to retry it.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'POST') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  const runId = runIdFromPath(req);

  // Only for the session/existence check — a 404 for the wrong session or a
  // missing run doesn't need the lock. The journal itself is re-read below,
  // under the lock, and that re-read copy is the only one planNext/executeStep
  // ever see.
  const precheck = await getRunWithSteps(runId);
  if (!precheck || precheck.run.sessionId !== session.sessionId) {
    return withSessionCookie(json({ error: 'Run not found' }, 404), session);
  }

  const lockToken = await acquireRunLock(runId);
  if (!lockToken) {
    return withSessionCookie(json({ error: 'Run is already being advanced' }, 409), session);
  }

  try {
    // Re-read after acquiring the lock: a concurrent advance() that ran
    // between the precheck above and this lock could have appended a step
    // and changed the run's status, so the precheck copy may already be
    // stale. Planning against it would risk re-executing a step another
    // request already completed.
    const current = await getRunWithSteps(runId);
    if (!current) {
      return withSessionCookie(json({ error: 'Run not found' }, 404), session);
    }

    if (TERMINAL_STATUSES.has(current.run.status)) {
      return withSessionCookie(json({ run: current.run, steps: current.steps, next: null }, 200), session);
    }

    const decision = planNext(current.run, current.steps);

    if (decision.kind === 'done') {
      const updatedRun = await updateRun(runId, { status: 'succeeded', currentStep: undefined });
      return withSessionCookie(json({ run: updatedRun, steps: current.steps, next: null }, 200), session);
    }

    // Intermediate write for the duration of the execution below — visible
    // only to a concurrent GET /api/runs/[id] while this request is in
    // flight. The response this request itself returns is recomputed fresh
    // from the journal after appendStep, below.
    await updateRun(runId, { status: 'running', currentStep: decision.kind });

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const ctx: ExecuteContext = {
      sessionId: session.sessionId,
      anthropicClient: apiKey ? new Anthropic({ apiKey }) : undefined,
    };

    const newStepData = await executeStep(current.run, current.steps, decision, ctx);
    const newStep = await appendStep(newStepData);
    const allSteps = [...current.steps, newStep];

    if (newStep.status === 'failed') {
      const updatedRun = await updateRun(runId, { status: 'failed', error: newStep.error, currentStep: undefined });
      return withSessionCookie(json({ run: updatedRun, steps: allSteps, next: null }, 200), session);
    }

    // currentStep now means "what will run on the NEXT advance() call", not
    // "what just finished" — a step is only appended to the journal after it
    // completes, so the journal's own last entry is always already done; the
    // client needs this re-planned decision to render a 'running' placeholder
    // for the step that's actually still ahead of it (see
    // lib/control-plane/journal-to-steps.ts).
    const next = planNext(current.run, allSteps);

    if (next.kind === 'done') {
      const updatedRun = await updateRun(runId, { status: 'succeeded', currentStep: undefined });
      return withSessionCookie(json({ run: updatedRun, steps: allSteps, next: null }, 200), session);
    }

    const updatedRun = await updateRun(runId, { status: 'running', currentStep: next.kind });
    return withSessionCookie(json({ run: updatedRun, steps: allSteps, next }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  } finally {
    await releaseRunLock(runId, lockToken);
  }
}
