export const config = { runtime: 'edge' };

import { AUTHORIZATION_ENDPOINT, CODE_CHALLENGE_METHOD, ensureClientRegistered, getRedirectUri } from '../../../lib/mcp/oauth';
import { generateCodeChallengeS256, generateCodeVerifier, generateState } from '../../../lib/mcp/pkce';
import { saveOauthState } from '../../../lib/mcp/redis';
import { errorResponse } from '../../../lib/mcp/http';
import { readOrCreateSessionId, withSessionCookie } from '../../../lib/mcp/session';

// Starts the authorization_code + PKCE (S256) flow: register the client if
// needed, stash the code_verifier server-side keyed by `state`, and redirect
// the browser to Silpo's /authorize. The verifier never reaches the client.
//
// This is normally a visitor's first authenticated action, so it's also
// where the per-browser session cookie usually gets minted (see
// lib/mcp/session.ts) — the token exchange in callback.ts then lands under
// that same session's Redis key, since Silpo redirects the same browser back.
export default async function handler(req: Request): Promise<Response> {
  const session = readOrCreateSessionId(req);

  let clientId: string;
  try {
    clientId = (await ensureClientRegistered()).client_id;
  } catch (e) {
    return withSessionCookie(errorResponse(e), session);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallengeS256(codeVerifier);
  const state = generateState();

  await saveOauthState(state, codeVerifier);

  const authorizeUrl = new URL(AUTHORIZATION_ENDPOINT);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', getRedirectUri());
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', CODE_CHALLENGE_METHOD);
  authorizeUrl.searchParams.set('state', state);

  return withSessionCookie(Response.redirect(authorizeUrl.toString(), 302), session);
}
