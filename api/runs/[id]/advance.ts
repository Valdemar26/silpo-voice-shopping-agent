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

  const existing = await getRunWithSteps(runId);
  if (!existing || existing.run.sessionId !== session.sessionId) {
    return withSessionCookie(json({ error: 'Run not found' }, 404), session);
  }

  if (TERMINAL_STATUSES.has(existing.run.status)) {
    return withSessionCookie(json(existing, 200), session);
  }

  const locked = await acquireRunLock(runId);
  if (!locked) {
    return withSessionCookie(json({ error: 'Run is already being advanced' }, 409), session);
  }

  try {
    const decision = planNext(existing.run, existing.steps);

    // Already fully planned out with nothing left to do — finalize's own
    // success (below) is what actually flips the run to 'succeeded', so
    // reaching 'done' here on a non-terminal run is only a defensive
    // fallback (e.g. a run whose last advance crashed between appendStep and
    // updateRun).
    if (decision.kind === 'done') {
      return withSessionCookie(json(existing, 200), session);
    }

    await updateRun(runId, { status: 'running', currentStep: decision.kind });

    const apiKey = process.env['ANTHROPIC_API_KEY'];
    const ctx: ExecuteContext = {
      sessionId: session.sessionId,
      anthropicClient: apiKey ? new Anthropic({ apiKey }) : undefined,
    };

    const newStepData = await executeStep(existing.run, existing.steps, decision, ctx);
    const newStep = await appendStep(newStepData);

    const updatedRun =
      newStep.status === 'failed'
        ? await updateRun(runId, { status: 'failed', error: newStep.error })
        : newStep.kind === 'finalize'
          ? await updateRun(runId, { status: 'succeeded', currentStep: undefined })
          : await updateRun(runId, { status: 'running', currentStep: newStep.kind });

    return withSessionCookie(json({ run: updatedRun, steps: [...existing.steps, newStep] }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  } finally {
    await releaseRunLock(runId);
  }
}
