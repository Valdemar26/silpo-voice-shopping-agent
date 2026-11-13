import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TtsService {
  // Voice is a nice-to-have layered on top of the always-visible text
  // result, never a gate on it — any failure here (network, Respeecher
  // outage, autoplay block) is swallowed so it can never interrupt the
  // agent flow or leave the user without the result.
  async speak(text: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const responseAt = performance.now();
      if (!response.ok) {
        console.info(`[tts] /api/tts/speak HTTP ${response.status} after ${Math.round(responseAt - startedAt)} ms`);
        return;
      }

      const url = URL.createObjectURL(await response.blob());
      const bodyAt = performance.now();
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url));
      audio.addEventListener('error', () => URL.revokeObjectURL(url));
      await audio.play();
      const playingAt = performance.now();
      console.info(
        `[tts] ${text.length} chars: response ${Math.round(responseAt - startedAt)} ms, ` +
          `audio downloaded ${Math.round(bodyAt - startedAt)} ms, playback started ${Math.round(playingAt - startedAt)} ms`,
      );
    } catch {
      // ignored — see comment above
    }
  }
}
