import { Injectable, signal } from '@angular/core';

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

      const queries = this.parseItemQueries(request);
      if (queries.length === 0) {
        this.addStep({
          id: 'no-items',
          label: 'Немає товарів для пошуку',
          status: 'error',
          detail: 'Введи хоча б один товар у полі "Що потрібно"',
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
    } finally {
      this.running.set(false);
    }
  }

  private addStep(step: AgentStep): void {
    this.steps.update((steps) => [...steps, step]);
  }

  private updateStep(id: string, patch: Partial<AgentStep>): void {
    this.steps.update((steps) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  // Crude stand-in for the future LLM parse step: split free text into
  // separate search terms. Good enough to exercise the pipeline end to end.
  private parseItemQueries(request: string): string[] {
    return request
      .split(/[,;\n]| і | та | й /giu)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
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
