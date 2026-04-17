/**
 * GET /api/agency/check-duplicate?name=xxx&phone=yyy
 *
 * Controlla se esiste già una pratica attiva con lo stesso nome cliente.
 * - match_type "exact"     → nome + telefono uguali
 * - match_type "name_only" → nome uguale ma telefono diverso
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

  if (name.length < 2) {
    return NextResponse.json({ found: false });
  }

  const tenantId = auth.membership.tenant_id;

  const probeArr = await auth.admin.from("services").select("arrival_date").limit(1);
  const hasArrivalDate = !probeArr.error || (probeArr.error as { code?: string }).code !== "42703";
  const selectCols = hasArrivalDate
    ? "id, date, direction, hotel_id, arrival_date, departure_date, customer_name, phone, pax, hotels(name), agencies(name)"
    : "id, date, direction, hotel_id, customer_name, phone, pax, hotels(name), agencies(name)";

  // ── Tentativo 1: match esatto nome + telefono ─────────────────────────────
  if (phone.length >= 4) {
    const { data: exact } = await auth.admin
      .from("services")
      .select(selectCols)
      .eq("tenant_id", tenantId)
      .ilike("customer_name", `%${name}%`)
      .eq("phone", phone)
      .neq("status", "cancelled")
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (exact) {
      return NextResponse.json({ found: true, match_type: "exact", service: buildService(exact as unknown as Record<string, unknown>, hasArrivalDate) });
    }
  }

  // ── Tentativo 2: match solo nome (telefono diverso o assente) ─────────────
  const nameQuery = auth.admin
    .from("services")
    .select(selectCols)
    .eq("tenant_id", tenantId)
    .ilike("customer_name", `%${name}%`)
    .neq("status", "cancelled")
    .order("date", { ascending: false })
    .limit(1);

  // Escludi il match esatto già trovato (se phone era presente)
  const { data: nameOnly } = phone.length >= 4
    ? await nameQuery.neq("phone", phone).maybeSingle()
    : await nameQuery.maybeSingle();

  if (nameOnly) {
    return NextResponse.json({ found: true, match_type: "name_only", service: buildService(nameOnly as unknown as Record<string, unknown>, hasArrivalDate) });
  }

  return NextResponse.json({ found: false });
}

function buildService(row: Record<string, unknown>, hasArrivalDate: boolean) {
  const fmt = (d: unknown) =>
    typeof d === "string" && d ? d.split("-").reverse().join("/") : null;
  const hotelRaw = row.hotels;
  const hotelName = Array.isArray(hotelRaw)
    ? (hotelRaw[0] as { name?: string } | null)?.name ?? "N/D"
    : (hotelRaw as { name?: string } | null)?.name ?? "N/D";
  const agencyRaw = row.agencies;
  const agencyName = Array.isArray(agencyRaw)
    ? (agencyRaw[0] as { name?: string } | null)?.name ?? null
    : (agencyRaw as { name?: string } | null)?.name ?? null;

  return {
    date: fmt(row.date) ?? row.date,
    direction: row.direction,
    hotel_name: hotelName,
    agency_name: agencyName,
    pax: row.pax ?? null,
    phone: row.phone ?? null,
    arrival_date: hasArrivalDate ? fmt(row.arrival_date) : null,
    departure_date: hasArrivalDate ? fmt(row.departure_date) : null,
  };
}
