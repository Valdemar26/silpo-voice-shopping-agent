// Pure cart-state helpers — no Angular, no fetch, no DOM. Extracted out of
// SilpoAgentService (src/app/services/silpo-agent.ts) so the exact logic (not
// a re-implementation of it) is importable from a plain Node/Edge context
// too, e.g. lib/control-plane/execute.ts — the Angular service re-exports
// these for its own template/component consumers instead of redefining them.
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

export interface SilpoCart {
  // Optional: unlike the rest of this shape, nothing here actually reads it —
  // kept for shape-compatibility with the client's existing wire format, not
  // because getCheckoutStatus/getStockExceededItems need it. A server-side
  // caller (e.g. the control-plane) building this value fresh from an MCP
  // getShoppingCartById response has no real id to put here otherwise.
  id?: string;
  deliveryType: string;
  timeslot: { start: string; end: string };
  shipments: Array<{ branchId: string; companyId: string; products: CartProduct[] }>;
  calculation: {
    total: number;
    totalAfterDiscounts: number;
    productsTotal: number;
    validations: CartValidation[];
    // Confirmed against a live getShoppingCartById response — nested under
    // its own object, not a bare number alongside the rest. Absent rather
    // than { total: 0 } on a self-pickup cart with no delivery leg.
    delivery?: { total: number };
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

// Order-level discount (promo code, cart-wide markdown, etc.) — deliberately
// NOT Silpo's own calculation.subDiscount field. Confirmed live: subDiscount
// already includes per-item markdowns that are also baked into
// productsTotal (e.g. a beer line with its own oldPrice discount plus a
// separate "buy more, save more" promo totalled subDiscount: 350 for 50+300
// ₴ of combined savings) — showing it as-is alongside "Сума товарів" would
// double-count those per-item markdowns. This instead derives the
// order-level discount from the actual arithmetic: whatever's left over once
// products + delivery don't add up to the final total.
export function getOrderDiscount(cart: SilpoCart): number {
  const deliveryTotal = cart.calculation.delivery?.total ?? 0;
  return Math.round(cart.calculation.productsTotal + deliveryTotal - cart.calculation.totalAfterDiscounts);
}

// Reads the minimum order cost straight from validations[] — not a
// guessed/hardcoded threshold.
function getOrderCostMin(validations: CartValidation[]): number | null {
  const validation = validations.find((v) => v.message === 'order.cost.min');
  const context = validation?.context as { orderCostMin?: unknown } | undefined;
  return typeof context?.orderCostMin === 'number' ? context.orderCostMin : null;
}

// One line item that's over the branch's actual stock — surfaced by
// product.offer.stock.max. Confirmed live: context is
// {productId, markdownGroup, stock} — no mention of alcohol/age anywhere, so
// despite first showing up on a beer line (×3 requested, stock: 2) this is a
// plain "not enough in stock", not an alcohol-specific purchase limit.
// markdownGroup isn't surfaced — it's about which discount bucket the offer
// belongs to, not relevant to explaining the block to the person.
export interface StockExceededItem {
  productId: string;
  name: string;
  stock: number;
  quantity: number;
}

// Independent facts about the cart rather than a single mutually-exclusive
// "kind" — Silpo can and does report several blocking/informational
// validations at once (e.g. order.cost.min together with
// order.adult.is_not_confirmed, or with an unrecognized payment_types.disabled
// error), and the UI needs to show every applicable reason side by side
// instead of picking just one and hiding the rest.
export interface CheckoutStatus {
  // True once nothing here blocks completing checkout — belowMinimum is
  // null, stockExceeded is empty, otherBlocked is false, and Silpo actually
  // handed back a checkoutWebLink. adultConfirmationRequired can still be
  // true alongside this — that confirmation happens on Silpo's own checkout
  // page, not here.
  canCheckout: boolean;
  belowMinimum: { remaining: number; percent: number } | null;
  adultConfirmationRequired: boolean;
  stockExceeded: StockExceededItem[];
  // Some other error-level validation that isn't order.cost.min, the adult
  // notice, or a pure stock.max shortfall — e.g. payment_types.disabled.
  otherBlocked: boolean;
}

// Cross-references each product.offer.stock.max validation's context
// (productId + stock) against the cart's own product list to recover the
// name and the quantity actually requested — the validation itself carries
// neither.
function getStockExceededItems(state: CartState): StockExceededItem[] {
  const products = state.cart.shipments.flatMap((s) => s.products);

  return state.cart.calculation.validations
    .filter((v) => v.level === 'error' && v.message === 'product.offer.stock.max')
    .map((v): StockExceededItem | null => {
      const context = v.context as { productId?: unknown; stock?: unknown } | undefined;
      const productId = typeof context?.productId === 'string' ? context.productId : null;
      const stock = typeof context?.stock === 'number' ? context.stock : null;
      const product = productId ? products.find((p) => p.productId === productId) : undefined;
      if (!productId || stock === null || !product) return null;
      return { productId, name: product.name ?? 'товар', stock, quantity: product.quantity };
    })
    .filter((item): item is StockExceededItem => item !== null);
}

// Single source of truth for "can this cart be checked out right now, and
// why not", used by both the trace step and the result panel — they'd
// drifted apart before: the button showed on checkoutWebLink presence alone,
// ignoring any other error-level validation (e.g. order.adult.is_not_confirmed,
// found on an alcohol order) that was still sitting in validations[].
//
// Each reason below is computed independently rather than short-circuiting
// on the first one found — order.cost.min, the adult notice, a stock
// shortfall, and some other unrecognized error can all be present on the
// same cart at once, and the caller needs every applicable one, not just
// whichever came first.
export function getCheckoutStatus(state: CartState): CheckoutStatus {
  const validations = state.cart.calculation.validations;
  const total = state.cart.calculation.totalAfterDiscounts;

  // Strictly "<", not "<=" — Silpo can still carry an error-level
  // order.cost.min validation at the exact boundary (total === orderCostMin),
  // which used to read as "below-minimum" and show "Додайте ще 0 ₴" instead
  // of the checkout button. Equality means the minimum is satisfied.
  const orderCostMin = getOrderCostMin(validations);
  const belowMinimum =
    orderCostMin !== null && total < orderCostMin
      ? {
          remaining: Math.ceil(orderCostMin - total),
          percent: orderCostMin > 0 ? Math.min(100, Math.max(0, (total / orderCostMin) * 100)) : 0,
        }
      : null;

  // order.adult.is_not_confirmed specifically does NOT block checkoutWebLink
  // — Silpo asks for age confirmation on the checkout page itself — so it's
  // tracked separately from the blocking reasons below instead of folded
  // into them.
  const adultConfirmationRequired = validations.some((v) => v.message === 'order.adult.is_not_confirmed');

  // order.cost.min is excluded here too — it's already captured as
  // belowMinimum above, and a stale/boundary copy of that same validation
  // must not also turn around and count as "some other error".
  const otherErrors = validations.filter(
    (v) => v.level === 'error' && v.message !== 'order.adult.is_not_confirmed' && v.message !== 'order.cost.min',
  );

  // Only claim "it's a stock problem" when stock.max is the ONLY kind of
  // other error present — mixed with some other, still-unrecognized error
  // (e.g. a stale timeslot), that would be telling half the story, so that
  // case falls into otherBlocked's generic message instead.
  const allStockExceeded = otherErrors.length > 0 && otherErrors.every((v) => v.message === 'product.offer.stock.max');
  const stockExceeded = allStockExceeded ? getStockExceededItems(state) : [];
  const otherBlocked = otherErrors.length > 0 && !(allStockExceeded && stockExceeded.length > 0);

  const canCheckout = belowMinimum === null && stockExceeded.length === 0 && !otherBlocked && !!state.checkoutWebLink;

  return { canCheckout, belowMinimum, adultConfirmationRequired, stockExceeded, otherBlocked };
}

// Finds the cart product a spoken/targeted "target" phrase (e.g. "кеш'ю") is
// meant to refer to. Deliberately the simplest possible match — a substring
// check against the product name, falling back to any shared significant
// word — not a "similarity"/fuzzy-match algorithm.
export function findCartProductByTarget(cartState: CartState, target: string): CartProduct | null {
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
