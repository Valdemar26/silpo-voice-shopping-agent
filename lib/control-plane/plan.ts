// Pure control-plane planner — no network calls, no I/O. Looks only at
// succeeded steps in the journal (a failed attempt is invisible to it, so a
// retry of the same step is simply "not done yet" from this function's point
// of view) and decides what runs next. Mirrors the step order of the
// existing SilpoAgentService.run() (src/app/services/silpo-agent.ts):
// setup_cart -> parse -> select_product (per parsed item) -> cart_write (per
// item whose select_product picked something) -> finalize -> done.
import type { ParsedItem } from '../agent/parse-items-core';
import type { SearchProduct } from '../agent/pick-product';
import type { Run, Step, StepKind } from './types';

export interface ParseOutput {
  items: ParsedItem[];
}

export interface SelectProductOutput {
  picked: SearchProduct | null;
  reason: 'no_candidates' | 'not_relevant' | 'ok';
  detail: string;
}

// itemKey = index of the parsed item + its query, e.g. "0:молоко" — shared
// between planNext and executeStep so both identify the same logical item
// the same way across retries.
export function makeItemKey(index: number, query: string): string {
  return `${index}:${query}`;
}

export type PlanDecision =
  | { kind: 'setup_cart' }
  | { kind: 'parse' }
  | { kind: 'select_product'; index: number; itemKey: string; item: ParsedItem }
  | { kind: 'cart_write'; index: number; itemKey: string; item: ParsedItem; picked: SearchProduct }
  | { kind: 'finalize' }
  | { kind: 'done' };

export function planNext(run: Run, steps: Step[]): PlanDecision {
  const succeeded = steps.filter((s) => s.status === 'succeeded');
  const find = (kind: StepKind) => succeeded.find((s) => s.kind === kind);
  const findByItemKey = (kind: StepKind, itemKey: string) =>
    succeeded.find((s) => s.kind === kind && s.itemKey === itemKey);

  if (!find('setup_cart')) return { kind: 'setup_cart' };

  const parseStep = find('parse');
  if (!parseStep) return { kind: 'parse' };

  const items = (parseStep.output as ParseOutput).items;

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const itemKey = makeItemKey(index, item.query);
    if (!findByItemKey('select_product', itemKey)) {
      return { kind: 'select_product', index, itemKey, item };
    }
  }

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const itemKey = makeItemKey(index, item.query);
    const selectStep = findByItemKey('select_product', itemKey);
    const picked = (selectStep?.output as SelectProductOutput | undefined)?.picked ?? null;
    if (picked === null) continue;

    if (!findByItemKey('cart_write', itemKey)) {
      return { kind: 'cart_write', index, itemKey, item, picked };
    }
  }

  if (!find('finalize')) return { kind: 'finalize' };

  return { kind: 'done' };
}
