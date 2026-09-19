export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { clearShoppingCart, getMyShoppingCart, getShoppingCartById } from '../../../lib/mcp/silpo-tools';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

// Empties the cart, then verifies it actually came back empty — the tool can
// report success while leaving products behind.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'POST') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  try {
    const mine = await getMyShoppingCart(session.sessionId);
    if (!mine.exists || !mine.shoppingCartId) {
      return withSessionCookie(json({ error: 'No shopping cart yet for this account' }, 409), session);
    }

    await clearShoppingCart(session.sessionId, mine.shoppingCartId);
    const cart = await getShoppingCartById(session.sessionId, mine.shoppingCartId);
    const remaining = cart.cart.shipments.flatMap((s) => s.products ?? []);

    if (remaining.length > 0) {
      return withSessionCookie(json({ error: 'Cart did not fully clear', ...cart }, 502), session);
    }

    return withSessionCookie(json({ shoppingCartId: mine.shoppingCartId, ...cart }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  }
}
