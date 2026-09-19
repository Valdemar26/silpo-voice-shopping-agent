// Per-browser session id, carried in an httpOnly cookie — the piece that lets
// Redis move from one fixed `mcp:tokens:default` slot (see redis.ts) to a
// slot per visitor. Confirmed working on Vercel's Edge runtime (crypto.randomUUID()
// + Set-Cookie, including HttpOnly/Secure/SameSite/Max-Age) via a throwaway
// probe endpoint before wiring this in.
//
// Deliberately explicit (a value read from the request and threaded through
// every call, not an ambient/global "current session"): the Edge runtime
// doesn't have Node's async_hooks, so there is no AsyncLocalStorage to hang a
// request-scoped context off, and a module-level variable would leak across
// concurrent requests sharing the same isolate. Passing it as a plain
// argument is the safe pattern here, same as Cloudflare Workers' env/ctx.
const SESSION_COOKIE_NAME = 'sid';
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export interface RequestSession {
  sessionId: string;
  // True when this request had no session cookie yet, i.e. a first visit —
  // withSessionCookie() only needs to (re-)issue Set-Cookie in that case.
  isNew: boolean;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

/** Reads the `sid` cookie off an incoming request, or mints a fresh one for a first-time visitor. */
export function readOrCreateSessionId(req: Request): RequestSession {
  const existing = readCookie(req, SESSION_COOKIE_NAME);
  if (existing) return { sessionId: existing, isNew: false };
  return { sessionId: crypto.randomUUID(), isNew: true };
}

/**
 * Returns `response` with the session cookie attached when `session` was just
 * minted (a no-op on every later request, once the browser already has it).
 * Call this on every return path of a handler — success and error alike —
 * so a first-time visitor's very first response (even a 401 "not
 * authenticated yet") still comes back with the cookie set.
 */
export function withSessionCookie(response: Response, session: RequestSession): Response {
  if (!session.isNew) return response;

  const headers = new Headers(response.headers);
  headers.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${session.sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`,
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
