/**
 * GET /api/medmar-ar/export?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * Export Excel multi-foglio: Biglietti, Tratte, Statistiche
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { type SupabaseClient } from "@supabase/supabase-js";
import { buildMedmarExportWorkbook, type ExportLegRow, type ExportTicketRow } from "@/lib/medmar-ar/export-workbook";

type MemberRow = {
  user_id: string;
  full_name: string | null;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "autista"]);
  if (auth instanceof NextResponse) return auth;
  const admin = auth.admin as SupabaseClient;
  const { membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = `${today.slice(0, 4)}-01-01`;
  const dateFrom = url.searchParams.get("date_from") ?? firstOfYear;
  const dateTo = url.searchParams.get("date_to") ?? today;

  const { data: tickets } = await admin
    .from("medmar_ar_tickets")
    .select("id, voucher_number, travel_date, route, pax_count, ticket_mode, outbound_time, return_time, total_price_cents, unit_price_cents, notes, issuing_operator_id, created_at")
    .eq("tenant_id", tenantId)
    .gte("travel_date", dateFrom)
    .lte("travel_date", dateTo)
    .eq("is_test_data", false)
    .order("travel_date");

  const ticketList = (tickets ?? []) as ExportTicketRow[];
  const ticketIds = ticketList.map((t) => t.id);

  let legList: ExportLegRow[] = [];
  if (ticketIds.length > 0) {
    const { data: legs } = await admin
      .from("medmar_ar_ticket_legs")
      .select("id, ticket_id, leg_type, leg_time, leg_route, price_per_pax_cents, status, reassigned_booking_id, status_changed_at")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds);
    legList = (legs ?? []) as ExportLegRow[];
  }

  const operatorIds = [...new Set(ticketList.map((t) => t.issuing_operator_id).filter(Boolean))] as string[];
  let operatorNames: Record<string, string> = {};
  if (operatorIds.length > 0) {
    const { data: members } = await admin
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", tenantId)
      .in("user_id", operatorIds);
    for (const m of (members ?? []) as MemberRow[]) operatorNames[m.user_id] = m.full_name ?? m.user_id;
  }

  const wb = buildMedmarExportWorkbook({
    ticketList,
    legList,
    operatorNames,
  });

  // ── Serializza e restituisce ─────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `medmar-ar_${dateFrom}_${dateTo}.xlsx`;

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
