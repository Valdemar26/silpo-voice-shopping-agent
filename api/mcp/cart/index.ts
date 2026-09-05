export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { getMyShoppingCart, getShoppingCartById } from '../../../lib/mcp/silpo-tools';

// Current cart contents, or { exists: false } if the account has no cart yet.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const mine = await getMyShoppingCart();
    if (!mine.exists || !mine.shoppingCartId) {
      return json({ exists: false }, 200);
    }

    const cart = await getShoppingCartById(mine.shoppingCartId);
    return json({ exists: true, shoppingCartId: mine.shoppingCartId, ...cart }, 200);
  } catch (e) {
    return errorResponse(e);
  }
}
