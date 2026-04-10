/**
 * GET /api/agency/check-duplicate?name=xxx&phone=yyy
 *
 * Controlla se esiste già una pratica attiva con lo stesso nome cliente e telefono.
 * Usa service role per bypassare RLS.
 * Richiede sessione autenticata (agency o admin).
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["agency", "admin"],
    membershipFields: [],
    auditPrefix: "agency_check_duplicate"
  });
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const name = (url.searchParams.get("name") ?? "").trim();
  const phone = (url.searchParams.get("phone") ?? "").trim();

  if (name.length < 2 || phone.length < 4) {
    return NextResponse.json({ found: false });
  }

  const tenantId = auth.membership.tenant_id;

  // Prova ad aggiungere arrival_date / departure_date se esistono
  const probeArr = await auth.admin.from("services").select("arrival_date").limit(1);
  const hasArrivalDate = !probeArr.error || (probeArr.error as { code?: string }).code !== "42703";
  const selectCols = hasArrivalDate
    ? "id, date, direction, hotel_id, arrival_date, departure_date, hotels(name)"
    : "id, date, direction, hotel_id, hotels(name)";

  const { data: existing, error } = await auth.admin
    .from("services")
    .select(selectCols)
    .eq("tenant_id", tenantId)
    .ilike("customer_name", `%${name}%`)
    .eq("phone", phone)
    .neq("status", "cancelled")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !existing) {
    return NextResponse.json({ found: false });
  }

  const row = existing as unknown as Record<string, unknown>;

  const hotelRaw = row.hotels;
  const hotelName = Array.isArray(hotelRaw)
    ? (hotelRaw[0] as { name?: string } | null)?.name ?? "N/D"
    : (hotelRaw as { name?: string } | null)?.name ?? "N/D";

  const fmt = (d: unknown) =>
    typeof d === "string" && d ? d.split("-").reverse().join("/") : null;

  return NextResponse.json({
    found: true,
    service: {
      date: fmt(row.date) ?? row.date,
      direction: row.direction,
      hotel_name: hotelName,
      arrival_date: hasArrivalDate ? fmt(row.arrival_date) : null,
      departure_date: hasArrivalDate ? fmt(row.departure_date) : null,
    }
  });
}
