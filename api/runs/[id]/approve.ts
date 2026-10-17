export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { planNext } from '../../../lib/control-plane/plan';
import { acquireRunLock, appendStep, getRunWithSteps, releaseRunLock, updateRun } from '../../../lib/control-plane/store';
import type { Step } from '../../../lib/control-plane/types';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

// .../api/runs/<id>/approve — id is the second-to-last path segment, same
// convention as api/runs/[id]/advance.ts and api/runs/[id]/index.ts.
function runIdFromPath(req: Request): string {
  const segments = new URL(req.url).pathname.split('/').filter(Boolean);
  return segments[segments.length - 2];
}

interface ApproveBody {
  approved?: unknown;
  approvedItemKeys?: unknown;
}

// Resolves the one pending 'approval' decision a run can be waiting on —
// appends its outcome to the journal and resumes (or cancels) the run.
// Never executes anything itself; the next POST /api/runs/[id]/advance
// picks up from there (see lib/control-plane/plan.ts's planNext).
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

  let body: ApproveBody;
  try {
    body = await req.json();
  } catch {
    return withSessionCookie(json({ error: 'Invalid JSON body' }, 400), session);
  }
  if (typeof body.approved !== 'boolean') {
    return withSessionCookie(json({ error: 'approved must be a boolean' }, 400), session);
  }
  const requestedKeys = Array.isArray(body.approvedItemKeys)
    ? body.approvedItemKeys.filter((k): k is string => typeof k === 'string')
    : [];

  // Same lock as advance.ts, same runId — a concurrent advance()/approve()
  // for this run can't interleave with this one.
  const lockToken = await acquireRunLock(runId);
  if (!lockToken) {
    return withSessionCookie(json({ error: 'Run is already being advanced' }, 409), session);
  }

  try {
    const current = await getRunWithSteps(runId);
    if (!current) {
      return withSessionCookie(json({ error: 'Run not found' }, 404), session);
    }

    // Re-checked under the lock — guards against a double click (or a race
    // with a concurrent approve()) resolving the same approval twice.
    if (current.run.status !== 'waiting_approval') {
      return withSessionCookie(json({ error: 'Run is not waiting for approval' }, 409), session);
    }

    const decision = planNext(current.run, current.steps);
    if (decision.kind !== 'approval') {
      // Defensive — status said waiting_approval but the journal disagrees.
      return withSessionCookie(json({ error: 'Run is not waiting for approval' }, 409), session);
    }

    const validKeys = new Set(decision.items.map((i) => i.itemKey));
    const approvedItemKeys = requestedKeys.filter((k) => validKeys.has(k));
    // An empty approved list is the same outcome as an outright rejection —
    // there's nothing left to write to the cart either way.
    const approved = body.approved === true && approvedItemKeys.length > 0;

    const attempt = current.steps.filter((s) => s.kind === 'approval').length + 1;
    const now = Date.now();
    const newStepData: Omit<Step, 'index'> = {
      runId,
      kind: 'approval',
      status: 'succeeded',
      attempt,
      input: decision,
      output: { approved, approvedItemKeys: approved ? approvedItemKeys : [] },
      toolCalls: [],
      startedAt: now,
      finishedAt: now,
    };
    const newStep = await appendStep(newStepData);
    const allSteps = [...current.steps, newStep];

    const updatedRun = await updateRun(runId, {
      status: approved ? 'running' : 'cancelled',
      currentStep: undefined,
    });

    if (!approved) {
      return withSessionCookie(json({ run: updatedRun, steps: allSteps, next: null }, 200), session);
    }

    const next = planNext(updatedRun, allSteps);
    return withSessionCookie(
      json({ run: updatedRun, steps: allSteps, next: next.kind === 'done' ? null : next }, 200),
      session,
    );
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  } finally {
    await releaseRunLock(runId, lockToken);
  }
}
