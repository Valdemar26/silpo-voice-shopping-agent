// Pure control-plane planner — no network calls, no I/O. Looks only at
// succeeded steps in the journal (a failed attempt is invisible to it, so a
// retry of the same step is simply "not done yet" from this function's point
// of view) and decides what runs next. Mirrors the step order of the
// existing SilpoAgentService.run() (src/app/services/silpo-agent.ts):
// setup_cart -> parse -> select_product (per parsed item) -> cart_write (per
// item whose select_product picked something) -> finalize -> done.
import type { CartState, CheckoutStatus } from '../agent/cart-state';
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
  // Every candidate find_products_batch returned for this query, regardless
  // of outcome — the client builds its discount-alternatives list from this
  // (see SilpoAgentService.registerDiscountAlternatives), same data
  // searchAndPickProduct used to register directly.
  candidates: SearchProduct[];
  // True when the price-anomaly fallback in selectProduct fired — mirrors
  // PickOutcome.anomalyDetected (lib/agent/pick-product.ts).
  anomalyDetected: boolean;
}

export interface ApprovalItem {
  itemKey: string;
  name: string;
  quantity: number;
  price: number;
  type: 'add' | 'replace';
  // Only for type: 'replace' — the name of the cart line this item would
  // remove, so the approval panel shows that half of the action too, not
  // just what gets added.
  target?: string;
}

export interface ApprovalOutput {
  approved: boolean;
  approvedItemKeys: string[];
}

export interface CartWriteOutput {
  shoppingCartId: string;
  productId: string;
  name: string;
  quantity: number;
  price: number;
  // Total product count across all shipments after this write — informational,
  // not currently read by the client, but cheap to expose alongside the rest
  // of the summary instead of the full (possibly large) CartState.
  itemsInCart: number;
}

export interface FinalizeOutput {
  cartState: CartState;
  checkoutStatus: CheckoutStatus;
  // Built server-side via lib/agent/spoken-summary.ts's buildSpokenSummary —
  // the client just hands this straight to TtsService.speak().
  spokenSummary: string;
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
  | { kind: 'approval'; items: ApprovalItem[] }
  | { kind: 'cart_write'; index: number; itemKey: string; item: ParsedItem; picked: SearchProduct }
  | { kind: 'finalize' }
  | { kind: 'done' };

// What api/runs/[id]/advance.ts's `next` field and
// lib/control-plane/journal-to-steps.ts's running placeholder actually deal
// in — 'done' never reaches either of them (the route resolves it straight
// to a terminal run status and sends `next: null` instead).
export type NonTerminalDecision = Exclude<PlanDecision, { kind: 'done' }>;

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

  // Every item has gone through select_product by this point — collect the
  // ones that actually found something to add/replace. An item whose pick
  // came back null never reaches cart_write or the approval list below.
  const pickedEntries: Array<{ index: number; itemKey: string; item: ParsedItem; picked: SearchProduct }> = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const itemKey = makeItemKey(index, item.query);
    const selectStep = findByItemKey('select_product', itemKey);
    const picked = (selectStep?.output as SelectProductOutput | undefined)?.picked ?? null;
    if (picked !== null) pickedEntries.push({ index, itemKey, item, picked });
  }

  if (pickedEntries.length > 0) {
    const approvalStep = find('approval');

    if (!approvalStep) {
      return {
        kind: 'approval',
        items: pickedEntries.map((e) => ({
          itemKey: e.itemKey,
          name: e.picked.name,
          quantity: e.item.quantity,
          price: e.picked.price,
          type: e.item.type,
          target: e.item.type === 'replace' ? e.item.target : undefined,
        })),
      };
    }

    const approvalOutput = approvalStep.output as ApprovalOutput;
    if (!approvalOutput.approved) {
      // Rejected — nothing more to do. In the live system the run is
      // already 'cancelled' and terminal by the time anyone calls
      // planNext again (see api/runs/[id]/approve.ts), so this mostly
      // matters for planNext's own correctness/tests.
      return { kind: 'done' };
    }

    const approvedKeys = new Set(approvalOutput.approvedItemKeys);
    for (const e of pickedEntries) {
      if (!approvedKeys.has(e.itemKey)) continue;
      if (!findByItemKey('cart_write', e.itemKey)) {
        return { kind: 'cart_write', index: e.index, itemKey: e.itemKey, item: e.item, picked: e.picked };
      }
    }
  }

  if (!find('finalize')) return { kind: 'finalize' };

  return { kind: 'done' };
}
