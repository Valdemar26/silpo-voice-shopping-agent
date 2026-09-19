import { callMcpTool } from './client';

// Delivery type enum as declared by the Silpo MCP tools' input schemas.
export type DeliveryType =
  | 'Unknown'
  | 'SelfPickup'
  | 'DeliveryHome'
  | 'DeliveryFlat'
  | 'DeliveryOffice'
  | 'DeliveryGlovo'
  | 'DeliveryExpress'
  | 'DeliveryExpressFood'
  | 'JustIn'
  | 'LongDelivery'
  | 'JustInPost'
  | 'NovaPoshta'
  | 'DeliveryExpressByPromise'
  | 'WideAssortDelivery'
  | 'B2B'
  | 'PreOrder';

export interface CartSearchContext {
  branchId: string;
  deliveryType: DeliveryType;
  timeslotStart: string;
  timeslotEnd: string;
}

interface MyShoppingCart {
  exists: boolean;
  shoppingCartId?: string;
}

export interface CartAddress {
  addressType: string;
  city?: string;
  street?: string;
  house?: string;
  district?: string;
  latitude?: string | number;
  longitude?: string | number;
  [key: string]: unknown;
}

// The MCP tool descriptions document response *fields* (for an LLM caller) but
// not a formal JSON schema, so this cart shape is inferred and permissive —
// expect to loosen/tighten it once tested against the real server.
//
// checkoutWebLink/checkoutMobileLink are siblings of `cart`, not nested
// inside it — confirmed against a real response. They're present once the
// cart clears order.cost.min (and any other blocking validation), absent
// otherwise; callers that reconstruct this object (setupCartForAddress etc.)
// must carry them through explicitly or they silently vanish.
export interface ShoppingCart {
  cart: {
    deliveryType: DeliveryType;
    timeslot: { start: string; end: string };
    address: CartAddress;
    shipments: Array<{
      branchId: string;
      companyId: string;
      products?: Array<{ productId: string; companyId: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
    calculation: {
      total: number;
      totalAfterDiscounts: number;
      validations: Array<{ level: string; type: string; message: string; context?: unknown }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
}

export async function getMyShoppingCart(sessionId: string): Promise<MyShoppingCart> {
  return callMcpTool(sessionId, 'silpo_get_my_shopping_cart', {}) as Promise<MyShoppingCart>;
}

export async function getShoppingCartById(sessionId: string, shoppingCartId: string): Promise<ShoppingCart> {
  return callMcpTool(sessionId, 'silpo_get_shopping_cart_by_id', { shoppingCartId }) as Promise<ShoppingCart>;
}

/**
 * Product search and cart mutations need branchId/deliveryType/timeslot — the
 * MCP tools say to source these from the user's existing cart rather than
 * asking for them separately. Creating a cart from scratch needs its own
 * address/branch/timeslot resolution flow and is out of scope here.
 *
 * A cart that's sat idle can carry a stale timeslot (validations[] has an
 * error-level "timeslot" entry) — silpo_find_products_batch doesn't reject
 * that, it just silently returns 0 results for every query. So this refreshes
 * the timeslot (same logic ensureShoppingCart uses) before ever handing the
 * context to a caller, instead of letting a search quietly come back empty.
 */
export async function requireCartContext(
  sessionId: string,
): Promise<{ shoppingCartId: string; context: CartSearchContext }> {
  const mine = await getMyShoppingCart(sessionId);
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('No shopping cart yet for this account — it must be created first');
  }

  let { cart } = await getShoppingCartById(sessionId, mine.shoppingCartId);
  const branchId = cart.shipments[0]?.branchId;
  if (!branchId || !cart.deliveryType || !cart.timeslot) {
    throw new Error('Cart is missing branch/delivery/timeslot information');
  }

  if (hasStaleTimeslot(cart)) {
    ({ cart } = await refreshCartTimeslot(sessionId, mine.shoppingCartId, cart, branchId, cart.deliveryType));
  }

  return {
    shoppingCartId: mine.shoppingCartId,
    context: {
      branchId,
      deliveryType: cart.deliveryType,
      timeslotStart: cart.timeslot.start,
      timeslotEnd: cart.timeslot.end,
    },
  };
}

export interface ProductSearchResult {
  queries: Array<{
    query: string;
    totalFound: number;
    products: Array<{
      slug: string;
      productId: string;
      companyId: string;
      branchId: string;
      name?: string;
      available?: boolean;
      stock?: number;
      [key: string]: unknown;
    }>;
  }>;
}

export async function findProductsBatch(
  sessionId: string,
  products: string[],
  context: CartSearchContext,
  limit?: number,
): Promise<ProductSearchResult> {
  if (products.length === 0 || products.length > 30) {
    throw new Error('products must contain between 1 and 30 search terms');
  }

  return callMcpTool(sessionId, 'silpo_find_products_batch', {
    branchId: context.branchId,
    deliveryType: context.deliveryType,
    timeslotStart: context.timeslotStart,
    timeslotEnd: context.timeslotEnd,
    products,
    ...(limit ? { limit } : {}),
  }) as Promise<ProductSearchResult>;
}

export interface CartProductInput {
  productId: string;
  companyId: string;
  branchId: string;
  quantity: number;
  addQuantity?: boolean;
  comment?: string;
}

export async function addOrUpdateCartProducts(
  sessionId: string,
  shoppingCartId: string,
  products: CartProductInput[],
): Promise<unknown> {
  if (products.length === 0) throw new Error('products must be a non-empty array');
  // silpo_add_or_update_cart_products defaults addQuantity to true server-side
  // (undocumented in the tool schema, confirmed via Silpo's Discord) — a repeat
  // call for a product already in the cart would silently add to its existing
  // quantity instead of setting it. Force false here unless a caller opts in,
  // so every call site gets "set quantity" semantics without having to know
  // about this undocumented default.
  return callMcpTool(sessionId, 'silpo_add_or_update_cart_products', {
    shoppingCartId,
    products: products.map((p) => ({ addQuantity: false, ...p })),
  });
}

export async function removeCartProducts(sessionId: string, shoppingCartId: string, productIds: string[]): Promise<unknown> {
  if (productIds.length === 0) throw new Error('productIds must be a non-empty array');
  return callMcpTool(sessionId, 'silpo_remove_cart_products', {
    shoppingCartId,
    products: productIds.map((productId) => ({ productId })),
  });
}

export async function clearShoppingCart(sessionId: string, shoppingCartId: string): Promise<unknown> {
  return callMcpTool(sessionId, 'silpo_clear_shopping_cart', { shoppingCartId });
}

// ---------------------------------------------------------------------------
// Cart creation flow: find_address -> get_available_delivery_types ->
// get_time_slots -> (control product check) -> create_shopping_cart
// ---------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  city: string;
  street: string;
  houseNumber: string;
  district?: string;
  latitude: number;
  longitude: number;
}

export async function findAddress(sessionId: string, query: string): Promise<ResolvedAddress[]> {
  const result = (await callMcpTool(sessionId, 'silpo_find_address', { address: query })) as {
    addresses: ResolvedAddress[];
  };
  return result.addresses;
}

export interface DeliveryOption {
  deliveryType: DeliveryType;
  branchId: string | null;
  description?: string;
}

export async function getAvailableDeliveryTypes(
  sessionId: string,
  latitude: number,
  longitude: number,
): Promise<DeliveryOption[]> {
  const result = (await callMcpTool(sessionId, 'silpo_get_available_delivery_types', { latitude, longitude })) as {
    options: DeliveryOption[];
  };
  return result.options;
}

export interface Branch {
  branchId: string;
  companyId: string;
  latitude: number;
  longitude: number;
  address?: string;
  city?: string;
  [key: string]: unknown;
}

export async function listBranches(
  sessionId: string,
  opts: { hasPickup?: boolean; hasNP?: boolean; limit?: number } = {},
): Promise<Branch[]> {
  const result = (await callMcpTool(sessionId, 'silpo_list_branches', opts)) as { branches: Branch[] };
  return result.branches;
}

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
  deliveryType: DeliveryType;
  [key: string]: unknown;
}

export async function getTimeSlots(
  sessionId: string,
  branchId: string,
  deliveryTypes?: DeliveryType[],
): Promise<TimeSlot[]> {
  const result = (await callMcpTool(sessionId, 'silpo_get_time_slots', {
    branchId,
    ...(deliveryTypes ? { deliveryTypes } : {}),
  })) as { slots: TimeSlot[] };
  return result.slots;
}

/** Never take slots[0] on faith — plenty of returned slots have available:false. */
export async function findFirstAvailableSlot(
  sessionId: string,
  branchId: string,
  deliveryType: DeliveryType,
): Promise<TimeSlot> {
  const slots = await getTimeSlots(sessionId, branchId, [deliveryType]);
  const slot = slots.find((s) => s.available);
  if (!slot) {
    throw new Error(`No available (available:true) time slots for branch ${branchId} / ${deliveryType}`);
  }
  return slot;
}

export interface BranchHealthCheck {
  healthy: boolean;
  totalFound: number;
  sampleProductNames: string[];
}

/**
 * A branch can return a technically-successful but useless search (empty, or
 * only unrelated/out-of-stock filler) if it's not really operating. Run a
 * known-common-grocery query and require at least one in-stock hit before
 * trusting the branch enough to create a cart against it.
 */
export async function verifyBranchIsHealthy(
  sessionId: string,
  context: CartSearchContext,
  controlQuery = 'молоко',
): Promise<BranchHealthCheck> {
  const result = await findProductsBatch(sessionId, [controlQuery], context, 10);
  const query = result.queries[0];
  const products = query?.products ?? [];
  const inStock = products.filter((p) => p.available !== false && p.stock !== 0);

  return {
    healthy: (query?.totalFound ?? 0) > 0 && inStock.length > 0,
    totalFound: query?.totalFound ?? 0,
    sampleProductNames: products.slice(0, 5).map((p) => p.name ?? p.slug),
  };
}

export class AddressAmbiguousError extends Error {
  constructor(public readonly candidates: ResolvedAddress[]) {
    super(`find_address returned ${candidates.length} candidates — refusing to guess which one is intended`);
    this.name = 'AddressAmbiguousError';
  }
}

export class NoDeliveryOptionError extends Error {
  constructor(public readonly options: DeliveryOption[]) {
    super('No delivery option with a direct branchId (e.g. DeliveryHome) is available for this address');
    this.name = 'NoDeliveryOptionError';
  }
}

export class DeadBranchError extends Error {
  constructor(public readonly branchId: string, public readonly check: BranchHealthCheck) {
    super(
      `Branch ${branchId} failed the control product check (totalFound=${check.totalFound}, ` +
        `sample=${JSON.stringify(check.sampleProductNames)}) — treating it as inactive rather than assuming "no results"`,
    );
    this.name = 'DeadBranchError';
  }
}

/**
 * The MCP tool descriptions say create_shopping_cart is idempotent per user —
 * if a cart already exists it silently returns that cart, ignoring the
 * address/branch/timeslot you just sent. Address is the one field where that
 * silent reuse is dangerous: reusing a stale *timeslot* just needs a refresh,
 * but reusing a stale *address* risks delivering to the wrong place. So this
 * checks address equality as its own, unconditional step — never folded into
 * the timeslot check, and never auto-resolved.
 */
export class CartAddressMismatchError extends Error {
  constructor(
    public readonly intended: { city: string; street: string; house: string },
    public readonly existing: { city?: string; street?: string; house?: string },
  ) {
    super(
      `Existing shopping cart address ("${existing.street ?? '?'} ${existing.house ?? '?'}, ${existing.city ?? '?'}") ` +
        `does not match the requested address ("${intended.street} ${intended.house}, ${intended.city}") — ` +
        'refusing to reuse or silently overwrite it. This needs explicit human confirmation before proceeding.',
    );
    this.name = 'CartAddressMismatchError';
  }
}

// Formatting differs between sources even for the identical address (find_address
// returned house "8-Є" for a cart that had stored house "8є") — normalize before
// comparing so that isn't mistaken for a real mismatch.
function normalizeAddressPart(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[\s-]+/g, '');
}

function isSameAddress(
  intended: { city: string; street: string; house: string },
  existing: { city?: string; street?: string; house?: string },
): boolean {
  return (
    normalizeAddressPart(intended.city) === normalizeAddressPart(existing.city) &&
    normalizeAddressPart(intended.street) === normalizeAddressPart(existing.street) &&
    normalizeAddressPart(intended.house) === normalizeAddressPart(existing.house)
  );
}

export interface CreateCartAddress {
  addressType: 'house' | 'flat' | 'office' | 'point' | 'self-pickup' | 'nova-poshta';
  city: string;
  street: string;
  house: string;
  district?: string;
  latitude: number;
  longitude: number;
}

/** True when the cart's calculation carries an error-level "timeslot" validation. */
function hasStaleTimeslot(cart: ShoppingCart['cart']): boolean {
  return cart.calculation.validations.some((v) => v.level === 'error' && v.type === 'timeslot');
}

/**
 * Finds a fresh available slot for branchId/deliveryType and applies it to the
 * cart via update_shopping_cart, copying the existing address/shipments
 * as-is — only the timeslot was the problem. Returns the re-fetched cart
 * (refreshing the timeslot can also change checkoutWebLink/validations, so
 * the whole object is re-fetched rather than patching just the timeslot).
 *
 * shipments must be passed through byte-for-byte from the cart response
 * (spread, not reconstructed field-by-field) — the tool's own description
 * says "must also come from the cart response", and this previously rebuilt
 * each entry as just {companyId, branchId}, silently dropping `products` and
 * any other field the shipment carried. Whether or not that specific gap
 * ever caused a real corruption, sending a hand-picked subset of a payload
 * the API docs say to copy verbatim is exactly the kind of undocumented-
 * default risk this project has already been burned by once (see
 * silpo_add_or_update_cart_products' addQuantity default).
 */
async function refreshCartTimeslot(
  sessionId: string,
  shoppingCartId: string,
  cart: ShoppingCart['cart'],
  branchId: string,
  deliveryType: DeliveryType,
): Promise<ShoppingCart> {
  const freshSlot = await findFirstAvailableSlot(sessionId, branchId, deliveryType);
  await callMcpTool(sessionId, 'silpo_update_shopping_cart', {
    shoppingCartId,
    deliveryType,
    timeslot: { start: freshSlot.start, end: freshSlot.end },
    address: cart.address,
    shipments: cart.shipments,
  });
  return getShoppingCartById(sessionId, shoppingCartId);
}

/**
 * Creates the cart if none exists, or reconciles an existing one — but only
 * within the two checks the MCP server won't do for us:
 *  1. Address must match what was requested (throws CartAddressMismatchError
 *     otherwise — never silently reused, never silently overwritten).
 *  2. Timeslot must be valid; if the existing cart carries a stale one
 *     (validations[] has a "timeslot" error), it's refreshed via
 *     update_shopping_cart — copying the existing address/shipments as-is,
 *     since only the timeslot was the problem.
 */
export async function ensureShoppingCart(
  sessionId: string,
  address: CreateCartAddress,
  branchId: string,
  deliveryType: DeliveryType,
  timeslot: { start: string; end: string },
): Promise<{ shoppingCartId: string } & ShoppingCart> {
  await callMcpTool(sessionId, 'silpo_create_shopping_cart', {
    addressType: address.addressType,
    latitude: address.latitude,
    longitude: address.longitude,
    city: address.city,
    street: address.street,
    house: address.house,
    ...(address.district ? { district: address.district } : {}),
    deliveryType,
    branchId,
    timeslot,
  });

  const mine = await getMyShoppingCart(sessionId);
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('create_shopping_cart reported success but no cart is associated with this account');
  }

  let current = await getShoppingCartById(sessionId, mine.shoppingCartId);

  if (!isSameAddress(address, current.cart.address)) {
    throw new CartAddressMismatchError(address, current.cart.address);
  }

  if (hasStaleTimeslot(current.cart)) {
    current = await refreshCartTimeslot(sessionId, mine.shoppingCartId, current.cart, branchId, deliveryType);
  }

  return { shoppingCartId: mine.shoppingCartId, ...current };
}

export interface CartSetupTraceEntry {
  step: string;
  detail: string;
}

export interface CartSetupResult {
  shoppingCartId: string;
  cart: ShoppingCart['cart'];
  checkoutWebLink?: string;
  checkoutMobileLink?: string;
  trace: CartSetupTraceEntry[];
}

interface BranchAttempt {
  branchId: string;
  deliveryType: DeliveryType;
  slot: TimeSlot;
  healthy: boolean;
  check: BranchHealthCheck;
}

/** Fetches a timeslot and runs the control-product health check for one branchId/deliveryType, logging both to `trace`. */
async function attemptBranch(
  sessionId: string,
  branchId: string,
  deliveryType: DeliveryType,
  controlQuery: string,
  trace: CartSetupTraceEntry[],
): Promise<BranchAttempt> {
  const slot = await findFirstAvailableSlot(sessionId, branchId, deliveryType);
  trace.push({ step: 'get_time_slots', detail: `[${deliveryType}] first available:true slot = ${slot.start} → ${slot.end}` });

  const context: CartSearchContext = {
    branchId,
    deliveryType,
    timeslotStart: slot.start,
    timeslotEnd: slot.end,
  };
  const check = await verifyBranchIsHealthy(sessionId, context, controlQuery);
  trace.push({
    step: 'verify_branch_health',
    detail: check.healthy
      ? `[${deliveryType}] OK: totalFound=${check.totalFound}, sample=${check.sampleProductNames.slice(0, 3).join(', ')}`
      : `[${deliveryType}] FAILED: totalFound=${check.totalFound}`,
  });

  return { branchId, deliveryType, slot, healthy: check.healthy, check };
}

/**
 * End-to-end: free-text address -> resolved coordinates -> delivery option ->
 * a verified-healthy branch -> a real available timeslot -> a cart that
 * actually matches all three. Every decision is recorded in `trace` so it can
 * be inspected afterwards instead of only living in server logs.
 *
 * If the DeliveryHome branch fails the health check (DeadBranchError
 * territory), this doesn't give up immediately — it looks for a SelfPickup
 * option with its own direct branchId for the *same* address and tries that
 * before failing. This only covers the case where get_available_delivery_types
 * already hands back a direct branchId for SelfPickup; finding a pickup branch
 * via list_branches when it doesn't is a separate, unimplemented step (see
 * PROGRESS.md).
 */
export async function setupCartForAddress(
  sessionId: string,
  addressQuery: string,
  controlQuery = 'молоко',
): Promise<CartSetupResult> {
  const trace: CartSetupTraceEntry[] = [];

  const candidates = await findAddress(sessionId, addressQuery);
  if (candidates.length !== 1) {
    trace.push({ step: 'find_address', detail: `${candidates.length} candidates for "${addressQuery}" — ambiguous` });
    throw new AddressAmbiguousError(candidates);
  }
  const resolved = candidates[0];
  trace.push({
    step: 'find_address',
    detail: `${resolved.address} (${resolved.latitude}, ${resolved.longitude})`,
  });

  const options = await getAvailableDeliveryTypes(sessionId, resolved.latitude, resolved.longitude);
  const homeOption = options.find((o) => o.deliveryType === 'DeliveryHome' && o.branchId);
  if (!homeOption?.branchId) {
    trace.push({ step: 'get_available_delivery_types', detail: `no DeliveryHome option: ${JSON.stringify(options)}` });
    throw new NoDeliveryOptionError(options);
  }
  trace.push({
    step: 'get_available_delivery_types',
    detail: `chose DeliveryHome, branchId=${homeOption.branchId} (direct branchId, best match for grocery delivery)`,
  });

  let chosen = await attemptBranch(sessionId, homeOption.branchId, 'DeliveryHome', controlQuery, trace);

  if (!chosen.healthy) {
    const pickupOption = options.find((o) => o.deliveryType === 'SelfPickup' && o.branchId);
    if (!pickupOption?.branchId) {
      trace.push({
        step: 'fallback_self_pickup',
        detail:
          `DeliveryHome branch ${chosen.branchId} is dead and no SelfPickup option with a direct branchId is ` +
          'available for this address (would need list_branches, not implemented) — giving up',
      });
      throw new DeadBranchError(chosen.branchId, chosen.check);
    }

    trace.push({
      step: 'fallback_self_pickup',
      detail:
        `DeliveryHome branch ${chosen.branchId} is dead (totalFound=${chosen.check.totalFound}) — trying ` +
        `SelfPickup branch ${pickupOption.branchId} for the same address instead`,
    });

    const pickupAttempt = await attemptBranch(sessionId, pickupOption.branchId, 'SelfPickup', controlQuery, trace);
    if (!pickupAttempt.healthy) {
      trace.push({
        step: 'fallback_self_pickup',
        detail: `SelfPickup branch ${pickupOption.branchId} is also dead (totalFound=${pickupAttempt.check.totalFound}) — giving up`,
      });
      throw new DeadBranchError(pickupOption.branchId, pickupAttempt.check);
    }

    trace.push({
      step: 'fallback_self_pickup',
      detail: `SelfPickup branch ${pickupOption.branchId} is healthy — using it instead of the dead DeliveryHome branch`,
    });
    chosen = pickupAttempt;
  }

  const address: CreateCartAddress = {
    addressType: chosen.deliveryType === 'SelfPickup' ? 'self-pickup' : 'house',
    city: resolved.city,
    street: resolved.street,
    house: resolved.houseNumber,
    district: resolved.district,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
  };

  const result = await ensureShoppingCart(sessionId, address, chosen.branchId, chosen.deliveryType, {
    start: chosen.slot.start,
    end: chosen.slot.end,
  });
  trace.push({
    step: 'ensure_shopping_cart',
    detail:
      `deliveryType=${chosen.deliveryType}, shoppingCartId=${result.shoppingCartId}, ` +
      `timeslot=${result.cart.timeslot.start} → ${result.cart.timeslot.end}`,
  });

  return {
    shoppingCartId: result.shoppingCartId,
    cart: result.cart,
    checkoutWebLink: result.checkoutWebLink,
    checkoutMobileLink: result.checkoutMobileLink,
    trace,
  };
}
