/**
 * GET /api/agency/bus-return-time?hotel_id=xxx&line_family=ITALIA|CENTRO|ADRIATICA
 * Restituisce l'orario di pick-up ritorno per l'hotel specificato e la famiglia linea bus.
 * Usato dal form nuova prenotazione per pre-compilare l'ora di partenza per il ritorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type LineFamily = "ITALIA" | "CENTRO" | "ADRIATICA";

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["agency", "admin"],
    auditPrefix: "agency_bus_return_time"
  });
  if (auth instanceof NextResponse) return auth;

  const hotelId = request.nextUrl.searchParams.get("hotel_id")?.trim() ?? "";
  const rawFamily = (request.nextUrl.searchParams.get("line_family") ?? "").toUpperCase() as LineFamily;

  if (!hotelId || !rawFamily || !["ITALIA", "CENTRO", "ADRIATICA"].includes(rawFamily)) {
    return NextResponse.json({ pickup_time: null, error: "hotel_id e line_family richiesti" }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // 1. Recupera il nome hotel
  const { data: hotel, error: hotelErr } = await admin
    .from("hotels")
    .select("name")
    .eq("id", hotelId)
    .eq("tenant_id", auth.membership.tenant_id)
    .single();

  if (hotelErr || !hotel?.name) {
    return NextResponse.json({ pickup_time: null });
  }

  const hotelName = hotel.name.trim().toUpperCase();

  // 2. Cerca orario ritorno nella tabella hotel_pickup_times
  const timeCol =
    rawFamily === "CENTRO"
      ? "pickup_time_linea_centro"
      : rawFamily === "ADRIATICA"
        ? "pickup_time_linea_adriatica"
        : "pickup_time_linea_italia";

  const { data: pickupRow } = await admin
    .from("hotel_pickup_times")
    .select(`${timeCol}`)
    .ilike("hotel_name", hotelName)
    .maybeSingle();

  if (!pickupRow) {
    return NextResponse.json({ pickup_time: null });
  }

  const rawTime = (pickupRow as Record<string, unknown>)[timeCol];
  // Il formato nel DB è "HH:MM:SS" (tipo time postgres) — tronchiamo a "HH:MM"
  const pickupTime = typeof rawTime === "string" ? rawTime.slice(0, 5) : null;

  return NextResponse.json({ pickup_time: pickupTime });
}
