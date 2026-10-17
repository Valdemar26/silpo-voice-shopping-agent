export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { planNext } from '../../../lib/control-plane/plan';
import { acquireRunLock, getRunWithSteps, releaseRunLock, updateRun } from '../../../lib/control-plane/store';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

const MAX_RETRIES_PER_STEP = 3;

// .../api/runs/<id>/retry — id is the second-to-last path segment, same
// convention as advance.ts/approve.ts.
function runIdFromPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2];
}

// Clears a failed run's status so the next POST /api/runs/[id]/advance
// re-plans and re-executes the same (kind, itemKey) decision — planNext only
// ever looks at succeeded steps (lib/control-plane/plan.ts), so the failed
// entry already sitting in the journal is simply invisible to it. Nothing
// here touches the journal itself, only the run's own status/error.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'POST') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  const runId = runIdFromPath(req);

  const precheck = await getRunWithSteps(runId);
  if (!precheck || precheck.run.sessionId !== session.sessionId) {
    return withSessionCookie(json({ error: 'Run not found' }, 404), session);
  }

  const lockToken = await acquireRunLock(runId);
  if (!lockToken) {
    return withSessionCookie(json({ error: 'Run is already being advanced' }, 409), session);
  }

  try {
    const current = await getRunWithSteps(runId);
    if (!current) {
      return withSessionCookie(json({ error: 'Run not found' }, 404), session);
    }

    if (current.run.status !== 'failed') {
      return withSessionCookie(json({ error: 'Run is not failed' }, 409), session);
    }

    const lastStep = current.steps[current.steps.length - 1];
    if (!lastStep || lastStep.status !== 'failed') {
      // Defensive — status said 'failed' but the journal disagrees.
      return withSessionCookie(json({ error: 'Run is not failed' }, 409), session);
    }

    const priorFailures = current.steps.filter(
      (s) => s.kind === lastStep.kind && s.itemKey === lastStep.itemKey && s.status === 'failed',
    ).length;
    if (priorFailures >= MAX_RETRIES_PER_STEP) {
      return withSessionCookie(json({ error: 'retry limit reached' }, 409), session);
    }

    // The journal is unchanged, so this deterministically re-derives the
    // exact same decision that just failed.
    const next = planNext(current.run, current.steps);

    if (next.kind === 'done') {
      const updatedRun = await updateRun(runId, { status: 'succeeded', error: undefined, currentStep: undefined });
      return withSessionCookie(json({ run: updatedRun, steps: current.steps, next: null }, 200), session);
    }

    const updatedRun = await updateRun(runId, {
      status: next.kind === 'approval' ? 'waiting_approval' : 'running',
      error: undefined,
      currentStep: next.kind,
    });
    return withSessionCookie(json({ run: updatedRun, steps: current.steps, next }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  } finally {
    await releaseRunLock(runId, lockToken);
  }
}
