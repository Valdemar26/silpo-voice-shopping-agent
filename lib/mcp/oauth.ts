import { acquireLock, releaseLock, setIfLockHeld } from '../redis-lock';
import {
  deleteClientCredentials,
  deleteTokens,
  getClientCredentials,
  getTokens,
  McpClientCredentials,
  McpTokens,
  saveClientCredentials,
  tokensKey,
} from './redis';

// Thrown when Silpo's token endpoint rejects our registered client or the
// stored refresh token outright (not a transient failure) — the caller
// cannot recover without sending the user through /api/mcp/auth/login again.
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReauthRequiredError';
  }
}

// From https://mcp.silpo.ua/.well-known/oauth-authorization-server
export const AUTHORIZATION_ENDPOINT = 'https://mcp.silpo.ua/authorize';
export const TOKEN_ENDPOINT = 'https://mcp.silpo.ua/token';
export const REGISTRATION_ENDPOINT = 'https://mcp.silpo.ua/register';

const CLIENT_LOCK_KEY = 'mcp:client:lock';
const CLIENT_LOCK_TTL_SECONDS = 30;

// Only S256 is used for PKCE. The server also advertises "plain", but that method
// sends the verifier in the clear and defeats the point of PKCE — never use it.
export const CODE_CHALLENGE_METHOD = 'S256';

const TOKEN_EXPIRY_SKEW_MS = 60_000;

// Guards against a hung TOKEN_ENDPOINT/REGISTRATION_ENDPOINT call outliving
// the refresh/registration lock it's running under (both locks' TTLs are
// well above this, so a timeout here always fires before the lock could
// expire out from under us).
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

const REFRESH_LOCK_TTL_SECONDS = 15;
const REFRESH_POLL_INTERVAL_MS = 250;
const REFRESH_POLL_TIMEOUT_MS = 5_000;

const refreshLockKey = (sessionId: string): string => `mcp:refresh:lock:${sessionId}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requireAppBaseUrl(): string {
  const url = process.env['APP_BASE_URL'];
  if (!url) throw new Error('APP_BASE_URL is not configured');
  return url.replace(/\/$/, '');
}

export function getRedirectUri(): string {
  return `${requireAppBaseUrl()}/api/mcp/auth/callback`;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

// OAuth error responses are JSON with an `error` field (RFC 6749 §5.2), e.g.
// {"error":"invalid_client"} — used to tell "client/grant rejected outright"
// apart from a transient failure, which needs a different recovery (see
// ReauthRequiredError above).
async function readTokenEndpointError(response: Response): Promise<{ code?: string; body: string }> {
  const body = await readErrorBody(response);
  try {
    const parsed: unknown = JSON.parse(body);
    const code =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : undefined;
    return { code, body };
  } catch {
    return { body };
  }
}

export async function ensureClientRegistered(): Promise<McpClientCredentials> {
  const existing = await getClientCredentials();
  if (existing) return existing;

  const lockToken = await acquireLock(CLIENT_LOCK_KEY, CLIENT_LOCK_TTL_SECONDS);
  if (!lockToken) {
    // Another request is mid-registration. Give it a moment and use its result
    // instead of racing to register a second client.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const afterWait = await getClientCredentials();
    if (afterWait) return afterWait;
    throw new Error('Client registration is already in progress — retry shortly');
  }

  try {
    // Re-check inside the lock in case registration finished while we waited for it.
    const afterLock = await getClientCredentials();
    if (afterLock) return afterLock;

    const response = await fetch(REGISTRATION_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [getRedirectUri()],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Silpo Voice Ordering Agent',
      }),
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Dynamic Client Registration failed: ${response.status} ${await readErrorBody(response)}`);
    }

    const data = await response.json();
    const creds: McpClientCredentials = {
      client_id: data.client_id,
      client_secret: data.client_secret,
    };
    await saveClientCredentials(creds);
    return creds;
  } finally {
    await releaseLock(CLIENT_LOCK_KEY, lockToken);
  }
}

function toTokens(data: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}): McpTokens {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // Default to a conservative 1 hour if the server omits expires_in.
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

export async function exchangeCodeForTokens(sessionId: string, code: string, codeVerifier: string): Promise<McpTokens> {
  const creds = await getClientCredentials();
  if (!creds) throw new Error('MCP client is not registered — call ensureClientRegistered() first');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: creds.client_id,
    code_verifier: codeVerifier,
  });
  if (creds.client_secret) body.set('client_secret', creds.client_secret);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const { code: errorCode, body: errorBody } = await readTokenEndpointError(response);
    if (errorCode === 'invalid_client') {
      await deleteClientCredentials();
      await deleteTokens(sessionId);
      throw new ReauthRequiredError('Silpo rejected the registered OAuth client during code exchange');
    }
    throw new Error(`Token exchange failed: ${response.status} ${errorBody}`);
  }

  return toTokens(await response.json());
}

export async function refreshTokens(sessionId: string, refreshToken: string): Promise<McpTokens> {
  const creds = await getClientCredentials();
  if (!creds) throw new Error('MCP client is not registered — call ensureClientRegistered() first');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.client_id,
  });
  if (creds.client_secret) body.set('client_secret', creds.client_secret);

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const { code: errorCode, body: errorBody } = await readTokenEndpointError(response);
    if (errorCode === 'invalid_client') {
      await deleteClientCredentials();
      await deleteTokens(sessionId);
      throw new ReauthRequiredError('Silpo rejected the registered OAuth client during token refresh');
    }
    throw new Error(`Token refresh failed: ${response.status} ${errorBody}`);
  }

  const data = await response.json();
  // Some servers omit refresh_token on renewal, meaning "reuse the one you sent".
  return toTokens({ ...data, refresh_token: data.refresh_token ?? refreshToken });
}

// With forceRefresh (called after an upstream 401), expires_at can't be
// trusted — the server rejected a token our own clock still thinks is good —
// so "fresh" instead means "no longer the token that got the 401".
function isFresh(tokens: McpTokens, forceRefresh: boolean, staleAccessToken: string | undefined): boolean {
  if (forceRefresh) return tokens.access_token !== staleAccessToken;
  return tokens.expires_at - TOKEN_EXPIRY_SKEW_MS > Date.now();
}

// Lost the race for the refresh lock: poll Redis for whatever the winner
// writes instead of refreshing ourselves too.
async function waitForFreshTokens(
  sessionId: string,
  forceRefresh: boolean,
  staleAccessToken: string | undefined,
): Promise<string> {
  const deadline = Date.now() + REFRESH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(REFRESH_POLL_INTERVAL_MS);
    const current = await getTokens(sessionId);
    if (current && isFresh(current, forceRefresh, staleAccessToken)) {
      return current.access_token;
    }
  }
  throw new Error('Timed out waiting for a concurrent token refresh to finish');
}

/**
 * Returns a valid access token, transparently refreshing it when it is
 * missing or close to expiry. Pass `forceRefresh` + the access token that
 * just got a 401 from upstream to skip the (possibly stale) cached expiry
 * check — "fresh" then means "different from that token" rather than
 * "expires_at says so".
 *
 * Concurrent callers for the same session serialize on
 * `mcp:refresh:lock:{sessionId}`: the lock winner does the actual refresh,
 * everyone else polls Redis for the result instead of refreshing too (which
 * would burn the refresh token twice and likely get one caller a 400 from
 * Silpo).
 */
export async function ensureValidAccessToken(
  sessionId: string,
  forceRefresh = false,
  staleAccessToken?: string,
): Promise<string> {
  const tokens = await getTokens(sessionId);
  if (!tokens) {
    throw new Error('Not authenticated with Silpo MCP — visit /api/mcp/auth/login first');
  }

  if (isFresh(tokens, forceRefresh, staleAccessToken)) {
    return tokens.access_token;
  }

  const lockKey = refreshLockKey(sessionId);
  const lockToken = await acquireLock(lockKey, REFRESH_LOCK_TTL_SECONDS);

  if (!lockToken) {
    return waitForFreshTokens(sessionId, forceRefresh, staleAccessToken);
  }

  try {
    // Re-read under the lock: another request may have already refreshed
    // while we were acquiring it.
    const current = await getTokens(sessionId);
    if (current && isFresh(current, forceRefresh, staleAccessToken)) {
      return current.access_token;
    }

    if (!current?.refresh_token) {
      throw new Error('Access token expired and no refresh token is available — re-authenticate via /api/mcp/auth/login');
    }

    const refreshed = await refreshTokens(sessionId, current.refresh_token);
    const wrote = await setIfLockHeld(lockKey, lockToken, tokensKey(sessionId), refreshed);
    if (wrote) return refreshed.access_token;

    // Our lock expired mid-refresh (TTL ran out under a slow upstream call).
    // Someone else may already be refreshing — or have refreshed — on our
    // behalf, so don't trust the result we just computed; defer to whatever
    // is actually in Redis now.
    const afterLockLoss = await getTokens(sessionId);
    if (!afterLockLoss) {
      throw new Error('Not authenticated with Silpo MCP — visit /api/mcp/auth/login first');
    }
    return afterLockLoss.access_token;
  } finally {
    await releaseLock(lockKey, lockToken);
  }
}
