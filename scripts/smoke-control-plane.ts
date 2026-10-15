// Manual smoke test against the real Upstash instance — run with:
//   npx tsx --env-file=.env.local scripts/smoke-control-plane.ts
// Not run automatically; it talks to live Redis and cleans up its own keys.
import { getRedis } from '../lib/mcp/redis';
import { createRun, getRun, updateRun, appendStep, getRunWithSteps, listRuns } from '../lib/control-plane/store';
import type { Run } from '../lib/control-plane/types';

const SESSION_ID = 'smoke-test';

async function main(): Promise<void> {
  let run: Run | undefined;

  try {
    run = await createRun(SESSION_ID, { address: 'вул. Хрещатик 1', request: 'молоко і хліб' });
    console.log('createRun:', run);

    const fetched = await getRun(run.id);
    console.log('getRun:', fetched);

    const running = await updateRun(run.id, { status: 'running', currentStep: 'parse' });
    console.log('updateRun:', running);

    const now = Date.now();
    await appendStep({
      runId: run.id,
      kind: 'parse',
      status: 'succeeded',
      attempt: 1,
      input: { text: 'молоко і хліб' },
      output: { items: ['молоко', 'хліб'] },
      toolCalls: [],
      llm: [{ model: 'claude-sonnet-5', inputTokens: 120, outputTokens: 40 }],
      startedAt: now,
      finishedAt: now + 500,
    });

    await appendStep({
      runId: run.id,
      kind: 'select_product',
      status: 'succeeded',
      attempt: 1,
      itemKey: 'молоко',
      input: { query: 'молоко' },
      output: { productId: 'abc123' },
      toolCalls: [{ name: 'find_products_batch', ok: true, durationMs: 230 }],
      startedAt: now + 500,
      finishedAt: now + 900,
    });

    const result = await getRunWithSteps(run.id);
    console.log('getRunWithSteps:', JSON.stringify(result, null, 2));

    const sessionRuns = await listRuns(SESSION_ID);
    console.log('listRuns:', sessionRuns);
  } finally {
    if (run) {
      const redis = getRedis();
      await redis.del(`cp:run:${run.id}`);
      await redis.del(`cp:run:${run.id}:steps`);
      await redis.del(`cp:session:${SESSION_ID}:runs`);
      console.log('cleaned up keys for run', run.id);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
