import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { evaluateHotelGeo, inferZoneFromCoords, ZONE_TO_CITY } from "@/lib/hotel-geocoding";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const schema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  formatted_address: z.string().trim().max(500).optional().nullable(),
  geo_notes: z.string().trim().max(1000).optional().nullable()
});

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await context.params;
  const raw = await request.json().catch(() => null);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const admin = auth.admin;
  const tenantId = auth.membership.tenant_id;
  const { data: hotel, error: fetchError } = await admin
    .from("hotels")
    .select("id,name,address,zone,lat,lng")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (fetchError) {
    return NextResponse.json({ ok: false, error: fetchError.message }, { status: 500 });
  }
  if (!hotel) {
    return NextResponse.json({ ok: false, error: "Hotel non trovato." }, { status: 404 });
  }

  const zone = inferZoneFromCoords(parsed.data.lat, parsed.data.lng);
  const formattedAddress = parsed.data.formatted_address?.trim() || hotel.address;
  const evaluation = evaluateHotelGeo({
    address: formattedAddress,
    zone,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    geo_status: "verified",
    geo_source: "manual",
    geo_accuracy: "rooftop",
    geo_verified_at: new Date().toISOString(),
    formatted_address: formattedAddress
  });

  if (evaluation.outsideIschia) {
    return NextResponse.json({ ok: false, error: "Coordinate fuori Ischia: correggi il pin prima di verificare." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from("hotels")
    .update({
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      zone,
      city: ZONE_TO_CITY[zone],
      geo_status: "verified",
      geo_source: "manual",
      geo_accuracy: "rooftop",
      geo_verified_at: now,
      geo_verified_by: auth.user.id,
      geo_notes: parsed.data.geo_notes?.trim() || null,
      formatted_address: formattedAddress,
      updated_at: now
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id,lat,lng,zone,city,geo_status,geo_source,geo_accuracy,geo_verified_at,geo_verified_by,geo_notes,formatted_address")
    .maybeSingle();

  if (updateError) {
    return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, hotel: updated });
}
