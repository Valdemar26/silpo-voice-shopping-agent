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

export function printReport(results: CaseResult[]): void {
  const passed = results.filter((r) => r.pass);
  const failed = results.filter((r) => !r.pass);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`EVAL RESULTS: ${passed.length}/${results.length} passed`);
  console.log('='.repeat(60));

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
