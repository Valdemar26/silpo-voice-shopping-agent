import { Injectable } from '@angular/core';

export type GeolocationOutcome =
  | { kind: 'success'; latitude: number; longitude: number }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

@Injectable({ providedIn: 'root' })
export class GeolocationService {
  // Checked fresh on every call rather than cached at construction — a
  // browser's support for this doesn't normally change mid-session, but an
  // insecure (non-HTTPS) context can make geolocation unavailable at any
  // point, so there's no reason to trust a value captured once at startup.
  get supported(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.geolocation;
  }

  getCurrentPosition(): Promise<GeolocationOutcome> {
    if (!this.supported) return Promise.resolve({ kind: 'unsupported' });

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) =>
          resolve({ kind: 'success', latitude: position.coords.latitude, longitude: position.coords.longitude }),
        (error) => {
          resolve(error.code === error.PERMISSION_DENIED ? { kind: 'denied' } : { kind: 'unavailable' });
        },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    });
  }
}
