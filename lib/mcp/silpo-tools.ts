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

export async function getMyShoppingCart(): Promise<MyShoppingCart> {
  return callMcpTool('silpo_get_my_shopping_cart', {}) as Promise<MyShoppingCart>;
}

export async function getShoppingCartById(shoppingCartId: string): Promise<ShoppingCart> {
  return callMcpTool('silpo_get_shopping_cart_by_id', { shoppingCartId }) as Promise<ShoppingCart>;
}

/**
 * Product search and cart mutations need branchId/deliveryType/timeslot — the
 * MCP tools say to source these from the user's existing cart rather than
 * asking for them separately. Creating a cart from scratch needs its own
 * address/branch/timeslot resolution flow and is out of scope here.
 */
export async function requireCartContext(): Promise<{ shoppingCartId: string; context: CartSearchContext }> {
  const mine = await getMyShoppingCart();
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('No shopping cart yet for this account — it must be created first');
  }

  const { cart } = await getShoppingCartById(mine.shoppingCartId);
  const branchId = cart.shipments[0]?.branchId;
  if (!branchId || !cart.deliveryType || !cart.timeslot) {
    throw new Error('Cart is missing branch/delivery/timeslot information');
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
  products: string[],
  context: CartSearchContext,
  limit?: number,
): Promise<ProductSearchResult> {
  if (products.length === 0 || products.length > 30) {
    throw new Error('products must contain between 1 and 30 search terms');
  }

  return callMcpTool('silpo_find_products_batch', {
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
  shoppingCartId: string,
  products: CartProductInput[],
): Promise<unknown> {
  if (products.length === 0) throw new Error('products must be a non-empty array');
  return callMcpTool('silpo_add_or_update_cart_products', { shoppingCartId, products });
}

export async function removeCartProducts(shoppingCartId: string, productIds: string[]): Promise<unknown> {
  if (productIds.length === 0) throw new Error('productIds must be a non-empty array');
  return callMcpTool('silpo_remove_cart_products', {
    shoppingCartId,
    products: productIds.map((productId) => ({ productId })),
  });
}

export async function clearShoppingCart(shoppingCartId: string): Promise<unknown> {
  return callMcpTool('silpo_clear_shopping_cart', { shoppingCartId });
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

export async function findAddress(query: string): Promise<ResolvedAddress[]> {
  const result = (await callMcpTool('silpo_find_address', { address: query })) as { addresses: ResolvedAddress[] };
  return result.addresses;
}

export interface DeliveryOption {
  deliveryType: DeliveryType;
  branchId: string | null;
  description?: string;
}

export async function getAvailableDeliveryTypes(latitude: number, longitude: number): Promise<DeliveryOption[]> {
  const result = (await callMcpTool('silpo_get_available_delivery_types', { latitude, longitude })) as {
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

export async function listBranches(opts: { hasPickup?: boolean; hasNP?: boolean; limit?: number } = {}): Promise<Branch[]> {
  const result = (await callMcpTool('silpo_list_branches', opts)) as { branches: Branch[] };
  return result.branches;
}

export interface TimeSlot {
  start: string;
  end: string;
  available: boolean;
  deliveryType: DeliveryType;
  [key: string]: unknown;
}

export async function getTimeSlots(branchId: string, deliveryTypes?: DeliveryType[]): Promise<TimeSlot[]> {
  const result = (await callMcpTool('silpo_get_time_slots', {
    branchId,
    ...(deliveryTypes ? { deliveryTypes } : {}),
  })) as { slots: TimeSlot[] };
  return result.slots;
}

/** Never take slots[0] on faith — plenty of returned slots have available:false. */
export async function findFirstAvailableSlot(branchId: string, deliveryType: DeliveryType): Promise<TimeSlot> {
  const slots = await getTimeSlots(branchId, [deliveryType]);
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
  context: CartSearchContext,
  controlQuery = 'молоко',
): Promise<BranchHealthCheck> {
  const result = await findProductsBatch([controlQuery], context, 10);
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
  address: CreateCartAddress,
  branchId: string,
  deliveryType: DeliveryType,
  timeslot: { start: string; end: string },
): Promise<{ shoppingCartId: string } & ShoppingCart> {
  await callMcpTool('silpo_create_shopping_cart', {
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

  const mine = await getMyShoppingCart();
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('create_shopping_cart reported success but no cart is associated with this account');
  }

  let current = await getShoppingCartById(mine.shoppingCartId);

  if (!isSameAddress(address, current.cart.address)) {
    throw new CartAddressMismatchError(address, current.cart.address);
  }

  const hasStaleTimeslot = current.cart.calculation.validations.some(
    (v) => v.level === 'error' && v.type === 'timeslot',
  );

  if (hasStaleTimeslot) {
    const freshSlot = await findFirstAvailableSlot(branchId, deliveryType);
    await callMcpTool('silpo_update_shopping_cart', {
      shoppingCartId: mine.shoppingCartId,
      deliveryType,
      timeslot: { start: freshSlot.start, end: freshSlot.end },
      address: current.cart.address,
      shipments: current.cart.shipments.map((s) => ({ companyId: s.companyId, branchId: s.branchId })),
    });
    current = await getShoppingCartById(mine.shoppingCartId);
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

/**
 * End-to-end: free-text address -> resolved coordinates -> delivery option ->
 * a verified-healthy branch -> a real available timeslot -> a cart that
 * actually matches all three. Every decision is recorded in `trace` so it can
 * be inspected afterwards instead of only living in server logs.
 */
export async function setupCartForAddress(
  addressQuery: string,
  controlQuery = 'молоко',
): Promise<CartSetupResult> {
  const trace: CartSetupTraceEntry[] = [];

  const candidates = await findAddress(addressQuery);
  if (candidates.length !== 1) {
    trace.push({ step: 'find_address', detail: `${candidates.length} candidates for "${addressQuery}" — ambiguous` });
    throw new AddressAmbiguousError(candidates);
  }
  const resolved = candidates[0];
  trace.push({
    step: 'find_address',
    detail: `${resolved.address} (${resolved.latitude}, ${resolved.longitude})`,
  });

  const options = await getAvailableDeliveryTypes(resolved.latitude, resolved.longitude);
  const homeOption = options.find((o) => o.deliveryType === 'DeliveryHome' && o.branchId);
  if (!homeOption?.branchId) {
    trace.push({ step: 'get_available_delivery_types', detail: `no DeliveryHome option: ${JSON.stringify(options)}` });
    throw new NoDeliveryOptionError(options);
  }
  const branchId = homeOption.branchId;
  const deliveryType: DeliveryType = 'DeliveryHome';
  trace.push({
    step: 'get_available_delivery_types',
    detail: `chose DeliveryHome, branchId=${branchId} (direct branchId, best match for grocery delivery)`,
  });

  const slot = await findFirstAvailableSlot(branchId, deliveryType);
  trace.push({ step: 'get_time_slots', detail: `first available:true slot = ${slot.start} → ${slot.end}` });

  const context: CartSearchContext = {
    branchId,
    deliveryType,
    timeslotStart: slot.start,
    timeslotEnd: slot.end,
  };
  const health = await verifyBranchIsHealthy(context, controlQuery);
  if (!health.healthy) {
    trace.push({ step: 'verify_branch_health', detail: `FAILED: totalFound=${health.totalFound}` });
    throw new DeadBranchError(branchId, health);
  }
  trace.push({
    step: 'verify_branch_health',
    detail: `OK: totalFound=${health.totalFound}, sample=${health.sampleProductNames.slice(0, 3).join(', ')}`,
  });

  const address: CreateCartAddress = {
    addressType: 'house',
    city: resolved.city,
    street: resolved.street,
    house: resolved.houseNumber,
    district: resolved.district,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
  };

  const result = await ensureShoppingCart(address, branchId, deliveryType, { start: slot.start, end: slot.end });
  trace.push({
    step: 'ensure_shopping_cart',
    detail: `shoppingCartId=${result.shoppingCartId}, timeslot=${result.cart.timeslot.start} → ${result.cart.timeslot.end}`,
  });

  return {
    shoppingCartId: result.shoppingCartId,
    cart: result.cart,
    checkoutWebLink: result.checkoutWebLink,
    checkoutMobileLink: result.checkoutMobileLink,
    trace,
  };
}
