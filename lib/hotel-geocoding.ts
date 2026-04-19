export const HOTEL_ZONES = [
  "Ischia Porto",
  "Ischia Ponte",
  "Casamicciola",
  "Lacco Ameno",
  "Forio",
  "Barano",
  "Serrara Fontana"
] as const;

export type HotelZone = (typeof HOTEL_ZONES)[number];

export const zoneCentroids: Record<HotelZone, { lat: number; lng: number }> = {
  "Ischia Porto": { lat: 40.7405, lng: 13.9438 },
  "Ischia Ponte": { lat: 40.7342, lng: 13.9589 },
  Casamicciola: { lat: 40.7478, lng: 13.9099 },
  "Lacco Ameno": { lat: 40.7513, lng: 13.8892 },
  Forio: { lat: 40.7369, lng: 13.8584 },
  Barano: { lat: 40.7144, lng: 13.9466 },
  "Serrara Fontana": { lat: 40.6958, lng: 13.8984 }
};

function normalize(input: string) {
  return input.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

const zoneMatchers: Array<{ zone: HotelZone; keywords: string[] }> = [
  { zone: "Ischia Porto", keywords: ["ischia porto", "porto d'ischia", "porto ischia"] },
  { zone: "Ischia Ponte", keywords: ["ischia ponte", "ponte"] },
  { zone: "Casamicciola", keywords: ["casamicciola"] },
  { zone: "Lacco Ameno", keywords: ["lacco ameno"] },
  { zone: "Forio", keywords: ["forio"] },
  { zone: "Barano", keywords: ["barano"] },
  { zone: "Serrara Fontana", keywords: ["serrara", "fontana", "sant'angelo", "sant angelo"] }
];

export function inferZoneFromText(input: string): HotelZone | null {
  const normalized = normalize(input);
  for (const matcher of zoneMatchers) {
    if (matcher.keywords.some((keyword) => normalized.includes(keyword))) {
      return matcher.zone;
    }
  }
  return null;
}

export const ZONE_TO_CITY: Record<HotelZone, string> = {
  "Ischia Porto":    "Ischia",
  "Ischia Ponte":    "Ischia",
  Casamicciola:      "Casamicciola Terme",
  "Lacco Ameno":     "Lacco Ameno",
  Forio:             "Forio",
  Barano:            "Barano d'Ischia",
  "Serrara Fontana": "Serrara Fontana"
};

export function isMissingCoordinates(lat?: number | null, lng?: number | null) {
  if (lat == null || lng == null) return true;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return true;
  return Math.abs(lat) < 0.000001 && Math.abs(lng) < 0.000001;
}

export const ISCHIA_BOUNDS = {
  minLat: 40.67,
  maxLat: 40.77,
  minLng: 13.82,
  maxLng: 13.99
};

export type HotelGeoIssue =
  | "missing_coordinates"
  | "outside_ischia"
  | "default_centroid"
  | "zone_coordinate_mismatch"
  | "incomplete_address";

export type HotelGeoQuality = {
  issues: HotelGeoIssue[];
  confidence: "ok" | "warning" | "blocked";
  routeUsable: boolean;
  inferredZone: HotelZone | null;
  distanceFromZoneKm: number | null;
};

export function isWithinIschiaBounds(lat?: number | null, lng?: number | null) {
  if (lat == null || lng == null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return lat >= ISCHIA_BOUNDS.minLat && lat <= ISCHIA_BOUNDS.maxLat && lng >= ISCHIA_BOUNDS.minLng && lng <= ISCHIA_BOUNDS.maxLng;
}

export function isIncompleteHotelAddress(address?: string | null) {
  const trimmed = String(address ?? "").trim().toLowerCase();
  return trimmed.length < 6 || trimmed === "ischia";
}

export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const radiusKm = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const hav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(hav), Math.sqrt(1 - hav));
}

export function inferZoneFromCoords(lat: number, lng: number): HotelZone {
  let bestZone: HotelZone = "Ischia Porto";
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const zone of HOTEL_ZONES) {
    const distance = distanceKm({ lat, lng }, zoneCentroids[zone]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestZone = zone;
    }
  }

  return bestZone;
}

export function isDefaultZoneCentroid(lat?: number | null, lng?: number | null) {
  if (isMissingCoordinates(lat, lng)) return false;
  const point = { lat: lat!, lng: lng! };
  return HOTEL_ZONES.some((zone) => distanceKm(point, zoneCentroids[zone]) < 0.12) ||
    distanceKm(point, { lat: 40.7418, lng: 13.9426 }) < 0.12;
}

export function hotelGeoQuality(input: {
  address?: string | null;
  zone?: string | null;
  lat?: number | null;
  lng?: number | null;
}): HotelGeoQuality {
  const issues: HotelGeoIssue[] = [];
  const missing = isMissingCoordinates(input.lat, input.lng);
  let inferredZone: HotelZone | null = null;
  let distanceFromZoneKm: number | null = null;

  if (missing) {
    issues.push("missing_coordinates");
  } else if (!isWithinIschiaBounds(input.lat, input.lng)) {
    issues.push("outside_ischia");
  } else {
    const point = { lat: input.lat!, lng: input.lng! };
    inferredZone = inferZoneFromCoords(point.lat, point.lng);

    if (isDefaultZoneCentroid(point.lat, point.lng)) {
      issues.push("default_centroid");
    }

    const declaredZone = inferZoneFromText(input.zone ?? "") ?? null;
    if (declaredZone) {
      distanceFromZoneKm = distanceKm(point, zoneCentroids[declaredZone]);
      if (inferredZone && inferredZone !== declaredZone && distanceFromZoneKm > 3.2) {
        issues.push("zone_coordinate_mismatch");
      }
    }
  }

  if (isIncompleteHotelAddress(input.address)) {
    issues.push("incomplete_address");
  }

  const blockingIssues = new Set<HotelGeoIssue>([
    "missing_coordinates",
    "outside_ischia",
    "default_centroid",
    "zone_coordinate_mismatch"
  ]);
  const routeUsable = !issues.some((issue) => blockingIssues.has(issue));
  const confidence = routeUsable && issues.length === 0 ? "ok" : routeUsable ? "warning" : "blocked";

  return { issues, confidence, routeUsable, inferredZone, distanceFromZoneKm };
}
