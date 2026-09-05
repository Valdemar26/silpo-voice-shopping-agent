export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import {
  AddressAmbiguousError,
  CartAddressMismatchError,
  DeadBranchError,
  NoDeliveryOptionError,
  setupCartForAddress,
} from '../../../lib/mcp/silpo-tools';

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
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: CreateCartBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.address !== 'string' || body.address.trim().length === 0) {
    return json({ error: 'address must be a non-empty string' }, 400);
  }
  const controlQuery = typeof body.controlQuery === 'string' ? body.controlQuery : undefined;

  try {
    const result = await setupCartForAddress(body.address, controlQuery);
    return json(result, 200);
  } catch (e) {
    if (e instanceof AddressAmbiguousError) {
      return json({ error: e.message, code: 'address_ambiguous', candidates: e.candidates }, 409);
    }
    if (e instanceof NoDeliveryOptionError) {
      return json({ error: e.message, code: 'no_delivery_option', options: e.options }, 422);
    }
    if (e instanceof DeadBranchError) {
      return json({ error: e.message, code: 'dead_branch', branchId: e.branchId, check: e.check }, 503);
    }
    if (e instanceof CartAddressMismatchError) {
      return json(
        { error: e.message, code: 'address_mismatch', intended: e.intended, existing: e.existing },
        409,
      );
    }
    return errorResponse(e);
  }
}
