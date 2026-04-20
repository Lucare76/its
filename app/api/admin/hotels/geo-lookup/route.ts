import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { isWithinIschiaBounds } from "@/lib/hotel-geocoding";

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

function precisionScore(result: NominatimResult) {
  const tokens = [result.class, result.type, result.addresstype].filter(Boolean).join(" ").toLowerCase();
  if (/\b(house|building|hotel|guest_house|resort|tourism|amenity)\b/.test(tokens)) return 100;
  if (/\b(road|street|residential)\b/.test(tokens)) return 70;
  if (/\b(suburb|quarter|neighbourhood|village|town|city)\b/.test(tokens)) return 30;
  return 45;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q || q.length < 3) {
    return NextResponse.json({ ok: true, results: [] });
  }

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", q);
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

  if (!response.ok) {
    return NextResponse.json({ ok: false, error: "Ricerca indirizzo non disponibile." }, { status: 502 });
  }

  const data = (await response.json()) as NominatimResult[];
  const results = data
    .map((item) => {
      const lat = Number(item.lat);
      const lng = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !isWithinIschiaBounds(lat, lng)) return null;
      return {
        lat,
        lng,
        label: item.display_name ?? q,
        place_id: item.place_id != null ? String(item.place_id) : item.osm_type && item.osm_id != null ? `${item.osm_type}:${item.osm_id}` : null,
        score: precisionScore(item)
      };
    })
    .filter((item): item is { lat: number; lng: number; label: string; place_id: string | null; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return NextResponse.json({ ok: true, results });
}
