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
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { parseItemsWithClient, type ParsedItem, type Selector } from '../lib/agent/parse-items-core';
import { checkRelevanceWithClient } from '../lib/agent/check-relevance-core';
import { selectProduct, type SearchProduct } from '../lib/agent/pick-product';
import { printReport, type CaseCheck, type CaseResult } from './report';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'cases');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

interface PickExpectation {
  added: boolean;
  nameContains?: string;
  nameNotContains?: string;
  reason?: 'no_candidates' | 'not_relevant';
}

interface CaseExpectation {
  itemCount: number;
  type?: 'add' | 'replace';
  queryContains?: string;
  quantity?: number;
  selector?: Selector | null;
  fixture?: string;
  pick?: PickExpectation;
}

interface EvalCase {
  id: string;
  description: string;
  input: { request: string };
  expect: CaseExpectation;
}

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

async function runCase(client: Anthropic, evalCase: EvalCase): Promise<CaseResult> {
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

  const item = items[0];

  if (expect.type) {
    checks.push(check('type', item.type === expect.type, expect.type, item.type));
  }
  if (expect.queryContains) {
    const pass = item.query.toLowerCase().includes(expect.queryContains.toLowerCase());
    checks.push(check('query містить', pass, expect.queryContains, item.query));
  }
  if (expect.quantity !== undefined) {
    checks.push(check('quantity', item.quantity === expect.quantity, String(expect.quantity), String(item.quantity)));
  }
  if (expect.selector !== undefined) {
    const actualSelector = item.selector ?? null;
    checks.push(check('selector', actualSelector === expect.selector, String(expect.selector), String(actualSelector)));
  }

  if (expect.fixture && expect.pick) {
    const candidates = loadFixture(expect.fixture);
    let pickResult;
    try {
      pickResult = await selectProduct(candidates, item.selector, item.query, (q, name) =>
        checkRelevanceWithClient(client, q, name),
      );
    } catch (e) {
      return {
        id: evalCase.id,
        description: evalCase.description,
        pass: false,
        checks,
        error: e instanceof Error ? e.message : String(e),
      };
    }

    const wasAdded = pickResult.picked !== null;
    checks.push(check('товар додано', wasAdded === expect.pick.added, String(expect.pick.added), String(wasAdded)));

    if (expect.pick.added && pickResult.picked) {
      if (expect.pick.nameContains) {
        const pass = pickResult.picked.name.toLowerCase().includes(expect.pick.nameContains.toLowerCase());
        checks.push(check('назва містить', pass, expect.pick.nameContains, pickResult.picked.name));
      }
      if (expect.pick.nameNotContains) {
        const pass = !pickResult.picked.name.toLowerCase().includes(expect.pick.nameNotContains.toLowerCase());
        checks.push(check('назва НЕ містить', pass, `не ${expect.pick.nameNotContains}`, pickResult.picked.name));
      }
    }

    if (!expect.pick.added && expect.pick.reason) {
      checks.push(check('причина відмови', pickResult.reason === expect.pick.reason, expect.pick.reason, pickResult.reason));
    }
  }

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
    // Sequential, not Promise.all — these are real, rate-limited API calls;
    // no need to hammer them concurrently for a suite this size.
    results.push(await runCase(client, evalCase));
  }

  printReport(results);

  const failedCount = results.filter((r) => !r.pass).length;
  process.exit(failedCount === 0 ? 0 : 1);
}

main();
