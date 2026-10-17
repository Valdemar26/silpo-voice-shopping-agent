import { getRedis } from '../mcp/redis';
import { acquireLock, releaseLock } from '../redis-lock';
import type { Run, Step } from './types';

const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUNS_PER_SESSION = 50;
// The client's wait budget for a 409 "already being advanced" response
// (SilpoAgentService.drive()'s LOCK_WAIT_BUDGET_MS, 40s) MUST exceed this —
// otherwise, after a process genuinely dies mid-step, the client gives up
// before the lock it's waiting on actually expires. 30s comfortably covers
// the slowest step (setup_cart, a handful of MCP round-trips, ~2s normally)
// while still recovering quickly from a real crash.
const LOCK_TTL_SECONDS = 30;
// Runs older than this and still non-terminal are almost certainly
// abandoned (tab closed mid-run, never reopened) — findResumableRun below
// sweeps them into 'cancelled' instead of resurfacing them forever.
const RESUMABLE_MAX_AGE_MS = 30 * 60 * 1000;
const RESUMABLE_STATUSES = new Set<Run['status']>(['queued', 'running', 'waiting_approval']);

const runKey = (runId: string) => `cp:run:${runId}`;
const runStepsKey = (runId: string) => `cp:run:${runId}:steps`;
const sessionRunsKey = (sessionId: string) => `cp:session:${sessionId}:runs`;
const runLockKey = (runId: string) => `cp:run:${runId}:lock`;

export async function createRun(sessionId: string, input: Run['input']): Promise<Run> {
  const redis = getRedis();
  const now = Date.now();
  const run: Run = {
    id: crypto.randomUUID(),
    sessionId,
    status: 'queued',
    input,
    createdAt: now,
    updatedAt: now,
  };

  const sessionKey = sessionRunsKey(sessionId);
  await redis
    .multi()
    .set(runKey(run.id), run, { ex: TTL_SECONDS })
    .lpush(sessionKey, run.id)
    .ltrim(sessionKey, 0, MAX_RUNS_PER_SESSION - 1)
    .expire(sessionKey, TTL_SECONDS)
    .exec();

  return run;
}

export async function getRun(runId: string): Promise<Run | null> {
  return getRedis().get<Run>(runKey(runId));
}

export async function updateRun(
  runId: string,
  patch: Partial<Pick<Run, 'status' | 'currentStep' | 'error'>>,
): Promise<Run> {
  const redis = getRedis();
  const run = await getRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  const updated: Run = { ...run, ...patch, updatedAt: Date.now() };
  await redis.set(runKey(runId), updated, { ex: TTL_SECONDS });

  return updated;
}

export async function appendStep(step: Omit<Step, 'index'>): Promise<Step> {
  const redis = getRedis();
  const key = runStepsKey(step.runId);

  const length = await redis.rpush(key, step);
  await redis.expire(key, TTL_SECONDS);

  return { ...step, index: length - 1 };
}

export async function getRunWithSteps(runId: string): Promise<{ run: Run; steps: Step[] } | null> {
  const run = await getRun(runId);
  if (!run) return null;

  const rawSteps = await getRedis().lrange<Omit<Step, 'index'>>(runStepsKey(runId), 0, -1);
  const steps = rawSteps.map((step, index) => ({ ...step, index }));

  return { run, steps };
}

export async function listRuns(sessionId: string, limit = 20): Promise<Run[]> {
  const ids = await getRedis().lrange<string>(sessionRunsKey(sessionId), 0, limit - 1);
  if (ids.length === 0) return [];

  const redis = getRedis();
  const runs = await Promise.all(ids.map((id) => redis.get<Run>(runKey(id))));

  return runs.filter((run): run is Run => run !== null);
}

// Used on page load (SilpoAgentService.resumeIfAny(), via GET /api/runs) to
// pick back up a run that was still in flight when the tab was closed or
// reloaded. listRuns is already newest-first (lpush), so the first
// non-terminal, non-stale run encountered is the one to resume; any OTHER
// non-terminal run further back is expired along the way instead of being
// left to resurface indefinitely. 'failed' runs are deliberately excluded —
// they're not auto-resumed, just abandoned on reload (see plan notes).
export async function findResumableRun(sessionId: string): Promise<{ run: Run; steps: Step[] } | null> {
  const runs = await listRuns(sessionId);
  const now = Date.now();
  let resumable: Run | null = null;

  for (const run of runs) {
    if (!RESUMABLE_STATUSES.has(run.status)) continue;

    if (now - run.createdAt > RESUMABLE_MAX_AGE_MS) {
      await updateRun(run.id, { status: 'cancelled', error: 'expired' });
      continue;
    }

    if (!resumable) resumable = run;
  }

  return resumable ? getRunWithSteps(resumable.id) : null;
}

// lib/redis-lock.ts — a short-lived mutex so two concurrent /advance calls
// for the same run can't both execute a step at once.
export async function acquireRunLock(runId: string): Promise<string | null> {
  return acquireLock(runLockKey(runId), LOCK_TTL_SECONDS);
}

export async function releaseRunLock(runId: string, token: string): Promise<void> {
  await releaseLock(runLockKey(runId), token);
}
