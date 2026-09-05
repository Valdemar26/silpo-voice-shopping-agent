import { ensureValidAccessToken } from './oauth';
import { clearMcpSessionId, getMcpSessionId, saveMcpSessionId } from './redis';

const MCP_ENDPOINT = 'https://mcp.silpo.ua/mcp';
const PROTOCOL_VERSION = '2025-06-18';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

function authHeaders(accessToken: string, sessionId?: string | null): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
}

// Streamable HTTP responses arrive as plain JSON or as an SSE stream carrying a
// single JSON-RPC message — handle both.
async function parseJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    return response.json();
  }

  const text = await response.text();
  const dataLines = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());

  for (const line of dataLines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // keep looking at earlier data: lines
    }
  }
  throw new Error('MCP response: no parsable JSON-RPC message in SSE stream');
}

async function postRpc(accessToken: string, sessionId: string | null, body: unknown): Promise<Response> {
  return fetch(MCP_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(accessToken, sessionId),
    body: JSON.stringify(body),
  });
}

async function initializeSession(accessToken: string): Promise<string | null> {
  const response = await postRpc(accessToken, null, {
    jsonrpc: '2.0',
    id: 'init',
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'silpo-voice-agent', version: '1.0.0' },
    },
  });

  if (!response.ok) {
    throw new Error(`MCP initialize failed: ${response.status} ${await response.text()}`);
  }

  await parseJsonRpcResponse(response);
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId) await saveMcpSessionId(sessionId);
  return sessionId;
}

async function getOrInitSessionId(accessToken: string): Promise<string | null> {
  const cached = await getMcpSessionId();
  if (cached) return cached;
  return initializeSession(accessToken);
}

/**
 * Calls an MCP tool with the stored Silpo access token substituted in.
 * Callers only deal with tool name + arguments; auth, token refresh and MCP
 * session bookkeeping happen here.
 */
export async function callMcpTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  let accessToken = await ensureValidAccessToken();
  let sessionId = await getOrInitSessionId(accessToken);

  const rpcBody = {
    jsonrpc: '2.0',
    id: `${name}-${Math.random().toString(36).slice(2)}`,
    method: 'tools/call',
    params: { name, arguments: args },
  };

  let response = await postRpc(accessToken, sessionId, rpcBody);

  if (response.status === 401) {
    accessToken = await ensureValidAccessToken(true);
    response = await postRpc(accessToken, sessionId, rpcBody);
  }

  if (response.status === 400 || response.status === 404) {
    // Likely an expired/unknown MCP session (not an OAuth problem) — re-init once.
    await clearMcpSessionId();
    sessionId = await initializeSession(accessToken);
    response = await postRpc(accessToken, sessionId, rpcBody);
  }

  if (!response.ok) {
    throw new Error(`MCP tool call "${name}" failed: ${response.status} ${await response.text()}`);
  }

  const payload = await parseJsonRpcResponse(response);
  if (payload.error) {
    throw new Error(`MCP tool call "${name}" returned an error ${payload.error.code}: ${payload.error.message}`);
  }
  return payload.result;
}
