export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function errorResponse(e: unknown, status = 502): Response {
  return json({ error: e instanceof Error ? e.message : 'Unexpected error' }, status);
}
