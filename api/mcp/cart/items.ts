export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import {
  addOrUpdateCartProducts,
  CartProductInput,
  getMyShoppingCart,
  getShoppingCartById,
  removeCartProducts,
} from '../../../lib/mcp/silpo-tools';

function isCartProductInput(p: unknown): p is CartProductInput {
  if (typeof p !== 'object' || p === null) return false;
  const c = p as Record<string, unknown>;
  return (
    typeof c['productId'] === 'string' &&
    typeof c['companyId'] === 'string' &&
    typeof c['branchId'] === 'string' &&
    typeof c['quantity'] === 'number'
  );
}

async function requireShoppingCartId(): Promise<string> {
  const mine = await getMyShoppingCart();
  if (!mine.exists || !mine.shoppingCartId) {
    throw new Error('No shopping cart yet for this account — it must be created first');
  }
  return mine.shoppingCartId;
}

// Add/update cart products (POST) or remove them (DELETE). Both mutations are
// followed by re-fetching the cart, since a successful write can still fail
// validation server-side (e.g. quantity over stock) — callers need that to
// know whether the change actually "took".
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'POST') {
    let body: { products?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!Array.isArray(body.products) || body.products.length === 0 || !body.products.every(isCartProductInput)) {
      return json(
        { error: 'products must be a non-empty array of { productId, companyId, branchId, quantity }' },
        400,
      );
    }

    try {
      const shoppingCartId = await requireShoppingCartId();
      await addOrUpdateCartProducts(shoppingCartId, body.products);
      const cart = await getShoppingCartById(shoppingCartId);
      return json({ shoppingCartId, ...cart }, 200);
    } catch (e) {
      return errorResponse(e);
    }
  }

  if (req.method === 'DELETE') {
    let body: { productIds?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    if (!Array.isArray(body.productIds) || body.productIds.length === 0 || !body.productIds.every((id) => typeof id === 'string')) {
      return json({ error: 'productIds must be a non-empty array of strings' }, 400);
    }

    try {
      const shoppingCartId = await requireShoppingCartId();
      await removeCartProducts(shoppingCartId, body.productIds);
      const cart = await getShoppingCartById(shoppingCartId);
      return json({ shoppingCartId, ...cart }, 200);
    } catch (e) {
      return errorResponse(e);
    }
  }

  return json({ error: 'Method not allowed' }, 405);
}
