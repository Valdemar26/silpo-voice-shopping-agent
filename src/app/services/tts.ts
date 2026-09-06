import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TtsService {
  // Voice is a nice-to-have layered on top of the always-visible text
  // result, never a gate on it — any failure here (network, Respeecher
  // outage, autoplay block) is swallowed so it can never interrupt the
  // agent flow or leave the user without the result.
  async speak(text: string): Promise<void> {
    try {
      const response = await fetch('/api/tts/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) return;

      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      audio.addEventListener('ended', () => URL.revokeObjectURL(url));
      audio.addEventListener('error', () => URL.revokeObjectURL(url));
      await audio.play();
    } catch {
      // ignored — see comment above
    }
  }
}
