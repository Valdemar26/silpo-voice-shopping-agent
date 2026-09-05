export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../../lib/mcp/http';
import { findProductsBatch, requireCartContext } from '../../../lib/mcp/silpo-tools';

interface SearchRequestBody {
  products?: unknown;
  limit?: unknown;
}

// Text search for up to 30 product names/article codes at once, scoped to the
// branch/delivery/timeslot of the user's existing cart.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: SearchRequestBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!Array.isArray(body.products) || !body.products.every((p) => typeof p === 'string')) {
    return json({ error: 'products must be an array of strings' }, 400);
  }
  const limit = typeof body.limit === 'number' ? body.limit : undefined;

  try {
    const { context } = await requireCartContext();
    const result = await findProductsBatch(body.products, context, limit);
    return json(result, 200);
  } catch (e) {
    return errorResponse(e);
  }
}
