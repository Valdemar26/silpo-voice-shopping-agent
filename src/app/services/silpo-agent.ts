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

// Only 'discount' is implemented — see searchAndPickProduct/pickBySelector
// below. Other criteria the LLM might recognize are still dropped there.
type Selector = 'discount';

// Shape returned by silpo_find_products_batch (via /api/mcp/products/search).
// oldPrice/specialPrices confirmed against a live search response — oldPrice
// is the pre-discount price (null when not discounted), specialPrices is a
// list of quantity-break prices (e.g. "76.90 ₴ from 2 pcs", null otherwise).
export interface SearchProduct {
  id: string;
  name: string;
  price: number;
  stock: number;
  image: string;
  companyId: string;
  branchId: string;
  oldPrice?: number | null;
  specialPrices?: Array<{ price: number; count: number; type: string }> | null;
}

type ParsedItem =
  | { type: 'add'; query: string; quantity: number; selector?: Selector }
  | { type: 'replace'; target: string; query: string; quantity: number; selector?: Selector };

// One product actually added to the cart during a single run() call — used to
// scope the spoken summary to just this run instead of the cart's whole
// (possibly older) contents. price is the unit price as returned by search,
// same semantics as CartProduct.price.
interface AddedItem {
  name: string;
  quantity: number;
  price: number;
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

  // Every candidate returned for a selector:"discount" search, keyed by each
  // candidate's own id -> the whole group (same array reference for every
  // member). Never reset between runs, same as the cart itself — a product
  // added three runs ago should still show its alternatives today. Look-up
  // is always by "whichever id is currently in the cart", so it keeps working
  // after switchToAlternative() changes which member that is.
  readonly discountAlternatives = signal<ReadonlyMap<string, SearchProduct[]>>(new Map());

  readonly switchingProductIds = signal<ReadonlySet<string>>(new Set());
  readonly switchError = signal<string | null>(null);

  async run(address: string, request: string): Promise<void> {
    if (this.running()) return;

    this.running.set(true);
    this.steps.set([]);
    this.result.set(null);

    try {
      const cartState = await this.setupCart(address);
      if (!cartState) return;

      // Captured before this run adds anything — totalAfterDiscounts always
      // carries a delivery fee on top of the products themselves (99 ₴ even
      // on a fully empty cart), so newItemsTotal vs grandTotal would almost
      // never come out equal even on a genuinely first run; whether the cart
      // had anything in it needs its own direct check instead.
      const hadItemsBefore = cartState.cart.shipments.some((s) => s.products.length > 0);

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
      const addedItems: AddedItem[] = [];
      for (const item of queries) {
        if (item.type === 'replace') {
          const { state, added } = await this.replaceProductInCart(
            latest,
            item.target,
            item.query,
            item.quantity,
            item.selector,
          );
          if (state) latest = state;
          if (added) addedItems.push(added);
          continue;
        }

        const product = await this.searchAndPickProduct(latest, item.query, item.quantity, item.selector);
        if (!product) continue;

        const updated = await this.addProductToCart(latest.shoppingCartId, product);
        if (updated) {
          latest = updated;
          addedItems.push({ name: product.name ?? item.query, quantity: product.quantity, price: product.price ?? 0 });
        }
      }

      this.result.set(latest);
      this.addCheckoutStatusStep(latest);
      void this.tts.speak(this.buildSpokenSummary(latest, addedItems, hadItemsBefore));
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

  // Shared by removeProduct() (standalone ✕ button, reports via
  // removeError/result signals) and replaceProductInCart() below (mid-run,
  // reports via its own trace step) — same DELETE call either way.
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
        return { error: data?.error ?? `HTTP ${response.status}` };
      }

      return { shoppingCartId: data.shoppingCartId, cart: data.cart, checkoutWebLink: data.checkoutWebLink };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Мережева помилка при видаленні товару' };
    }
  }

  // Quiet counterpart to deleteCartItemsRequest, used by switchToAlternative
  // — addProductToCart below does the same POST but also manages its own
  // trace step, which a post-run interaction like this shouldn't add.
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
        return { error: data?.error ?? `HTTP ${response.status}` };
      }

      return { shoppingCartId: data.shoppingCartId, cart: data.cart, checkoutWebLink: data.checkoutWebLink };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Мережева помилка при додаванні товару' };
    }
  }

  // Finds the cart product a spoken "target" phrase (e.g. "кеш'ю") is meant
  // to refer to. Deliberately the simplest possible match — a substring check
  // against the product name, falling back to any shared significant word —
  // not a "similarity"/fuzzy-match algorithm.
  private findCartProductByTarget(cartState: CartState, target: string): CartProduct | null {
    const products = cartState.cart.shipments.flatMap((s) => s.products);
    const normalizedTarget = target.trim().toLowerCase();
    if (normalizedTarget.length === 0) return null;

    const substringMatch = products.find((p) => p.name?.toLowerCase().includes(normalizedTarget));
    if (substringMatch) return substringMatch;

    const targetWords = normalizedTarget.split(/\s+/).filter((w) => w.length > 2);
    return products.find((p) => {
      const name = p.name?.toLowerCase() ?? '';
      return targetWords.some((w) => name.includes(w));
    }) ?? null;
  }

  // Voice "replace" flow: find the existing product matching `target` in the
  // cart, remove it, then search+add `query` in its place. Every outcome
  // (target not found, delete failed, new product not found, add failed) gets
  // its own explicit trace detail instead of silently skipping the item —
  // same transparency principle as the rest of the pipeline.
  private async replaceProductInCart(
    cartState: CartState,
    target: string,
    query: string,
    quantity: number,
    selector?: Selector,
  ): Promise<{ state: CartState | null; added: AddedItem | null }> {
    const id = `replace-${target}-${query}`;
    this.addStep({ id, label: `Заміна: «${target}» → пошук «${query}»`, status: 'running' });

    const existing = this.findCartProductByTarget(cartState, target);
    if (!existing) {
      this.updateStep(id, { status: 'error', detail: `Не знайшов «${target}» у вашому кошику для заміни` });
      return { state: null, added: null };
    }
    const existingLabel = existing.name ?? target;

    const removed = await this.deleteCartItemsRequest([existing.productId]);
    if ('error' in removed) {
      this.updateStep(id, { status: 'error', detail: `Не вдалося видалити «${existingLabel}»: ${removed.error}` });
      return { state: null, added: null };
    }

    const product = await this.searchAndPickProduct(removed, query, quantity, selector);
    if (!product) {
      this.updateStep(id, {
        status: 'error',
        detail: `Видалив «${existingLabel}», але нічого не знайшов за запитом «${query}»`,
      });
      return { state: removed, added: null };
    }

    const updated = await this.addProductToCart(removed.shoppingCartId, product);
    if (!updated) {
      this.updateStep(id, {
        status: 'error',
        detail: `Видалив «${existingLabel}», знайшов «${product.name}», але не вдалося додати в кошик`,
      });
      return { state: removed, added: null };
    }

    this.updateStep(id, {
      status: 'done',
      detail: `«${existingLabel}» → «${formatQuantityLabel(product.name ?? query, product.quantity)}»`,
    });
    return {
      state: updated,
      added: { name: product.name ?? query, quantity: product.quantity, price: product.price ?? 0 },
    };
  }

  // Short spoken recap read out over TTS once the run finishes — scoped to
  // just what THIS run() added, not the cart's whole (possibly older)
  // contents, so a second run doesn't re-announce items added in a previous
  // one. Kept separate from the visible result panel, which always shows the
  // full current cart regardless of what this run touched.
  private buildSpokenSummary(state: CartState, addedItems: AddedItem[], hadItemsBefore: boolean): string {
    if (addedItems.length === 0) {
      const cartHasItems = state.cart.shipments.some((s) => s.products.length > 0);
      return cartHasItems ? 'Нічого нового не додав.' : 'Нічого не знайшов. Кошик лишився порожнім.';
    }

    const names = addedItems.map((i) => i.name);
    const grandTotal = Math.round(state.cart.calculation.totalAfterDiscounts);

    // Only worth splitting into "new items / grand total" when the cart
    // wasn't empty going into this run — otherwise the two numbers are the
    // same order (the whole cart IS what was just added, delivery fee aside)
    // and a second sentence just repeats itself.
    if (hadItemsBefore) {
      const newItemsTotal = Math.round(addedItems.reduce((sum, i) => sum + i.price * i.quantity, 0));
      return (
        `Додав ${joinWithI(names)}, разом ${newItemsTotal} ${pluralizeHryvnia(newItemsTotal)} за нові позиції. ` +
        `Загальна сума кошика — ${grandTotal} ${pluralizeHryvnia(grandTotal)}.`
      );
    }
    return `Додав ${joinWithI(names)}, разом ${grandTotal} ${pluralizeHryvnia(grandTotal)}.`;
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

    // Server already trims/validates; just drop anything with an empty query
    // as a defensive floor against a malformed response slipping through.
    const items = body.items.filter((i) => i.query.trim().length > 0);

    this.updateStep(id, {
      status: 'done',
      detail:
        items.length > 0
          ? items
              .map((i) =>
                i.type === 'replace'
                  ? `${i.target} → ${formatItemLabel(i.query, i.quantity, i.selector)}`
                  : formatItemLabel(i.query, i.quantity, i.selector),
              )
              .join(', ')
          : 'Товарів не розпізнано',
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

  private async searchAndPickProduct(
    cartState: CartState,
    query: string,
    quantity: number,
    selector?: Selector,
  ): Promise<CartProduct | null> {
    const id = `search-${query}`;
    const criterionSuffix = selector === 'discount' ? ' (критерій: акція)' : '';
    this.addStep({ id, label: `Пошук: «${query}»${criterionSuffix}`, status: 'running' });

    const body = await this.postJson<{ queries: Array<{ products: SearchProduct[] }> }>(
      '/api/mcp/products/search',
      { products: [query], limit: 5 },
      id,
    );
    if (!body) return null;

    const candidates = body.queries[0]?.products ?? [];
    if (candidates.length === 0) {
      this.updateStep(id, { status: 'error', detail: 'Нічого не знайдено' });
      return null;
    }

    const found = pickBySelector(candidates, selector);
    this.updateStep(id, { status: 'done', detail: describePick(candidates[0], found, selector) });

    // Only for selector-driven picks — a plain "add" never shows alternatives.
    if (selector === 'discount') {
      this.registerDiscountAlternatives(candidates);
    }

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
            // silpo_add_or_update_cart_products defaults addQuantity to true
            // server-side (undocumented, confirmed via Silpo's Discord) — a
            // repeat add for a product already in the cart would silently sum
            // onto its existing quantity instead of setting the amount the
            // user actually asked for in this utterance.
            addQuantity: false,
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
  const total = state.cart.calculation.totalAfterDiscounts;

  // Strictly "<", not "<=" — Silpo can still carry an error-level
  // order.cost.min validation at the exact boundary (total === orderCostMin),
  // which used to read as "below-minimum" and show "Додайте ще 0 ₴" instead
  // of the checkout button. Equality means the minimum is satisfied.
  const orderCostMin = getOrderCostMin(validations);
  if (orderCostMin !== null && total < orderCostMin) {
    const remaining = Math.ceil(orderCostMin - total);
    const percent = orderCostMin > 0 ? Math.min(100, Math.max(0, (total / orderCostMin) * 100)) : 0;
    return { kind: 'below-minimum', remaining, percent };
  }

  const hasAdultIssue = validations.some((v) => v.message === 'order.adult.is_not_confirmed');
  // order.cost.min is excluded here too: once the strict check above has
  // decided the minimum is actually satisfied, a stale/boundary copy of that
  // same validation must not turn around and block checkout as "some other
  // error" instead.
  const hasOtherError = validations.some(
    (v) => v.level === 'error' && v.message !== 'order.adult.is_not_confirmed' && v.message !== 'order.cost.min',
  );

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

// Same as formatQuantityLabel, plus a "(по акції)" tag when a selector was
// captured — used in the parse-step trace summary.
function formatItemLabel(query: string, quantity: number, selector?: Selector): string {
  const base = formatQuantityLabel(query, quantity);
  return selector === 'discount' ? `${base} (по акції)` : base;
}

// True when a candidate is actually on sale: either marked down from an
// oldPrice, or carrying a quantity-break specialPrices entry.
function isOnDiscount(p: SearchProduct): boolean {
  if (typeof p.oldPrice === 'number' && p.oldPrice > p.price) return true;
  return !!p.specialPrices && p.specialPrices.length > 0;
}

// selector: "discount" picks the first candidate that's actually on sale,
// falling back to the plain first result (and noting the miss in the trace
// via describePick) when none of the returned candidates qualify.
function pickBySelector(candidates: SearchProduct[], selector?: Selector): SearchProduct {
  if (selector === 'discount') {
    const discounted = candidates.find(isOnDiscount);
    if (discounted) return discounted;
  }
  return candidates[0];
}

function formatDiscount(p: SearchProduct): string {
  if (typeof p.oldPrice === 'number' && p.oldPrice > p.price) {
    return `було ${p.oldPrice} ₴, стало ${p.price} ₴`;
  }
  const special = p.specialPrices?.[0];
  if (special) {
    return `знижка від ${special.count} шт.: ${special.price} ₴`;
  }
  return `${p.price} ₴`;
}

function describeProduct(p: SearchProduct): string {
  return `${p.name} — ${p.price} ₴ (залишок: ${p.stock})`;
}

// Trace detail for a search step: plain description when there's no
// selector, otherwise reports whether the "discount" criterion was actually
// satisfied among the returned candidates or the plain first result was used
// instead.
function describePick(first: SearchProduct, picked: SearchProduct, selector?: Selector): string {
  if (selector !== 'discount') return describeProduct(picked);

  if (picked !== first) {
    return `знайдено на знижці: ${picked.name}, ${formatDiscount(picked)}`;
  }
  if (isOnDiscount(picked)) {
    return `знайдено на знижці: ${picked.name}, ${formatDiscount(picked)}`;
  }
  return `критерій «акція» не задоволено — взято перший знайдений товар: ${describeProduct(picked)}`;
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
