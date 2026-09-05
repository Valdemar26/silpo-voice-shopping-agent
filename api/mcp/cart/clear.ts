export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { clearShoppingCart, getMyShoppingCart, getShoppingCartById } from '../../../lib/mcp/silpo-tools';

// Empties the cart, then verifies it actually came back empty — the tool can
// report success while leaving products behind.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const mine = await getMyShoppingCart();
    if (!mine.exists || !mine.shoppingCartId) {
      return json({ error: 'No shopping cart yet for this account' }, 409);
    }

    await clearShoppingCart(mine.shoppingCartId);
    const cart = await getShoppingCartById(mine.shoppingCartId);
    const remaining = cart.cart.shipments.flatMap((s) => s.products ?? []);

    if (remaining.length > 0) {
      return json({ error: 'Cart did not fully clear', ...cart }, 502);
    }

    return json({ shoppingCartId: mine.shoppingCartId, ...cart }, 200);
  } catch (e) {
    return errorResponse(e);
  }
}
