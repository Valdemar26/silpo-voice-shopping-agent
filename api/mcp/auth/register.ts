export const config = { runtime: 'edge' };

import { ensureClientRegistered } from '../../../lib/mcp/oauth';
import { errorResponse, json } from '../../../lib/mcp/http';

// Idempotent Dynamic Client Registration (RFC 7591). Safe to call repeatedly —
// it only registers a client with mcp.silpo.ua once and reuses the stored
// credentials afterwards. login.ts also calls this internally, so hitting this
// endpoint directly is only needed to provision the client ahead of time.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const creds = await ensureClientRegistered();
    return json({ registered: true, client_id: creds.client_id }, 200);
  } catch (e) {
    return errorResponse(e);
  }
}
