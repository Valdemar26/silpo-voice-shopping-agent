import { getRedis } from '../mcp/redis';
import type { Run, Step } from './types';

const TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUNS_PER_SESSION = 50;

const runKey = (runId: string) => `cp:run:${runId}`;
const runStepsKey = (runId: string) => `cp:run:${runId}:steps`;
const sessionRunsKey = (sessionId: string) => `cp:session:${sessionId}:runs`;

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
