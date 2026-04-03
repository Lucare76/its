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

