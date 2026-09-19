export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import {
  AddressAmbiguousError,
  CartAddressMismatchError,
  DeadBranchError,
  NoDeliveryOptionError,
  setupCartForAddress,
} from '../../../lib/mcp/silpo-tools';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

interface CreateCartBody {
  address?: unknown;
  controlQuery?: unknown;
}

// Runs the full find_address -> get_available_delivery_types -> get_time_slots
// -> (control product check) -> create_shopping_cart flow. Every failure mode
// that needs a human decision (ambiguous address, dead branch, an existing
// cart pointed at a different address) comes back as its own 4xx/5xx + code
// instead of a generic error, so the voice agent can react appropriately
// rather than silently guessing.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  if (req.method !== 'POST') {
    return withSessionCookie(json({ error: 'Method not allowed' }, 405), session);
  }

  let body: CreateCartBody;
  try {
    body = await req.json();
  } catch {
    return withSessionCookie(json({ error: 'Invalid JSON body' }, 400), session);
  }

  if (typeof body.address !== 'string' || body.address.trim().length === 0) {
    return withSessionCookie(json({ error: 'address must be a non-empty string' }, 400), session);
  }
  const controlQuery = typeof body.controlQuery === 'string' ? body.controlQuery : undefined;

  try {
    const result = await setupCartForAddress(session.sessionId, body.address, controlQuery);
    return withSessionCookie(json(result, 200), session);
  } catch (e) {
    if (e instanceof AddressAmbiguousError) {
      return withSessionCookie(json({ error: e.message, code: 'address_ambiguous', candidates: e.candidates }, 409), session);
    }
    if (e instanceof NoDeliveryOptionError) {
      return withSessionCookie(json({ error: e.message, code: 'no_delivery_option', options: e.options }, 422), session);
    }
    if (e instanceof DeadBranchError) {
      return withSessionCookie(json({ error: e.message, code: 'dead_branch', branchId: e.branchId, check: e.check }, 503), session);
    }
    if (e instanceof CartAddressMismatchError) {
      return withSessionCookie(
        json({ error: e.message, code: 'address_mismatch', intended: e.intended, existing: e.existing }, 409),
        session,
      );
    }
    return withSessionCookie(errorResponse(e), session);
  }
}
