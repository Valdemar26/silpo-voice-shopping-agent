import { Injectable } from '@angular/core';

export type ShareOutcome = 'shared' | 'copied' | 'failed';

@Injectable({ providedIn: 'root' })
export class ShareService {
  // Prefers the native share sheet (Telegram, SMS, etc. on mobile) and falls
  // back to clipboard — either outcome is a legitimate way to hand the text
  // off, only a real failure on both paths counts as 'failed'.
  async share(text: string): Promise<ShareOutcome> {
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({ text });
        return 'shared';
      } catch (e) {
        // User closing the native share sheet is not a failure.
        if (e instanceof DOMException && e.name === 'AbortError') return 'shared';
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      return 'copied';
    } catch {
      return 'failed';
    }
  }
}
