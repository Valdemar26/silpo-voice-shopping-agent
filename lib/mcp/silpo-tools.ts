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

// The MCP tool descriptions document response *fields* (for an LLM caller) but
// not a formal JSON schema, so this cart shape is inferred and permissive —
// expect to loosen/tighten it once tested against the real server.
export interface ShoppingCart {
  cart: {
    deliveryType: DeliveryType;
    timeslot: { start: string; end: string };
    shipments: Array<{
      branchId: string;
      companyId: string;
      products?: Array<{ productId: string; companyId: string; [key: string]: unknown }>;
      [key: string]: unknown;
    }>;
    calculation: {
      total: number;
      totalAfterDiscounts: number;
      validations: Array<{ level: string; message: string; context?: unknown }>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
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
