import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { isWithinIschiaBounds, ZONE_TO_CITY } from "@/lib/hotel-geocoding";

export const runtime = "nodejs";

type NominatimResult = {
  lat: string;
  lon: string;
  display_name?: string;
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  class?: string;
  type?: string;
  addresstype?: string;
};

type HotelLookupRow = {
  name: string | null;
  address: string | null;
  city: string | null;
  zone: string | null;
};

type GeoLookupResult = {
  lat: number;
  lng: number;
  label: string;
  place_id: string | null;
  score: number;
  query: string;
};

const knownHotelFallbacks: Array<{
  match: RegExp;
  lat: number;
  lng: number;
  label: string;
  placeId: string;
}> = [
  {
    match: /villa\s+franca|(?:provinciale\s+lacco.*\b211\b.*forio)|(?:forio.*provinciale\s+lacco.*\b211\b)|(?:forio\s*-\s*lacco.*\b211\b)/i,
    lat: 40.747013,
    lng: 13.872981,
    label: "Hotel Villa Franca, Strada Statale Forio - Lacco 211, Forio",
    placeId: "known:hotel-villa-franca-forio"
  }
];

function precisionScore(result: NominatimResult) {
  const tokens = [result.class, result.type, result.addresstype].filter(Boolean).join(" ").toLowerCase();
  if (/\b(house|building|hotel|guest_house|resort|tourism|amenity)\b/.test(tokens)) return 100;
  if (/\b(road|street|residential)\b/.test(tokens)) return 70;
  if (/\b(suburb|quarter|neighbourhood|village|town|city)\b/.test(tokens)) return 30;
  return 45;
}

function compact(value: string | null | undefined) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeAddressForSearch(value: string | null | undefined) {
  return compact(value)
    .replace(/\s+-\s+/g, ", ")
    .replace(/,\s*\d{5}\b.*$/i, "")
    .replace(/\b\d{5}\b/g, " ")
    .replace(/\bNA\b/gi, "Napoli")
    .replace(/\s+/g, " ")
    .trim();
}

function streetNumberVariant(address: string) {
  const parts = address.split(",").map((part) => compact(part)).filter(Boolean);
  const numberPart = [...parts].reverse().find((part) => /^\d+[a-z]?(?:\s*[/-]\s*\d+[a-z]?)?$/i.test(part));
  if (!parts[0] || !numberPart) return null;
  return `${parts[0]} ${numberPart}`;
}

function uniqueQueries(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const query = compact(value);
    const key = query.toLowerCase();
    if (!query || query.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out.slice(0, 7);
}

function cityFromZone(zone: string | null | undefined) {
  const matched = Object.entries(ZONE_TO_CITY).find(([key]) => key.toLowerCase() === compact(zone).toLowerCase());
  return matched?.[1] ?? compact(zone);
}

function buildQueries(rawQuery: string, hotel?: HotelLookupRow | null) {
  const address = normalizeAddressForSearch(hotel?.address);
  const hotelName = compact(hotel?.name);
  const zoneCity = cityFromZone(hotel?.zone);
  const storedCity = compact(hotel?.city);
  const city = storedCity && !(storedCity.toLowerCase() === "ischia" && zoneCity && zoneCity.toLowerCase() !== "ischia")
    ? storedCity
    : zoneCity || storedCity;
  const zone = compact(hotel?.zone);
  const streetNumber = streetNumberVariant(address);
  const baseQuery = compact(rawQuery).replace(/,\s*Ischia,\s*Italia$/i, "");

  return uniqueQueries([
    baseQuery,
    streetNumber && city ? `${streetNumber}, ${city}, Campania, Italia` : null,
    hotelName && address && city ? `${hotelName}, ${address}, ${city}, Campania, Italia` : null,
    address && city ? `${address}, ${city}, Campania, Italia` : null,
    address && zone ? `${address}, ${zone}, Isola d'Ischia, Campania, Italia` : null,
    address ? `${address}, Isola d'Ischia, Campania, Italia` : null,
    hotelName && city ? `${hotelName}, ${city}, Ischia, Campania, Italia` : null,
    rawQuery
  ]);
}

function knownFallbackResults(rawQuery: string, hotel?: HotelLookupRow | null): GeoLookupResult[] {
  const haystack = [rawQuery, hotel?.name, hotel?.address, hotel?.city, hotel?.zone].filter(Boolean).join(" ");
  return knownHotelFallbacks
    .filter((item) => item.match.test(haystack))
    .map((item) => ({
      lat: item.lat,
      lng: item.lng,
      label: item.label,
      place_id: item.placeId,
      score: 95,
      query: "fallback verificabile"
    }));
}

async function searchNominatim(query: string) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "8");
  url.searchParams.set("countrycodes", "it");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("namedetails", "1");
  url.searchParams.set("viewbox", "13.82,40.67,13.99,40.77");
  url.searchParams.set("bounded", "1");

  const response = await fetch(url.toString(), {
    headers: {
      "Accept-Language": "it",
      "User-Agent": "IschiaTransfer/1.0 (info@campanialimousine.com)"
    }
  });

  if (!response.ok) return null;
  return (await response.json()) as NominatimResult[];
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const q = request.nextUrl.searchParams.get("q")?.trim();
  const hotelId = request.nextUrl.searchParams.get("hotel_id")?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ ok: true, results: [] });
  }

  let hotel: HotelLookupRow | null = null;
  if (hotelId) {
    const { data } = await auth.admin
      .from("hotels")
      .select("name,address,city,zone")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", hotelId)
      .maybeSingle();
    hotel = (data as HotelLookupRow | null) ?? null;
  }

  const queries = buildQueries(q, hotel);
  const collected: Array<NominatimResult & { query: string }> = [];
  for (const query of queries) {
    const data = await searchNominatim(query);
    if (!data) continue;
    collected.push(...data.map((item) => ({ ...item, query })));
    if (collected.some((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);
      return Number.isFinite(lat) && Number.isFinite(lng) && isWithinIschiaBounds(lat, lng) && precisionScore(item) >= 70;
    })) break;
  }

  const fallbackResults = knownFallbackResults(q, hotel);
  if (collected.length === 0) {
    return NextResponse.json({ ok: true, results: fallbackResults, queries });
  }

  const results = [
    ...fallbackResults,
    ...collected
    .map((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isWithinIschiaBounds(lat, lng)) return null;
      return {
        lat,
        lng,
        label: item.display_name ?? q,
        place_id: item.place_id != null ? String(item.place_id) : item.osm_type && item.osm_id != null ? `${item.osm_type}:${item.osm_id}` : null,
        score: precisionScore(item),
        query: item.query
      };
    })
    .filter((item): item is { lat: number; lng: number; label: string; place_id: string | null; score: number; query: string } => Boolean(item))
  ]
    .filter((item, index, all) => all.findIndex((other) => Math.abs(other.lat - item.lat) < 0.00001 && Math.abs(other.lng - item.lng) < 0.00001) === index)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return NextResponse.json({ ok: true, results, queries });
}
