import { Injectable, inject, signal } from '@angular/core';
import { TtsService } from './tts';
import { type SearchProduct } from '../../../lib/agent/pick-product';
import {
  getCheckoutStatus,
  type CartProduct,
  type CartState,
  type CheckoutStatus,
  type SilpoCart,
  type StockExceededItem,
} from '../../../lib/agent/cart-state';
import { journalToAgentSteps, type AgentStep, type StepStatus } from '../../../lib/control-plane/journal-to-steps';
import type { FinalizeOutput, NonTerminalDecision, SelectProductOutput } from '../../../lib/control-plane/plan';
import type { Run, Step } from '../../../lib/control-plane/types';

export type { StepStatus, AgentStep };
export type { SearchProduct, CartProduct, CartState, CheckoutStatus, SilpoCart, StockExceededItem };
export { getCheckoutStatus };

interface AdvanceResponse {
  run: Run;
  steps: Step[];
  next: NonTerminalDecision | null;
}

const MAX_ADVANCE_ATTEMPTS = 50;
const LOCK_RETRY_DELAY_MS = 500;
const TERMINAL_RUN_STATUSES = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable({ providedIn: 'root' })
export class SilpoAgentService {
  private readonly tts = inject(TtsService);

  readonly steps = signal<AgentStep[]>([]);
  readonly result = signal<CartState | null>(null);
  readonly running = signal(false);

  // Set once any API call comes back with { code: 'reauth_required' } (the
  // stored Silpo session is unrecoverably dead — see lib/mcp/oauth.ts's
  // ReauthRequiredError) — prompts the user to go through /api/mcp/auth/login
  // again instead of silently failing every subsequent call.
  readonly reauthRequired = signal(false);

  readonly removingProductIds = signal<ReadonlySet<string>>(new Set());
  readonly removeError = signal<string | null>(null);

  // Every candidate returned for a selector:"discount" search, keyed by each
  // candidate's own id -> the whole group (same array reference for every
  // member). Never reset between runs, same as the cart itself — a product
  // added three runs ago should still show its alternatives today. Look-up
  // is always by "whichever id is currently in the cart", so it keeps working
  // after switchToAlternative() changes which member that is.
  readonly discountAlternatives = signal<ReadonlyMap<string, SearchProduct[]>>(new Map());

  readonly switchingProductIds = signal<ReadonlySet<string>>(new Set());
  readonly switchError = signal<string | null>(null);

  readonly clearingCart = signal(false);
  readonly clearCartError = signal<string | null>(null);

  // Drives the run entirely through the server control-plane
  // (lib/control-plane/{plan,execute,store}.ts via /api/runs +
  // /api/runs/[id]/advance) instead of calling /api/mcp/*/api/agent/*
  // directly — this method just creates the run, polls it to completion, and
  // projects each response onto steps()/result()/discountAlternatives() via
  // the pure journalToAgentSteps (lib/control-plane/journal-to-steps.ts).
  async run(address: string, request: string): Promise<void> {
    if (this.running()) return;

    this.running.set(true);
    this.steps.set([]);
    this.result.set(null);

    try {
      const run = await this.createRun(address, request);
      if (!run) return;

      // Running placeholder for setup_cart before the first advance() call
      // even goes out — same spirit as the old addStep(...status:'running')
      // call that used to precede each network request.
      this.steps.set(journalToAgentSteps(run, [], { kind: 'setup_cart' }));

      let current: AdvanceResponse | null = null;

      for (let attempt = 0; attempt < MAX_ADVANCE_ATTEMPTS; attempt++) {
        let response: Response;
        try {
          response = await fetch(`/api/runs/${run.id}/advance`, { method: 'POST' });
        } catch (e) {
          this.addAdvanceErrorStep('Мережева помилка під час виконання запуску', e);
          return;
        }

        // Another advance() for this run is already in flight (e.g. a stray
        // retry) — the lock is short-lived, so just wait it out instead of
        // treating it as a real failure.
        if (response.status === 409) {
          await sleep(LOCK_RETRY_DELAY_MS);
          continue;
        }

        let data: unknown;
        try {
          data = await response.json();
        } catch (e) {
          this.addAdvanceErrorStep('Невалідна відповідь сервера під час виконання запуску', e);
          return;
        }

        if (!response.ok) {
          this.flagReauthIfNeeded(data);
          this.addAdvanceErrorStep(
            'Не вдалося продовжити виконання запуску',
            (data as { error?: string } | null)?.error ?? `HTTP ${response.status}`,
          );
          return;
        }

        current = data as AdvanceResponse;
        this.steps.set(journalToAgentSteps(current.run, current.steps, current.next));

        if (current.steps.some((s) => s.errorCode === 'reauth_required')) {
          this.reauthRequired.set(true);
        }

        if (TERMINAL_RUN_STATUSES.has(current.run.status)) break;
      }

      if (!current || !TERMINAL_RUN_STATUSES.has(current.run.status)) {
        this.addAdvanceErrorStep('Перевищено ліміт спроб виконання запуску');
        return;
      }

      // 'failed'/'cancelled' — the failing step's own error is already
      // visible via steps(); nothing else to surface here.
      if (current.run.status !== 'succeeded') return;

      const finalizeStep = current.steps.find((s) => s.kind === 'finalize' && s.status === 'succeeded');
      if (!finalizeStep) return;

      const output = finalizeStep.output as FinalizeOutput;
      this.result.set(output.cartState);
      void this.tts.speak(output.spokenSummary);

      for (const step of current.steps) {
        if (step.kind !== 'select_product' || step.status !== 'succeeded') continue;
        const selectOutput = step.output as SelectProductOutput;
        const decision = step.input as Extract<NonTerminalDecision, { kind: 'select_product' }>;
        // Registered regardless of the final reason — a price-anomaly pick
        // that later fails the relevance check should still expose its
        // alternatives, same behavior as before this moved server-side.
        if (selectOutput.anomalyDetected || decision.item.selector === 'discount') {
          this.registerDiscountAlternatives(selectOutput.candidates);
        }
      }
    } finally {
      this.running.set(false);
    }
  }

  private async createRun(address: string, request: string): Promise<Run | null> {
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, request }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.flagReauthIfNeeded(data);
        this.addAdvanceErrorStep('Не вдалося розпочати виконання запуску', data?.error ?? `HTTP ${response.status}`);
        return null;
      }

      return data.run as Run;
    } catch (e) {
      this.addAdvanceErrorStep('Мережева помилка при створенні запуску', e);
      return null;
    }
  }

  // One-off synthetic step for failures that happen outside the journal
  // itself (network errors, lock-retry exhaustion, a non-OK HTTP response) —
  // the journal-derived rows from journalToAgentSteps already cover every
  // in-journal failure.
  private addAdvanceErrorStep(label: string, detail?: unknown): void {
    this.addStep({
      id: 'advance-error',
      label,
      status: 'error',
      detail: typeof detail === 'string' ? detail : detail instanceof Error ? detail.message : undefined,
    });
  }

  // Removes a single product from the result panel's cart in place — no page
  // reload, no re-running the whole search pipeline. Independent of the
  // running/steps state above since it can happen well after a run finishes.
  async removeProduct(productId: string): Promise<void> {
    if (this.removingProductIds().has(productId)) return;

    this.removingProductIds.update((ids) => new Set(ids).add(productId));
    this.removeError.set(null);

    const result = await this.deleteCartItemsRequest([productId]);
    if ('error' in result) {
      this.removeError.set(result.error);
    } else {
      this.result.set(result);
    }

    this.removingProductIds.update((ids) => {
      const next = new Set(ids);
      next.delete(productId);
      return next;
    });
  }

  // Swap one cart line for one of its stored discount alternatives — the
  // exact candidate the user clicked, not a re-search. Same quiet
  // delete-then-add pattern as removeProduct (no trace step, reports via its
  // own switching/error signals), since this also happens well after run()
  // finished.
  async switchToAlternative(currentProductId: string, alternative: SearchProduct, quantity: number): Promise<void> {
    if (this.switchingProductIds().has(currentProductId)) return;

    this.switchingProductIds.update((ids) => new Set(ids).add(currentProductId));
    this.switchError.set(null);

    const removed = await this.deleteCartItemsRequest([currentProductId]);
    if ('error' in removed) {
      this.switchError.set(removed.error);
    } else {
      const added = await this.addCartItemsRequest(removed.shoppingCartId, [
        {
          productId: alternative.id,
          companyId: alternative.companyId,
          branchId: alternative.branchId,
          quantity,
          addQuantity: false,
        },
      ]);
      if ('error' in added) {
        this.switchError.set(added.error);
        // The old line is already gone server-side — reflect that instead of
        // silently leaving the panel showing a product no longer in the cart.
        this.result.set(removed);
      } else {
        this.result.set(added);
      }
    }

    this.switchingProductIds.update((ids) => {
      const next = new Set(ids);
      next.delete(currentProductId);
      return next;
    });
  }

  // Empties the whole cart via /api/mcp/cart/clear — a deliberate, destructive
  // action gated behind its own confirmation in the UI, unlike removeProduct.
  // Returns whether it succeeded so the caller can show a one-off "done"
  // message without needing a dedicated success signal here.
  async clearCart(): Promise<boolean> {
    if (this.clearingCart()) return false;

    this.clearingCart.set(true);
    this.clearCartError.set(null);

    try {
      const response = await fetch('/api/mcp/cart/clear', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        this.flagReauthIfNeeded(data);
        this.clearCartError.set(data?.error ?? `HTTP ${response.status}`);
        return false;
      }

      this.result.set(null);
      return true;
    } catch (e) {
      this.clearCartError.set(e instanceof Error ? e.message : 'Мережева помилка при очищенні кошика');
      return false;
    } finally {
      this.clearingCart.set(false);
    }
  }

  // Shared by removeProduct() (standalone ✕ button, reports via
  // removeError/result signals) and switchToAlternative() above — same
  // DELETE call either way.
  private async deleteCartItemsRequest(
    productIds: string[],
  ): Promise<CartState | { error: string }> {
    try {
      const response = await fetch('/api/mcp/cart/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.flagReauthIfNeeded(data);
        return { error: data?.error ?? `HTTP ${response.status}` };
      }

      return { shoppingCartId: data.shoppingCartId, cart: data.cart, checkoutWebLink: data.checkoutWebLink };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Мережева помилка при видаленні товару' };
    }
  }

  // Quiet counterpart to deleteCartItemsRequest, used by switchToAlternative.
  private async addCartItemsRequest(
    shoppingCartId: string,
    products: Array<{ productId: string; companyId: string; branchId: string; quantity: number; addQuantity?: boolean }>,
  ): Promise<CartState | { error: string }> {
    try {
      const response = await fetch('/api/mcp/cart/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ products }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.flagReauthIfNeeded(data);
        return { error: data?.error ?? `HTTP ${response.status}` };
      }

      return { shoppingCartId: data.shoppingCartId, cart: data.cart, checkoutWebLink: data.checkoutWebLink };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Мережева помилка при додаванні товару' };
    }
  }

  private addStep(step: AgentStep): void {
    this.steps.update((steps) => [...steps, step]);
  }

  // Marks the stored Silpo session as unrecoverably dead so the template can
  // offer a way back in — see ReauthRequiredError in lib/mcp/oauth.ts and its
  // { code: 'reauth_required' } mapping in lib/mcp/http.ts.
  private flagReauthIfNeeded(data: unknown): void {
    if (typeof data === 'object' && data !== null && (data as { code?: unknown }).code === 'reauth_required') {
      this.reauthRequired.set(true);
    }
  }

  // Every candidate is registered — including the one that was actually
  // picked — pointing at the same array. That makes look-up by "whichever id
  // is currently in the cart" work no matter which member that ends up being,
  // now or after a later switchToAlternative() swap.
  private registerDiscountAlternatives(candidates: SearchProduct[]): void {
    if (candidates.length <= 1) return;
    this.discountAlternatives.update((map) => {
      const next = new Map(map);
      for (const c of candidates) next.set(c.id, candidates);
      return next;
    });
  }
}

// Short text for the "Поділитися замовленням" action — the person sharing
// isn't necessarily the one paying, so it needs to stand alone with the
// items, total, and a link, not just say "done, check the app".
export function buildShareText(state: CartState): string {
  const names = state.cart.shipments
    .flatMap((s) => s.products)
    .map((p) => p.name)
    .filter((n): n is string => !!n);

  const itemsList = names.length > 0 ? names.join(', ') : 'товари';
  const total = Math.round(state.cart.calculation.totalAfterDiscounts);
  const link = state.checkoutWebLink ? ` Оформити: ${state.checkoutWebLink}` : '';

  return `Зібрав кошик у Сільпо: ${itemsList}, разом ${total}₴.${link}`;
}
