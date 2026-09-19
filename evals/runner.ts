// Eval harness for the voice-request pipeline: free text -> parseItems (live
// Anthropic call, real production prompt) -> selectProduct against a frozen
// find_products_batch fixture (no live MCP dependency, so a case doesn't
// break when a product falls out of the catalog) -> checkRelevance (live
// Anthropic call, real production prompt) for whichever candidate that picks.
//
// Both LLM steps are real, live calls — that's deliberate: the whole point
// is evaluating LLM quality, not asserting against a canned mock of it. Only
// the catalog search (find_products_batch) is frozen, since that's Silpo's
// live inventory, not what's under test here.
//
// A second, separate case kind ("checkout-status") tests getCheckoutStatus
// (src/app/services/silpo-agent.ts) directly against a synthetic CartState —
// pure function, no LLM call, no cart. That function is exported at module
// level (unlike e.g. findCartProductByTarget, a private method on
// SilpoAgentService not reachable from here) — this harness only calls it,
// it does not modify its logic.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { parseItemsWithClient, type ParsedItem, type Selector } from '../lib/agent/parse-items-core';
import { checkRelevanceWithClient } from '../lib/agent/check-relevance-core';
import { selectProduct, type SearchProduct } from '../lib/agent/pick-product';
import { getCheckoutStatus, type CartState } from '../src/app/services/silpo-agent';
import { printReport, type CaseCheck, type CaseResult } from './report';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'cases');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface PickExpectation {
  added: boolean;
  nameContains?: string;
  nameNotContains?: string;
  reason?: 'no_candidates' | 'not_relevant';
  // Substring expected in PickOutcome.detail (case-insensitive) — for cases
  // where a criterion is satisfied by falling back rather than truly met
  // (e.g. selector:"discount" with no discounted candidate at all), so the
  // trace explicitly says the criterion wasn't met instead of silently
  // behaving as if there'd been no criterion.
  detailContains?: string;
  // Expected value of PickOutcome.anomalyDetected — the outlier-price guard
  // (pick-product.ts) firing or not.
  anomalyDetected?: boolean;
}

// Shape of one parsed item's expectations — used both for the top-level
// fields (item[0], kept for backward compatibility with existing single-item
// cases) and per-entry in expect.items[] (new multi-item cases).
interface ItemExpectation {
  type?: 'add' | 'replace';
  queryContains?: string;
  // Only meaningful when type is "replace" — checked against item.target.
  targetContains?: string;
  quantity?: number;
  selector?: Selector | null;
  fixture?: string;
  pick?: PickExpectation;
}

interface CaseExpectation extends ItemExpectation {
  itemCount: number;
  // When present, checks each parsed item against its own expectation by
  // index instead of only checking item[0] via the fields above.
  items?: ItemExpectation[];
}

interface PipelineEvalCase {
  id: string;
  kind?: 'pipeline';
  description: string;
  input: { request: string };
  expect: CaseExpectation;
}

interface CheckoutCaseExpectation {
  canCheckout: boolean;
  // null expects CheckoutStatus.belowMinimum === null; a number expects
  // belowMinimum !== null && belowMinimum.remaining === that number.
  belowMinimum: number | null;
  adultConfirmationRequired: boolean;
  stockExceededCount: number;
  stockExceededFirst?: { name: string; stock: number; quantity: number };
  otherBlocked: boolean;
}

interface CheckoutEvalCase {
  id: string;
  kind: 'checkout-status';
  description: string;
  input: { cartState: CartState };
  expect: CheckoutCaseExpectation;
}

type EvalCase = PipelineEvalCase | CheckoutEvalCase;

function loadCases(): EvalCase[] {
  return fs
    .readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf-8')) as EvalCase);
}

function loadFixture(name: string): SearchProduct[] {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, `${name}.json`), 'utf-8'));
  return raw.candidates as SearchProduct[];
}

function check(label: string, pass: boolean, expected: string, actual: string): CaseCheck {
  return { label, pass, expected, actual };
}

// Checks one parsed item against its expectation, pushing onto `checks`.
// Shared between the single-item (backward-compatible) path and the
// multi-item expect.items[] path — `prefix` labels checks so a multi-item
// case's report shows which position failed (e.g. "[1] quantity").
async function checkItemExpectation(
  client: Anthropic,
  prefix: string,
  item: ParsedItem,
  itemExpect: ItemExpectation,
  checks: CaseCheck[],
): Promise<void> {
  if (itemExpect.type) {
    checks.push(check(`${prefix}type`, item.type === itemExpect.type, itemExpect.type, item.type));
  }
  if (itemExpect.queryContains) {
    const pass = item.query.toLowerCase().includes(itemExpect.queryContains.toLowerCase());
    checks.push(check(`${prefix}query містить`, pass, itemExpect.queryContains, item.query));
  }
  if (itemExpect.targetContains) {
    const targetVal = item.type === 'replace' ? item.target : '(не replace)';
    const pass = item.type === 'replace' && item.target.toLowerCase().includes(itemExpect.targetContains.toLowerCase());
    checks.push(check(`${prefix}target містить`, pass, itemExpect.targetContains, targetVal));
  }
  if (itemExpect.quantity !== undefined) {
    checks.push(check(`${prefix}quantity`, item.quantity === itemExpect.quantity, String(itemExpect.quantity), String(item.quantity)));
  }
  if (itemExpect.selector !== undefined) {
    const actualSelector = item.selector ?? null;
    checks.push(check(`${prefix}selector`, actualSelector === itemExpect.selector, String(itemExpect.selector), String(actualSelector)));
  }

  if (itemExpect.fixture && itemExpect.pick) {
    const candidates = loadFixture(itemExpect.fixture);
    const pickResult = await selectProduct(candidates, item.selector, item.query, (q, name) =>
      checkRelevanceWithClient(client, q, name),
    );

    const wasAdded = pickResult.picked !== null;
    checks.push(check(`${prefix}товар додано`, wasAdded === itemExpect.pick.added, String(itemExpect.pick.added), String(wasAdded)));

    if (itemExpect.pick.added && pickResult.picked) {
      if (itemExpect.pick.nameContains) {
        const pass = pickResult.picked.name.toLowerCase().includes(itemExpect.pick.nameContains.toLowerCase());
        checks.push(check(`${prefix}назва містить`, pass, itemExpect.pick.nameContains, pickResult.picked.name));
      }
      if (itemExpect.pick.nameNotContains) {
        const pass = !pickResult.picked.name.toLowerCase().includes(itemExpect.pick.nameNotContains.toLowerCase());
        checks.push(check(`${prefix}назва НЕ містить`, pass, `не ${itemExpect.pick.nameNotContains}`, pickResult.picked.name));
      }
    }

    if (!itemExpect.pick.added && itemExpect.pick.reason) {
      checks.push(check(`${prefix}причина відмови`, pickResult.reason === itemExpect.pick.reason, itemExpect.pick.reason, pickResult.reason));
    }

    if (itemExpect.pick.detailContains) {
      const pass = pickResult.detail.toLowerCase().includes(itemExpect.pick.detailContains.toLowerCase());
      checks.push(check(`${prefix}деталь містить`, pass, itemExpect.pick.detailContains, pickResult.detail));
    }

    if (itemExpect.pick.anomalyDetected !== undefined) {
      checks.push(
        check(
          `${prefix}аномалія виявлена`,
          pickResult.anomalyDetected === itemExpect.pick.anomalyDetected,
          String(itemExpect.pick.anomalyDetected),
          String(pickResult.anomalyDetected),
        ),
      );
    }
  }
}

async function runPipelineCase(client: Anthropic, evalCase: PipelineEvalCase): Promise<CaseResult> {
  const checks: CaseCheck[] = [];

  let items: ParsedItem[];
  try {
    items = await parseItemsWithClient(client, evalCase.input.request);
  } catch (e) {
    return {
      id: evalCase.id,
      description: evalCase.description,
      pass: false,
      checks: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const { expect } = evalCase;

  checks.push(check('кількість items', items.length === expect.itemCount, String(expect.itemCount), String(items.length)));

  // Nothing further to check for the empty-request case, or if item count
  // already mismatched (indexing items[0] wouldn't be meaningful).
  if (expect.itemCount === 0 || items.length === 0) {
    const pass = checks.every((c) => c.pass);
    return { id: evalCase.id, description: evalCase.description, pass, checks };
  }

  try {
    if (expect.items) {
      const n = Math.min(items.length, expect.items.length);
      for (let i = 0; i < n; i++) {
        await checkItemExpectation(client, `[${i}] `, items[i], expect.items[i], checks);
      }
    } else {
      await checkItemExpectation(client, '', items[0], expect, checks);
    }
  } catch (e) {
    return {
      id: evalCase.id,
      description: evalCase.description,
      pass: false,
      checks,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const pass = checks.every((c) => c.pass);
  return { id: evalCase.id, description: evalCase.description, pass, checks };
}

// Pure, synchronous, no LLM call — getCheckoutStatus is a plain function of
// CartState. Only exercises it from the outside, per the eval's mandate not
// to touch mainline logic.
function runCheckoutCase(evalCase: CheckoutEvalCase): CaseResult {
  const checks: CaseCheck[] = [];
  const { expect } = evalCase;

  const status = getCheckoutStatus(evalCase.input.cartState);

  checks.push(check('canCheckout', status.canCheckout === expect.canCheckout, String(expect.canCheckout), String(status.canCheckout)));

  if (expect.belowMinimum === null) {
    checks.push(check('belowMinimum', status.belowMinimum === null, 'null', JSON.stringify(status.belowMinimum)));
  } else {
    const actual = status.belowMinimum?.remaining ?? null;
    checks.push(check('belowMinimum.remaining', actual === expect.belowMinimum, String(expect.belowMinimum), String(actual)));
  }

  checks.push(
    check(
      'adultConfirmationRequired',
      status.adultConfirmationRequired === expect.adultConfirmationRequired,
      String(expect.adultConfirmationRequired),
      String(status.adultConfirmationRequired),
    ),
  );

  checks.push(
    check(
      'stockExceeded.length',
      status.stockExceeded.length === expect.stockExceededCount,
      String(expect.stockExceededCount),
      String(status.stockExceeded.length),
    ),
  );

  if (expect.stockExceededFirst) {
    const first = status.stockExceeded[0];
    const actual = first ? `${first.name} (stock=${first.stock}, quantity=${first.quantity})` : '(none)';
    const expected = `${expect.stockExceededFirst.name} (stock=${expect.stockExceededFirst.stock}, quantity=${expect.stockExceededFirst.quantity})`;
    const pass =
      !!first &&
      first.name === expect.stockExceededFirst.name &&
      first.stock === expect.stockExceededFirst.stock &&
      first.quantity === expect.stockExceededFirst.quantity;
    checks.push(check('stockExceeded[0]', pass, expected, actual));
  }

  checks.push(check('otherBlocked', status.otherBlocked === expect.otherBlocked, String(expect.otherBlocked), String(status.otherBlocked)));

  const pass = checks.every((c) => c.pass);
  return { id: evalCase.id, description: evalCase.description, pass, checks };
}

async function main(): Promise<void> {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));

  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set (expected in .env.local)');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  const cases = loadCases();

  console.log(`Running ${cases.length} eval case(s)...`);

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    if (evalCase.kind === 'checkout-status') {
      // Pure/sync, no rate limit concern — still run in the same sequential
      // loop for simple, deterministic ordering in the report.
      results.push(runCheckoutCase(evalCase));
    } else {
      // Sequential, not Promise.all — these are real, rate-limited API calls;
      // no need to hammer them concurrently for a suite this size.
      results.push(await runPipelineCase(client, evalCase));
    }
  }

  printReport(results);

  const failedCount = results.filter((r) => !r.pass).length;
  process.exit(failedCount === 0 ? 0 : 1);
}

main();
