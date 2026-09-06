export const config = { runtime: 'edge' };

import { errorResponse, json } from '../../lib/mcp/http';

interface ReverseGeocodeBody {
  latitude?: unknown;
  longitude?: unknown;
}

interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  house_number?: string;
  city?: string;
  town?: string;
  village?: string;
}

// silpo_find_address only accepts free-text — there's no coordinate-search
// variant — so this reverse-geocodes via Nominatim (OpenStreetMap) and hands
// back plain text for the address field, which the user can still edit
// before running. No API key needed; a distinctive User-Agent is required by
// Nominatim's usage policy for non-browser clients.
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let body: ReverseGeocodeBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { latitude, longitude } = body;
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return json({ error: 'latitude and longitude must be numbers' }, 400);
  }

  try {
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(latitude));
    url.searchParams.set('lon', String(longitude));
    url.searchParams.set('accept-language', 'uk');
    url.searchParams.set('zoom', '18');

    const response = await fetch(url, {
      headers: { 'User-Agent': 'silpo-voice-shopping-agent/1.0 (personal project)' },
    });

    if (!response.ok) {
      return json({ error: `Reverse geocoding failed: HTTP ${response.status}` }, 502);
    }

    const data = (await response.json()) as { address?: NominatimAddress; display_name?: string };
    const address = data.address ?? {};
    const city = address.city ?? address.town ?? address.village ?? '';
    const street = address.road ?? address.pedestrian ?? '';
    const house = address.house_number ?? '';

    const formatted = [city, street, house].filter((p) => p.length > 0).join(', ') || data.display_name;
    if (!formatted) {
      return json({ error: 'Не вдалося визначити адресу за координатами' }, 502);
    }

    // GPS accuracy means the nearest OSM point often isn't a mapped building
    // node, so Nominatim frequently resolves only to street level — that
    // street-only text later confuses silpo_find_address into returning
    // several ambiguous candidates instead of the one real error it should
    // be: "no house number". Surface it explicitly here instead.
    return json({ address: formatted, houseNumberMissing: house.length === 0 }, 200);
  } catch (e) {
    return errorResponse(e);
  }
}
