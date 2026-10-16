import { Redis } from '@upstash/redis';

let client: Redis | undefined;

// Upstash's REST client talks plain HTTPS, so it works on the Edge runtime unlike
// most Redis clients which need a raw TCP socket.
export function getRedis(): Redis {
  if (!client) {
    const url = process.env['UPSTASH_REDIS_REST_URL'];
    const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
    if (!url || !token) {
      throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not configured');
    }
    client = new Redis({ url, token });
  }
  return client;
}

export interface McpClientCredentials {
  client_id: string;
  client_secret?: string;
}

export interface McpTokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
}

// Silpo's refresh-token lifetime isn't documented anywhere — this is an
// assumption. Access tokens we've actually seen (expires_in, checked live in
// Redis) run ~30 days, so the tokens key needs to outlive at least that or it
// could vanish before a refresh ever gets a chance to run; 90 days gives
// margin on top without keeping dead sessions around indefinitely.
export const TOKENS_TTL_SECONDS = 90 * 24 * 60 * 60;

const CLIENT_KEY = 'mcp:client';
// Keyed by the per-browser session id (lib/mcp/session.ts) — was a single
// fixed key ('mcp:tokens:default') back when this was a single-user
// deployment. mcp:client above stays global on purpose: it's the one
// Dynamic-Client-Registration credential shared by every visitor, not
// per-user data.
export const tokensKey = (sessionId: string): string => `mcp:tokens:${sessionId}`;
// This is the MCP *transport* session (the Mcp-Session-Id header
// mcp.silpo.ua hands back from `initialize`), tied 1:1 to whichever access
// token established it — so it must be keyed by the same per-browser
// sessionId as the tokens above, or two visitors could end up sharing (and
// fighting over) one upstream MCP session.
const mcpSessionKey = (sessionId: string) => `mcp:session_id:${sessionId}`;
const oauthStateKey = (state: string) => `mcp:oauth:state:${state}`;

export async function getClientCredentials(): Promise<McpClientCredentials | null> {
  return getRedis().get<McpClientCredentials>(CLIENT_KEY);
}

export async function saveClientCredentials(creds: McpClientCredentials): Promise<void> {
  await getRedis().set(CLIENT_KEY, creds);
}

// Invalid_client from the token endpoint means Silpo no longer recognizes
// our registered DCR client — drop it so the next ensureClientRegistered()
// call registers a fresh one instead of retrying the same rejected creds.
export async function deleteClientCredentials(): Promise<void> {
  await getRedis().del(CLIENT_KEY);
}

export async function getTokens(sessionId: string): Promise<McpTokens | null> {
  return getRedis().get<McpTokens>(tokensKey(sessionId));
}

export async function saveTokens(sessionId: string, tokens: McpTokens): Promise<void> {
  await getRedis().set(tokensKey(sessionId), tokens, { ex: TOKENS_TTL_SECONDS });
}

export async function deleteTokens(sessionId: string): Promise<void> {
  await getRedis().del(tokensKey(sessionId));
}

export async function saveOauthState(state: string, codeVerifier: string): Promise<void> {
  // Short TTL: this only needs to survive the redirect round-trip to /authorize and back.
  await getRedis().set(oauthStateKey(state), { code_verifier: codeVerifier }, { ex: 600 });
}

export async function consumeOauthState(state: string): Promise<{ code_verifier: string } | null> {
  const key = oauthStateKey(state);
  const data = await getRedis().get<{ code_verifier: string }>(key);
  if (data) await getRedis().del(key);
  return data;
}

export async function getMcpSessionId(sessionId: string): Promise<string | null> {
  return getRedis().get<string>(mcpSessionKey(sessionId));
}

export async function saveMcpSessionId(sessionId: string, mcpSessionId: string): Promise<void> {
  await getRedis().set(mcpSessionKey(sessionId), mcpSessionId);
}

export async function clearMcpSessionId(sessionId: string): Promise<void> {
  await getRedis().del(mcpSessionKey(sessionId));
}
