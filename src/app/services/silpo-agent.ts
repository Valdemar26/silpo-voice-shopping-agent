import { Injectable, inject, signal } from '@angular/core';
import { TtsService } from './tts';

export type StepStatus = 'running' | 'done' | 'error';

export interface AgentStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface CartProduct {
  productId: string;
  companyId: string;
  branchId: string;
  name?: string;
  image?: string;
  quantity: number;
  price?: number;
  stock?: number;
}

export interface CartValidation {
  level: string;
  type: string;
  message: string;
  context?: unknown;
}

interface ParsedItem {
  query: string;
  quantity: number;
}

export interface SilpoCart {
  id: string;
  deliveryType: string;
  timeslot: { start: string; end: string };
  shipments: Array<{ branchId: string; companyId: string; products: CartProduct[] }>;
  calculation: {
    total: number;
    totalAfterDiscounts: number;
    productsTotal: number;
    validations: CartValidation[];
  };
}

export interface CartState {
  shoppingCartId: string;
  cart: SilpoCart;
  // Sibling of `cart` in the real MCP response, not nested inside it —
  // confirmed against a live call. Present only once the cart clears
  // order.cost.min (and any other blocking validation).
  checkoutWebLink?: string;
}

@Injectable({ providedIn: 'root' })
export class SilpoAgentService {
  private readonly tts = inject(TtsService);

  readonly steps = signal<AgentStep[]>([]);
  readonly result = signal<CartState | null>(null);
  readonly running = signal(false);

  readonly removingProductIds = signal<ReadonlySet<string>>(new Set());
  readonly removeError = signal<string | null>(null);

  async run(address: string, request: string): Promise<void> {
    if (this.running()) return;

    this.running.set(true);
    this.steps.set([]);
    this.result.set(null);

    try {
      const cartState = await this.setupCart(address);
      if (!cartState) return;

      const queries = await this.parseSearchQueries(request);
      if (queries === null) return;
      if (queries.length === 0) {
        this.addStep({
          id: 'no-items',
          label: 'Немає товарів для пошуку',
          status: 'error',
          detail: 'Не вдалося розпізнати жодного товару у фразі — спробуй сформулювати інакше',
        });
        return;
      }

      let latest = cartState;
      for (const item of queries) {
        const product = await this.searchAndPickProduct(latest, item.query, item.quantity);
        if (!product) continue;

        const updated = await this.addProductToCart(latest.shoppingCartId, product);
        if (updated) latest = updated;
      }

      this.result.set(latest);
      this.addCheckoutStatusStep(latest);
      void this.tts.speak(this.buildSpokenSummary(latest));
    } finally {
      this.running.set(false);
    }
  }

  // Final, explicit outcome of the run — mirrors whatever the "Результат"
  // panel itself will show for the same cart state, computed once via
  // getCheckoutStatus() so the two can't drift apart again.
  private addCheckoutStatusStep(state: CartState): void {
    const id = 'checkout-status';
    const status = getCheckoutStatus(state);

    switch (status.kind) {
      case 'ready':
        this.addStep({ id, label: 'Кошик готовий до оформлення', status: 'done' });
        return;
      case 'below-minimum':
        this.addStep({ id, label: `Потрібно ще ${status.remaining} ₴ до мінімальної суми`, status: 'done' });
        return;
      case 'adult-confirmation-required':
        this.addStep({
          id,
          label: 'Кошик готовий до оформлення — знадобиться підтвердження повноліття на сторінці оформлення',
          status: 'done',
        });
        return;
      case 'blocked':
        this.addStep({ id, label: 'Кошик поки недоступний до оформлення', status: 'done' });
        return;
    }
  }

  // Removes a single product from the result panel's cart in place — no page
  // reload, no re-running the whole search pipeline. Independent of the
  // running/steps state above since it can happen well after a run finishes.
  async removeProduct(productId: string): Promise<void> {
    if (this.removingProductIds().has(productId)) return;

    this.removingProductIds.update((ids) => new Set(ids).add(productId));
    this.removeError.set(null);

    try {
      const response = await fetch('/api/mcp/cart/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [productId] }),
      });
      const data = await response.json();

      if (!response.ok) {
        this.removeError.set(data?.error ?? `HTTP ${response.status}`);
        return;
      }

      this.result.set({ shoppingCartId: data.shoppingCartId, cart: data.cart, checkoutWebLink: data.checkoutWebLink });
    } catch (e) {
      this.removeError.set(e instanceof Error ? e.message : 'Мережева помилка при видаленні товару');
    } finally {
      this.removingProductIds.update((ids) => {
        const next = new Set(ids);
        next.delete(productId);
        return next;
      });
    }
  }

  // Short spoken recap of the final cart state, read out over TTS once the
  // run finishes. Kept separate from the visible result panel, which always
  // renders regardless of whether the voice call succeeds.
  private buildSpokenSummary(state: CartState): string {
    const names = state.cart.shipments
      .flatMap((s) => s.products)
      .map((p) => p.name)
      .filter((n): n is string => !!n);

    if (names.length === 0) {
      return 'Нічого не знайшов. Кошик лишився порожнім.';
    }

    const total = Math.round(state.cart.calculation.totalAfterDiscounts);
    return `Знайшов ${joinWithI(names)}. Разом ${total} ${pluralizeHryvnia(total)}. Додав у кошик.`;
  }

  private addStep(step: AgentStep): void {
    this.steps.update((steps) => [...steps, step]);
  }

  private updateStep(id: string, patch: Partial<AgentStep>): void {
    this.steps.update((steps) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  // LLM step between free text and find_products_batch: a naive split on
  // separator words breaks on multi-word phrases (find_products_batch gets
  // one long sentence as a single query and returns 0 results), so this
  // hands the whole phrase to an LLM that returns concrete 1-2 word search
  // queries instead — resolving vague categories ("смаколики" -> "цукерки")
  // and dropping selection criteria ("по акції") rather than asking for
  // clarification. Visible as its own trace step for the same transparency
  // reason as every other step here.
  private async parseSearchQueries(request: string): Promise<ParsedItem[] | null> {
    const id = 'parse-query';
    this.addStep({ id, label: 'Розбір запиту', status: 'running' });

    const body = await this.postJson<{ items: ParsedItem[] }>('/api/agent/parse-items', { text: request }, id);
    if (!body) return null;

    const items = body.items
      .map((i) => ({ query: i.query.trim(), quantity: Math.max(1, Math.round(i.quantity)) }))
      .filter((i) => i.query.length > 0);

    this.updateStep(id, {
      status: 'done',
      detail: items.length > 0 ? items.map((i) => formatQuantityLabel(i.query, i.quantity)).join(', ') : 'Товарів не розпізнано',
    });

    return items;
  }

  private async postJson<T>(url: string, body: unknown, stepId: string): Promise<T | null> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok) {
        this.updateStep(stepId, { status: 'error', detail: data?.error ?? `HTTP ${response.status}` });
        return null;
      }

      return data as T;
    } catch (e) {
      this.updateStep(stepId, { status: 'error', detail: e instanceof Error ? e.message : 'Мережева помилка' });
      return null;
    }
  }

  private async setupCart(address: string): Promise<CartState | null> {
    const id = 'setup-cart';
    this.addStep({ id, label: `Налаштування кошика для адреси «${address}»`, status: 'running' });

    const body = await this.postJson<{
      shoppingCartId: string;
      cart: SilpoCart;
      checkoutWebLink?: string;
      trace: Array<{ step: string; detail: string }>;
    }>('/api/mcp/cart/create', { address }, id);
    if (!body) return null;

    this.updateStep(id, { status: 'done', detail: `Кошик ${body.shoppingCartId}` });

    // Surface the server's own find_address -> ... -> create_shopping_cart
    // trace as its own sub-steps instead of hiding it behind one summary line.
    body.trace.forEach((entry, i) => {
      this.addStep({ id: `trace-${i}-${entry.step}`, label: entry.step, status: 'done', detail: entry.detail });
    });

    return { shoppingCartId: body.shoppingCartId, cart: body.cart, checkoutWebLink: body.checkoutWebLink };
  }

  private async searchAndPickProduct(cartState: CartState, query: string, quantity: number): Promise<CartProduct | null> {
    const id = `search-${query}`;
    this.addStep({ id, label: `Пошук: «${query}»`, status: 'running' });

    interface SearchProduct {
      id: string;
      name: string;
      price: number;
      stock: number;
      image: string;
      companyId: string;
      branchId: string;
    }
    const body = await this.postJson<{ queries: Array<{ products: SearchProduct[] }> }>(
      '/api/mcp/products/search',
      { products: [query], limit: 5 },
      id,
    );
    if (!body) return null;

    const found = body.queries[0]?.products[0];
    if (!found) {
      this.updateStep(id, { status: 'error', detail: 'Нічого не знайдено' });
      return null;
    }

    this.updateStep(id, { status: 'done', detail: `${found.name} — ${found.price} ₴ (залишок: ${found.stock})` });

    return {
      productId: found.id,
      companyId: found.companyId,
      branchId: found.branchId,
      name: found.name,
      image: found.image,
      quantity,
      price: found.price,
      stock: found.stock,
    };
  }

  private async addProductToCart(shoppingCartId: string, product: CartProduct): Promise<CartState | null> {
    const id = `add-${product.productId}`;
    const label = formatQuantityLabel(product.name ?? 'товар', product.quantity);
    this.addStep({ id, label: `Додавання в кошик: «${label}»`, status: 'running' });

    const body = await this.postJson<{ shoppingCartId: string; cart: SilpoCart; checkoutWebLink?: string }>(
      '/api/mcp/cart/items',
      {
        products: [
          {
            productId: product.productId,
            companyId: product.companyId,
            branchId: product.branchId,
            quantity: product.quantity,
            addQuantity: true,
          },
        ],
      },
      id,
    );
    if (!body) return null;

    this.updateStep(id, { status: 'done' });
    return { shoppingCartId: body.shoppingCartId, cart: body.cart, checkoutWebLink: body.checkoutWebLink };
  }
}

// Reads the minimum order cost straight from validations[] — not a
// guessed/hardcoded threshold.
function getOrderCostMin(validations: CartValidation[]): number | null {
  const validation = validations.find((v) => v.message === 'order.cost.min');
  const context = validation?.context as { orderCostMin?: unknown } | undefined;
  return typeof context?.orderCostMin === 'number' ? context.orderCostMin : null;
}

export type CheckoutStatus =
  | { kind: 'ready' }
  | { kind: 'below-minimum'; remaining: number; percent: number }
  | { kind: 'adult-confirmation-required' }
  | { kind: 'blocked' };

// Single source of truth for "can this cart be checked out right now", used
// by both the trace step and the result panel — they'd drifted apart before:
// the button showed on checkoutWebLink presence alone, ignoring any other
// error-level validation (e.g. order.adult.is_not_confirmed, found on an
// alcohol order) that was still sitting in validations[].
//
// order.adult.is_not_confirmed specifically does NOT block checkoutWebLink —
// Silpo asks for age confirmation on the checkout page itself — so that one
// case still shows the button, plus an explicit note. Any other error-level
// validation is treated conservatively as blocking, since it hasn't been
// verified that checkoutWebLink stays usable through it.
export function getCheckoutStatus(state: CartState): CheckoutStatus {
  const validations = state.cart.calculation.validations;

  const orderCostMin = getOrderCostMin(validations);
  if (orderCostMin !== null) {
    const total = state.cart.calculation.totalAfterDiscounts;
    const remaining = Math.max(0, Math.ceil(orderCostMin - total));
    const percent = orderCostMin > 0 ? Math.min(100, Math.max(0, (total / orderCostMin) * 100)) : 0;
    return { kind: 'below-minimum', remaining, percent };
  }

  const hasAdultIssue = validations.some((v) => v.message === 'order.adult.is_not_confirmed');
  const hasOtherError = validations.some((v) => v.level === 'error' && v.message !== 'order.adult.is_not_confirmed');

  if (state.checkoutWebLink && !hasOtherError) {
    return hasAdultIssue ? { kind: 'adult-confirmation-required' } : { kind: 'ready' };
  }

  return { kind: 'blocked' };
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

// "молоко × 2" when the quantity is worth calling out, plain "хліб" for the
// common single-item case — avoids "× 1" noise on every trace line.
function formatQuantityLabel(name: string, quantity: number): string {
  return quantity !== 1 ? `${name} × ${quantity}` : name;
}

function joinWithI(items: string[]): string {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} і ${items[items.length - 1]}`;
}

// Ukrainian grammatical number agreement for "гривня" (1 гривня, 2 гривні, 5 гривень, ...).
function pluralizeHryvnia(amount: number): string {
  const mod100 = Math.abs(amount) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return 'гривень';
  if (mod10 === 1) return 'гривня';
  if (mod10 >= 2 && mod10 <= 4) return 'гривні';
  return 'гривень';
}
