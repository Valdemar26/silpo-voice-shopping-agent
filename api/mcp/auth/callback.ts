export const config = { runtime: 'edge' };

import { exchangeCodeForTokens } from '../../../lib/mcp/oauth';
import { consumeOauthState, saveTokens } from '../../../lib/mcp/redis';

function htmlError(message: string, status: number): Response {
  return new Response(`<p>Silpo authorization error: ${message}</p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Exchanges the authorization code for tokens and stores them server-side
// (Upstash Redis) — the browser only ever sees a redirect, never the tokens.
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const providerError = url.searchParams.get('error');
  if (providerError) {
    return htmlError(providerError, 400);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return htmlError('missing code or state parameter', 400);
  }

  // Deletes the entry on read, so a state value can only be redeemed once.
  const pending = await consumeOauthState(state);
  if (!pending) {
    return htmlError('invalid or expired state — please try logging in again', 400);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, pending.code_verifier);
    await saveTokens(tokens);
  } catch (e) {
    return htmlError(e instanceof Error ? e.message : 'token exchange failed', 502);
  }

  const appBaseUrl = (process.env['APP_BASE_URL'] ?? '').replace(/\/$/, '');
  return Response.redirect(`${appBaseUrl}/?silpo_connected=1`, 302);
}
