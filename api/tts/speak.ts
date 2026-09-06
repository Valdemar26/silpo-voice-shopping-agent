export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../lib/mcp/http';

interface SpeakBody {
  text?: unknown;
}

// Ukrainian-primary endpoint — the whole UI/voice agent is uk-UA.
// https://space.respeecher.com/docs
const RESPEECHER_TTS_URL = 'https://api.respeecher.com/v1/public/tts/ua-rt/tts/bytes';

// Server-side only: the API key must never reach the client, so this call
// happens from the Edge Function, not the browser.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: SpeakBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return json({ error: 'text must be a non-empty string' }, 400);
  }

  const apiKey = process.env['RESPEECHER_API_KEY'];
  const voiceId = process.env['RESPEECHER_VOICE_ID'];
  if (!apiKey || !voiceId) {
    return json({ error: 'TTS not configured: missing RESPEECHER_API_KEY or RESPEECHER_VOICE_ID' }, 503);
  }

  try {
    const response = await fetch(RESPEECHER_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        transcript: body.text,
        voice: { id: voiceId },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return json({ error: `Respeecher TTS failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}` }, 502);
    }

    const audio = await response.arrayBuffer();
    return new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/wav' } });
  } catch (e) {
    return errorResponse(e);
  }
}
