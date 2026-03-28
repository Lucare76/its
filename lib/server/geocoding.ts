type GeoResult = {
  lat: number;
  lng: number;
  displayName: string;
} | null;

type ReverseGeoResult = {
  address: string | null;
  city: string | null;
  displayName: string | null;
} | null;

const reverseGeocodeCache = new Map<string, { value: ReverseGeoResult; expiresAt: number }>();
const REVERSE_GEOCODE_TTL_MS = 15 * 60 * 1000;

function reverseCacheKey(lat: number, lng: number) {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

export async function geocodeCity(city: string): Promise<GeoResult> {
  try {
    const encoded = encodeURIComponent(`${city}, Italy`);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=it`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ischia-transfer-pms/1.0",
        "Accept-Language": "it"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!data.length) return null;
    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      displayName: data[0].display_name
    };
  } catch {
    return null;
  }
}

type ReverseNominatimAddress = {
  road?: string;
  pedestrian?: string;
  footway?: string;
  path?: string;
  house_number?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
};

export async function reverseGeocodeCoordinates(lat: number, lng: number): Promise<ReverseGeoResult> {
  const cacheKey = reverseCacheKey(lat, lng);
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&format=jsonv2&addressdetails=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ischia-transfer-pms/1.0",
        "Accept-Language": "it"
      },
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) {
      reverseGeocodeCache.set(cacheKey, { value: null, expiresAt: Date.now() + 60_000 });
      return null;
    }
    const data = (await res.json()) as { display_name?: string; address?: ReverseNominatimAddress };
    const address = data.address ?? {};
    const street = address.road ?? address.pedestrian ?? address.footway ?? address.path ?? null;
    const houseNumber = address.house_number?.trim() ?? "";
    const locality = address.city ?? address.town ?? address.village ?? address.municipality ?? address.county ?? null;
    const neighborhood = address.suburb ?? address.neighbourhood ?? null;
    const formattedAddress = street ? `${street}${houseNumber ? ` ${houseNumber}` : ""}` : neighborhood;
    const value: ReverseGeoResult = {
      address: formattedAddress ?? null,
      city: locality,
      displayName: data.display_name ?? null
    };
    reverseGeocodeCache.set(cacheKey, { value, expiresAt: Date.now() + REVERSE_GEOCODE_TTL_MS });
    return value;
  } catch {
    reverseGeocodeCache.set(cacheKey, { value: null, expiresAt: Date.now() + 60_000 });
    return null;
  }
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

type NominatimAddress = {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  suburb?: string;
  county?: string;
};

/**
 * Geocodifica una stringa di destinazione e restituisce i nomi di città/comune
 * che Nominatim ha riconosciuto. Usato come fallback quando il matching testuale fallisce.
 */
export async function geocodeCityName(query: string): Promise<string[]> {
  try {
    const encoded = encodeURIComponent(`${query}, Italy`);
    const url = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1&countrycodes=it&addressdetails=1`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "ischia-transfer-pms/1.0",
        "Accept-Language": "it"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ address?: NominatimAddress }>;
    if (!data.length || !data[0].address) return [];
    const addr = data[0].address;
    // Restituisce in ordine di specificità: city > town > village > municipality > suburb
    return [addr.city, addr.town, addr.village, addr.municipality, addr.suburb]
      .filter((v): v is string => !!v && v.trim().length > 0);
  } catch {
    return [];
  }
}
