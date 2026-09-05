export const config = { runtime: 'edge' };

import { AUTHORIZATION_ENDPOINT, CODE_CHALLENGE_METHOD, ensureClientRegistered, getRedirectUri } from '../../../lib/mcp/oauth';
import { generateCodeChallengeS256, generateCodeVerifier, generateState } from '../../../lib/mcp/pkce';
import { saveOauthState } from '../../../lib/mcp/redis';
import { errorResponse } from '../../../lib/mcp/http';

// Starts the authorization_code + PKCE (S256) flow: register the client if
// needed, stash the code_verifier server-side keyed by `state`, and redirect
// the browser to Silpo's /authorize. The verifier never reaches the client.
export default async function handler(): Promise<Response> {
  let clientId: string;
  try {
    clientId = (await ensureClientRegistered()).client_id;
  } catch (e) {
    return errorResponse(e);
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

  return Response.redirect(authorizeUrl.toString(), 302);
}
