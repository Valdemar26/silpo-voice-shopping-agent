export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { getMyShoppingCart, getShoppingCartById } from '../../../lib/mcp/silpo-tools';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

// Current cart contents, or { exists: false } if the account has no cart yet.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'GET') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  try {
    const mine = await getMyShoppingCart(session.sessionId);
    if (!mine.exists || !mine.shoppingCartId) {
      return withSessionCookie(json({ exists: false }, 200), session);
    }

    const cart = await getShoppingCartById(session.sessionId, mine.shoppingCartId);
    return withSessionCookie(json({ exists: true, shoppingCartId: mine.shoppingCartId, ...cart }, 200), session);
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  }
}
