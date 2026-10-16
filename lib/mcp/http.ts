import { ReauthRequiredError } from './oauth';

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(e: unknown, status = 502): Response {
  if (e instanceof ReauthRequiredError) {
    return json({ error: e.message, code: 'reauth_required' }, 401);
  }
  return json({ error: e instanceof Error ? e.message : 'Unexpected error' }, status);
}
