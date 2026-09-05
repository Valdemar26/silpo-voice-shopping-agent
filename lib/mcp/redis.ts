import { Redis } from '@upstash/redis';

let client: Redis | undefined;

// Upstash's REST client talks plain HTTPS, so it works on the Edge runtime unlike
// most Redis clients which need a raw TCP socket.
export function getRedis(): Redis {
  if (!client) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
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

const CLIENT_KEY = 'mcp:client';
const CLIENT_LOCK_KEY = 'mcp:client:lock';
// Single-user deployment: one fixed key instead of a per-session lookup.
const TOKENS_KEY = 'mcp:tokens:default';
const SESSION_KEY = 'mcp:session_id';
const oauthStateKey = (state: string) => `mcp:oauth:state:${state}`;

export async function getClientCredentials(): Promise<McpClientCredentials | null> {
  return getRedis().get<McpClientCredentials>(CLIENT_KEY);
}

export async function saveClientCredentials(creds: McpClientCredentials): Promise<void> {
  await getRedis().set(CLIENT_KEY, creds);
}

export async function acquireClientRegistrationLock(): Promise<boolean> {
  const result = await getRedis().set(CLIENT_LOCK_KEY, '1', { nx: true, ex: 30 });
  return result === 'OK';
}

export async function releaseClientRegistrationLock(): Promise<void> {
  await getRedis().del(CLIENT_LOCK_KEY);
}

export async function getTokens(): Promise<McpTokens | null> {
  return getRedis().get<McpTokens>(TOKENS_KEY);
}

export async function saveTokens(tokens: McpTokens): Promise<void> {
  await getRedis().set(TOKENS_KEY, tokens);
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

export async function getMcpSessionId(): Promise<string | null> {
  return getRedis().get<string>(SESSION_KEY);
}

export async function saveMcpSessionId(sessionId: string): Promise<void> {
  await getRedis().set(SESSION_KEY, sessionId);
}

export async function clearMcpSessionId(): Promise<void> {
  await getRedis().del(SESSION_KEY);
}
