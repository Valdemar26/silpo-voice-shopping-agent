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
  // Not yet returned by any endpoint — no checkout/order-placement flow exists
  // yet. Kept optional so the UI has somewhere to show it once that lands.
  checkoutWebLink?: string;
}

export interface CartState {
  shoppingCartId: string;
  cart: SilpoCart;
}

@Injectable({ providedIn: 'root' })
export class SilpoAgentService {
  private readonly tts = inject(TtsService);

  readonly steps = signal<AgentStep[]>([]);
  readonly result = signal<CartState | null>(null);
  readonly running = signal(false);

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
      for (const query of queries) {
        const product = await this.searchAndPickProduct(latest, query);
        if (!product) continue;

        const updated = await this.addProductToCart(latest.shoppingCartId, product);
        if (updated) latest = updated;
      }

      this.result.set(latest);
      void this.tts.speak(this.buildSpokenSummary(latest));
    } finally {
      this.running.set(false);
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
  private async parseSearchQueries(request: string): Promise<string[] | null> {
    const id = 'parse-query';
    this.addStep({ id, label: 'Розбір запиту', status: 'running' });

    const body = await this.postJson<{ items: string[] }>('/api/agent/parse-items', { text: request }, id);
    if (!body) return null;

    const items = body.items.map((s) => s.trim()).filter((s) => s.length > 0);
    this.updateStep(id, {
      status: 'done',
      detail: items.length > 0 ? items.join(', ') : 'Товарів не розпізнано',
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

    const body = await this.postJson<{ shoppingCartId: string; cart: SilpoCart; trace: Array<{ step: string; detail: string }> }>(
      '/api/mcp/cart/create',
      { address },
      id,
    );
    if (!body) return null;

    this.updateStep(id, { status: 'done', detail: `Кошик ${body.shoppingCartId}` });

    // Surface the server's own find_address -> ... -> create_shopping_cart
    // trace as its own sub-steps instead of hiding it behind one summary line.
    body.trace.forEach((entry, i) => {
      this.addStep({ id: `trace-${i}-${entry.step}`, label: entry.step, status: 'done', detail: entry.detail });
    });

    return { shoppingCartId: body.shoppingCartId, cart: body.cart };
  }

  private async searchAndPickProduct(cartState: CartState, query: string): Promise<CartProduct | null> {
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
      quantity: 1,
      price: found.price,
      stock: found.stock,
    };
  }

  private async addProductToCart(shoppingCartId: string, product: CartProduct): Promise<CartState | null> {
    const id = `add-${product.productId}`;
    this.addStep({ id, label: `Додавання в кошик: «${product.name}»`, status: 'running' });

    const body = await this.postJson<{ shoppingCartId: string; cart: SilpoCart }>(
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
    return { shoppingCartId: body.shoppingCartId, cart: body.cart };
  }
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
