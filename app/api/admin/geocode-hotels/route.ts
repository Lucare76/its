import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { zoneCentroids, HOTEL_ZONES, ZONE_TO_CITY } from "@/lib/hotel-geocoding";
import type { HotelZone } from "@/lib/hotel-geocoding";

export const runtime = "nodejs";

type NominatimResult = { lat: string; lon: string; display_name: string };

// Bounding box dell'isola d'Ischia per validare i risultati Nominatim
const ISCHIA_BOUNDS = { minLat: 40.67, maxLat: 40.77, minLng: 13.82, maxLng: 13.98 };

function isWithinIschia(lat: number, lng: number): boolean {
  return lat >= ISCHIA_BOUNDS.minLat && lat <= ISCHIA_BOUNDS.maxLat &&
         lng >= ISCHIA_BOUNDS.minLng && lng <= ISCHIA_BOUNDS.maxLng;
}

async function nominatimSearch(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "5");
  url.searchParams.set("countrycodes", "it");
  // viewbox come suggerimento, senza bounded=1 per non escludere risultati validi
  url.searchParams.set("viewbox", "13.82,40.67,13.98,40.77");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "IschiaTransfer/1.0 (info@campanialimousine.com)" }
  });
  if (!res.ok) return null;

  const data = (await res.json()) as NominatimResult[];
  // Prendi il primo risultato che cade dentro l'isola d'Ischia
  for (const result of data) {
    const lat = parseFloat(result.lat);
    const lng = parseFloat(result.lon);
    if (Number.isFinite(lat) && Number.isFinite(lng) && isWithinIschia(lat, lng)) {
      return { lat, lng };
    }
  }
  return null;
}

// Chiama Nominatim con fallback progressivo se l'indirizzo esatto non viene trovato
async function geocodeAddress(address: string, hotelName: string): Promise<{ lat: number; lng: number } | null> {
  // Tentativo 1: indirizzo completo + Ischia
  const result1 = await nominatimSearch(`${address}, Ischia, Italy`);
  if (result1) return result1;

  await new Promise<void>((r) => setTimeout(r, 1100));

  // Tentativo 2: solo nome hotel + Ischia
  const result2 = await nominatimSearch(`${hotelName}, Ischia, Italy`);
  if (result2) return result2;

  return null;
}

// Dato lat/lng, restituisce la zona più vicina in base alla distanza dai centroidi
function inferZoneFromCoords(lat: number, lng: number): HotelZone {
  let best: HotelZone = "Ischia Porto";
  let bestDist = Infinity;
  for (const zone of HOTEL_ZONES) {
    const c = zoneCentroids[zone];
    const dist = Math.hypot(lat - c.lat, lng - c.lng);
    if (dist < bestDist) {
      bestDist = dist;
      best = zone;
    }
  }
  return best;
}

// Controlla se le coordinate sono quelle di default (centroide di una zona)
function isDefaultCoord(lat: number | null, lng: number | null): boolean {
  if (lat == null || lng == null) return true;
  for (const zone of HOTEL_ZONES) {
    const c = zoneCentroids[zone];
    if (Math.abs(lat - c.lat) < 0.001 && Math.abs(lng - c.lng) < 0.001) return true;
  }
  // Ischia Porto default usato nei vecchi import manuali
  if (Math.abs(lat - 40.7418) < 0.001 && Math.abs(lng - 13.9426) < 0.001) return true;
  return false;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const force = body.force === true;  // se true, geocodifica tutti; altrimenti solo quelli con coord di default

  const admin = auth.admin;
  const tenantId = auth.membership.tenant_id;

  const { data: hotels, error: fetchError } = await admin
    .from("hotels")
    .select("id,name,address,city,zone,lat,lng")
    .eq("tenant_id", tenantId);

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }

  const rows = (hotels ?? []) as Array<{
    id: string;
    name: string;
    address: string;
    city: string | null;
    zone: string | null;
    lat: number | null;
    lng: number | null;
  }>;

  // Filtra solo quelli da aggiornare
  const toProcess = force
    ? rows
    : rows.filter((h) => isDefaultCoord(h.lat, h.lng) || !h.zone);

  let updated = 0;
  let failed = 0;
  let skipped = 0;

  for (const hotel of toProcess) {
    const address = hotel.address?.trim();
    if (!address || address.toLowerCase() === "ischia" || address.length < 6) {
      skipped += 1;
      continue;
    }

    // Rate limit Nominatim: 1 req/s
    await sleep(1100);

    const coords = await geocodeAddress(address, hotel.name);
    if (!coords) {
      failed += 1;
      continue;
    }

    const zone = inferZoneFromCoords(coords.lat, coords.lng);
    const city = ZONE_TO_CITY[zone];

    const { error: updateError } = await admin
      .from("hotels")
      .update({
        lat: coords.lat,
        lng: coords.lng,
        zone,
        city,
        updated_at: new Date().toISOString()
      })
      .eq("id", hotel.id)
      .eq("tenant_id", tenantId);

    if (updateError) {
      failed += 1;
    } else {
      updated += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    report: {
      total: toProcess.length,
      updated,
      failed,
      skipped
    }
  });
}
