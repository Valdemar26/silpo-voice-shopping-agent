// Console pass/fail report for evals/runner.ts — kept separate from the
// runner so the report format can change without touching how cases run.

export interface CaseCheck {
  label: string;
  pass: boolean;
  expected: string;
  actual: string;
}

export interface CaseResult {
  id: string;
  description: string;
  pass: boolean;
  checks: CaseCheck[];
  // Set when the case couldn't even run (e.g. a live API call threw) —
  // distinct from a normal failed check.
  error?: string;
}

// Derives a category label from a case id for the grouped summary below —
// no field on the case JSON itself, so existing case files never need
// touching when this grouping changes. Ordered: first matching rule wins,
// since some ids would otherwise match more than one (e.g.
// "13-replace-discount-bread-to-milk" contains both "replace" and
// "discount" — it's fundamentally a replace-flow case, so that rule must be
// checked first).
const CATEGORY_RULES: Array<{ match: RegExp; category: string }> = [
  { match: /^\d+-checkout-/, category: 'checkout-status' },
  { match: /^\d+-replace-/, category: 'replace' },
  { match: /pizza/, category: 'no-candidates' },
  { match: /discount/, category: 'discount' },
  { match: /anomaly/, category: 'anomaly-price' },
  { match: /qty-|multi-/, category: 'quantity' },
  { match: /regression|relevance|buckwheat|pudding|raspberry|malina/, category: 'relevance-guard' },
  { match: /empty-no-product/, category: 'empty-request' },
  { match: /stt-/, category: 'stt-edge' },
];

function categoryOf(id: string): string {
  return CATEGORY_RULES.find((rule) => rule.match.test(id))?.category ?? 'basic-add';
}

function printCategorySummary(results: CaseResult[]): void {
  const byCategory = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const category = categoryOf(r.id);
    const entry = byCategory.get(category) ?? { passed: 0, total: 0 };
    entry.total += 1;
    if (r.pass) entry.passed += 1;
    byCategory.set(category, entry);
  }

  console.log('\nПо категоріях:');
  for (const [category, { passed, total }] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const icon = passed === total ? '✓' : '✗';
    console.log(`  ${icon} ${category}: ${passed}/${total}`);
  }
}

export function printReport(results: CaseResult[]): void {
  const passed = results.filter((r) => r.pass);
  const failed = results.filter((r) => !r.pass);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`EVAL RESULTS: ${passed.length}/${results.length} passed`);
  console.log('='.repeat(60));

  printCategorySummary(results);

  for (const r of results) {
    const icon = r.pass ? '✓' : '✗';
    console.log(`\n${icon} ${r.id} — ${r.description}`);

    if (r.error) {
      console.log(`  ПОМИЛКА ВИКОНАННЯ: ${r.error}`);
      continue;
    }

    for (const c of r.checks) {
      if (c.pass) continue;
      console.log(`  ✗ ${c.label}`);
      console.log(`      очікувалось: ${c.expected}`);
      console.log(`      отримано:    ${c.actual}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  if (failed.length === 0) {
    console.log(`Усі ${results.length} кейсів пройшли.`);
  } else {
    console.log(`${failed.length}/${results.length} кейсів провалились: ${failed.map((r) => r.id).join(', ')}`);
  }
  console.log('='.repeat(60) + '\n');
}
