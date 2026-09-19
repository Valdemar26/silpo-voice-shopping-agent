export const config = { runtime: 'edge' };

import { exchangeCodeForTokens } from '../../../lib/mcp/oauth';
import { consumeOauthState, saveTokens } from '../../../lib/mcp/redis';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

function htmlError(message: string, status: number): Response {
  return new Response(`<p>Silpo authorization error: ${message}</p>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// Exchanges the authorization code for tokens and stores them server-side
// (Upstash Redis) — the browser only ever sees a redirect, never the tokens.
// This is the same browser that hit login.ts moments ago (Silpo redirects it
// straight back here), so the `sid` cookie it set is already present on this
// request — reading it again here (rather than round-tripping it through the
// OAuth `state` payload) is what lets the tokens land under that same
// session's Redis key without touching the state/PKCE mechanics at all.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);
  const url = new URL(req.url);

  const providerError = url.searchParams.get('error');
  if (providerError) {
    return withSessionCookie(htmlError(providerError, 400), session);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return withSessionCookie(htmlError('missing code or state parameter', 400), session);
  }

  // Deletes the entry on read, so a state value can only be redeemed once.
  const pending = await consumeOauthState(state);
  if (!pending) {
    return withSessionCookie(htmlError('invalid or expired state — please try logging in again', 400), session);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, pending.code_verifier);
    await saveTokens(session.sessionId, tokens);
  } catch (e) {
    return withSessionCookie(htmlError(e instanceof Error ? e.message : 'token exchange failed', 502), session);
  }

  const appBaseUrl = (process.env['APP_BASE_URL'] ?? '').replace(/\/$/, '');
  return withSessionCookie(Response.redirect(`${appBaseUrl}/?silpo_connected=1`, 302), session);
}
