import {
  acquireClientRegistrationLock,
  getClientCredentials,
  getTokens,
  McpClientCredentials,
  McpTokens,
  releaseClientRegistrationLock,
  saveClientCredentials,
  saveTokens,
} from './redis';

// From https://mcp.silpo.ua/.well-known/oauth-authorization-server
export const AUTHORIZATION_ENDPOINT = 'https://mcp.silpo.ua/authorize';
export const TOKEN_ENDPOINT = 'https://mcp.silpo.ua/token';
export const REGISTRATION_ENDPOINT = 'https://mcp.silpo.ua/register';

// Only S256 is used for PKCE. The server also advertises "plain", but that method
// sends the verifier in the clear and defeats the point of PKCE — never use it.
export const CODE_CHALLENGE_METHOD = 'S256';

const TOKEN_EXPIRY_SKEW_MS = 60_000;

function requireAppBaseUrl(): string {
  const url = process.env.APP_BASE_URL;
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

export async function ensureClientRegistered(): Promise<McpClientCredentials> {
  const existing = await getClientCredentials();
  if (existing) return existing;

  const gotLock = await acquireClientRegistrationLock();
  if (!gotLock) {
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
    await releaseClientRegistrationLock();
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

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<McpTokens> {
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
  });

  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await readErrorBody(response)}`);
  }

  return toTokens(await response.json());
}

export async function refreshTokens(refreshToken: string): Promise<McpTokens> {
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
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await readErrorBody(response)}`);
  }

  const data = await response.json();
  // Some servers omit refresh_token on renewal, meaning "reuse the one you sent".
  return toTokens({ ...data, refresh_token: data.refresh_token ?? refreshToken });
}

/**
 * Returns a valid access token, transparently refreshing it when it is missing
 * or close to expiry. Pass `forceRefresh` after an upstream 401 to skip the
 * (possibly stale) cached expiry check.
 */
export async function ensureValidAccessToken(forceRefresh = false): Promise<string> {
  const tokens = await getTokens();
  if (!tokens) {
    throw new Error('Not authenticated with Silpo MCP — visit /api/mcp/auth/login first');
  }

  if (!forceRefresh && tokens.expires_at - TOKEN_EXPIRY_SKEW_MS > Date.now()) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error('Access token expired and no refresh token is available — re-authenticate via /api/mcp/auth/login');
  }

  const refreshed = await refreshTokens(tokens.refresh_token);
  await saveTokens(refreshed);
  return refreshed.access_token;
}
