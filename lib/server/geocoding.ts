type GeoResult = {
  lat: number;
  lng: number;
  displayName: string;
} | null;

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
