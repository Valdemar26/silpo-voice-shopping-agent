// Pure journal -> UI-steps projection — no Angular, no fetch. Turns a
// control-plane Run + its journal (both already fetched by
// SilpoAgentService.run() via /api/runs and /api/runs/[id]/advance) into the
// flat AgentStep[] the steps panel renders (src/app/app.html), reproducing
// the exact trace SilpoAgentService.run() used to build by hand with
// addStep/updateStep before it moved onto the control-plane.
import type { CheckoutStatus } from '../agent/cart-state';
import type { ParsedItem, Selector } from '../agent/parse-items-core';
import type { CartSetupTraceEntry } from '../mcp/silpo-tools';
import type { CartWriteOutput, FinalizeOutput, NonTerminalDecision, ParseOutput, SelectProductOutput } from './plan';
import type { Run, Step } from './types';

export type StepStatus = 'running' | 'done' | 'error';

export interface AgentStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

// "молоко × 2" when the quantity is worth calling out, plain "хліб" for the
// common single-item case — avoids "× 1" noise on every trace line.
export function formatQuantityLabel(name: string, quantity: number): string {
  return quantity !== 1 ? `${name} × ${quantity}` : name;
}

// Same as formatQuantityLabel, plus a "(по акції)" tag when a selector was
// captured — used in the parse-step trace summary.
function formatItemLabel(query: string, quantity: number, selector?: Selector): string {
  const base = formatQuantityLabel(query, quantity);
  return selector === 'discount' ? `${base} (по акції)` : base;
}

// Shared by the real cart_write journal entry and its 'running' placeholder
// — a replace keeps its old-item/new-item framing instead of the generic
// "Додавання в кошик" label, same text the old combined replace step used to
// show, now just the label for an ordinary cart_write entry.
function cartWriteLabel(item: ParsedItem, name: string, quantity: number): string {
  const formatted = formatQuantityLabel(name, quantity);
  return item.type === 'replace' ? `Заміна: «${item.target}» → «${formatted}»` : `Додавання в кошик: «${formatted}»`;
}

function setupCartSteps(run: Run, step: Step): AgentStep[] {
  const label = `Налаштування кошика для адреси «${run.input.address}»`;
  if (step.status === 'failed') {
    return [{ id: 'setup-cart', label, status: 'error', detail: step.error }];
  }

  const output = step.output as { shoppingCartId: string; trace: CartSetupTraceEntry[] };
  const steps: AgentStep[] = [{ id: 'setup-cart', label, status: 'done', detail: `Кошик ${output.shoppingCartId}` }];
  output.trace.forEach((entry, i) => {
    steps.push({ id: `trace-${i}-${entry.step}`, label: entry.step, status: 'done', detail: entry.detail });
  });
  return steps;
}

function parseSteps(step: Step): AgentStep[] {
  if (step.status === 'failed') {
    return [{ id: 'parse-query', label: 'Розбір запиту', status: 'error', detail: step.error }];
  }

  const items = (step.output as ParseOutput).items;
  const detail =
    items.length > 0
      ? items
          .map((i) =>
            i.type === 'replace'
              ? `${i.target} → ${formatItemLabel(i.query, i.quantity, i.selector)}`
              : formatItemLabel(i.query, i.quantity, i.selector),
          )
          .join(', ')
      : 'Товарів не розпізнано';

  const steps: AgentStep[] = [{ id: 'parse-query', label: 'Розбір запиту', status: 'done', detail }];
  if (items.length === 0) {
    steps.push({
      id: 'no-items',
      label: 'Немає товарів для пошуку',
      status: 'error',
      detail: 'Не вдалося розпізнати жодного товару у фразі — спробуй сформулювати інакше',
    });
  }
  return steps;
}

function selectProductStep(step: Step): AgentStep {
  const decision = step.input as Extract<NonTerminalDecision, { kind: 'select_product' }>;
  const criterionSuffix = decision.item.selector === 'discount' ? ' (критерій: акція)' : '';
  const id = `search-${decision.item.query}`;
  const label = `Пошук: «${decision.item.query}»${criterionSuffix}`;

  if (step.status === 'failed') {
    return { id, label, status: 'error', detail: step.error };
  }

  const output = step.output as SelectProductOutput;
  return { id, label, status: output.picked === null ? 'error' : 'done', detail: output.detail };
}

function cartWriteStep(step: Step): AgentStep {
  const decision = step.input as Extract<NonTerminalDecision, { kind: 'cart_write' }>;

  if (step.status === 'failed') {
    return {
      id: `add-${decision.picked.id}`,
      label: cartWriteLabel(decision.item, decision.picked.name, decision.item.quantity),
      status: 'error',
      detail: step.error,
    };
  }

  const output = step.output as CartWriteOutput;
  return {
    id: `add-${output.productId}`,
    label: cartWriteLabel(decision.item, output.name, output.quantity),
    status: 'done',
  };
}

// Exact port of the old addCheckoutStatusStep (src/app/services/silpo-agent.ts)
// — every applicable blocking reason listed together, not just the first one
// found.
function checkoutStatusAgentStep(status: CheckoutStatus): AgentStep {
  const id = 'checkout-status';

  if (status.canCheckout) {
    const label = status.adultConfirmationRequired
      ? 'Кошик готовий до оформлення — знадобиться підтвердження повноліття на сторінці оформлення'
      : 'Кошик готовий до оформлення';
    return { id, label, status: 'done' };
  }

  const reasons: string[] = [];
  if (status.belowMinimum) reasons.push(`потрібно ще ${status.belowMinimum.remaining} ₴ до мінімальної суми`);
  if (status.stockExceeded.length > 0) {
    reasons.push(
      `недостатньо товару на складі: ${status.stockExceeded
        .map((i) => `«${i.name}» (у кошику ${i.quantity}, у наявності лише ${i.stock})`)
        .join('; ')}`,
    );
  }
  if (status.otherBlocked) reasons.push('є інша перешкода до оформлення');
  if (status.adultConfirmationRequired) reasons.push('знадобиться підтвердження повноліття на сторінці оформлення');

  if (reasons.length === 0) {
    return { id, label: 'Кошик поки недоступний до оформлення', status: 'done' };
  }

  return {
    id,
    label: `Кошик поки недоступний до оформлення — ${reasons.join('; ')}`,
    status: status.stockExceeded.length > 0 ? 'error' : 'done',
  };
}

function finalizeStep(step: Step): AgentStep {
  if (step.status === 'failed') {
    return { id: 'checkout-status', label: 'Не вдалося визначити статус оформлення', status: 'error', detail: step.error };
  }
  return checkoutStatusAgentStep((step.output as FinalizeOutput).checkoutStatus);
}

// The journal only ever holds already-finished entries (appendStep writes a
// step after it runs, never before) — so every row built above is 'done' or
// 'error', never 'running'. The one step still ahead of the client — what
// api/runs/[id]/advance.ts just (re-)planned as `next` — gets its own
// 'running' row here instead, reusing the id its real entry will use once
// it's done, so the steps panel (`@for (step of agent.steps(); track
// step.id)`) updates it in place rather than inserting a new row.
function nextAgentStep(run: Run, next: NonTerminalDecision): AgentStep {
  switch (next.kind) {
    case 'setup_cart':
      return { id: 'setup-cart', label: `Налаштування кошика для адреси «${run.input.address}»`, status: 'running' };
    case 'parse':
      return { id: 'parse-query', label: 'Розбір запиту', status: 'running' };
    case 'select_product': {
      const criterionSuffix = next.item.selector === 'discount' ? ' (критерій: акція)' : '';
      return { id: `search-${next.item.query}`, label: `Пошук: «${next.item.query}»${criterionSuffix}`, status: 'running' };
    }
    case 'cart_write':
      return {
        id: `add-${next.picked.id}`,
        label: cartWriteLabel(next.item, next.picked.name, next.item.quantity),
        status: 'running',
      };
    case 'finalize':
      return { id: 'checkout-status', label: 'Перевірка статусу оформлення', status: 'running' };
  }
}

export function journalToAgentSteps(run: Run, steps: Step[], next: NonTerminalDecision | null): AgentStep[] {
  const result: AgentStep[] = [];

  for (const step of steps) {
    switch (step.kind) {
      case 'setup_cart':
        result.push(...setupCartSteps(run, step));
        break;
      case 'parse':
        result.push(...parseSteps(step));
        break;
      case 'select_product':
        result.push(selectProductStep(step));
        break;
      case 'cart_write':
        result.push(cartWriteStep(step));
        break;
      case 'finalize':
        result.push(finalizeStep(step));
        break;
      case 'approval':
        // Not planned/executed anywhere yet (see lib/control-plane/plan.ts) —
        // nothing to render.
        break;
    }
  }

  if (next) {
    result.push(nextAgentStep(run, next));
  }

  return result;
}
