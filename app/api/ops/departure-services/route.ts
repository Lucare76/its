import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export type DepartureServiceRow = {
  id: string;
  customer_name: string;
  customer_phone: string | null;
  vessel: string | null;
  pax: number;
  departure_time: string | null;
  time: string | null;
  return_time: string | null;
  hotel_id: string | null;
  hotel_name: string | null;
  hotel_zone: string | null;
  notes: string | null;
  status: string;
};

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    // Carica tutti gli hotels del tenant per il join
    const hotelsRes = await auth.admin
      .from("hotels")
      .select("id,name,zone")
      .eq("tenant_id", tenantId);

    const hotels = (hotelsRes.data ?? []) as Array<{ id: string; name: string; zone: string | null }>;
    const hotelMap = new Map(hotels.map((h) => [h.id, h]));

    // Query 1: servizi con departure_date esplicita
    const [q1Res, q2Res] = await Promise.all([
      auth.admin
        .from("services")
        .select("id,customer_name,customer_phone,vessel,pax,departure_time,time,return_time,hotel_id,notes,status")
        .eq("tenant_id", tenantId)
        .eq("departure_date", date)
        .eq("is_draft", false)
        .neq("status", "cancelled"),

      // Query 2: servizi direction=departure con solo date (senza departure_date esplicita)
      auth.admin
        .from("services")
        .select("id,customer_name,customer_phone,vessel,pax,departure_time,time,return_time,hotel_id,notes,status")
        .eq("tenant_id", tenantId)
        .is("departure_date", null)
        .eq("date", date)
        .eq("direction", "departure")
        .eq("is_draft", false)
        .neq("status", "cancelled"),
    ]);

    if (q1Res.error) throw new Error(q1Res.error.message);
    if (q2Res.error) throw new Error(q2Res.error.message);

    // Merge e deduplica per id
    const seen = new Set<string>();
    const merged: DepartureServiceRow[] = [];
    for (const row of [...(q1Res.data ?? []), ...(q2Res.data ?? [])]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const hotel = row.hotel_id ? hotelMap.get(row.hotel_id) : null;
      merged.push({
        id: row.id,
        customer_name: row.customer_name,
        customer_phone: row.customer_phone ?? null,
        vessel: row.vessel ?? null,
        pax: row.pax ?? 1,
        departure_time: row.departure_time ?? null,
        time: row.time ?? null,
        return_time: row.return_time ?? null,
        hotel_id: row.hotel_id ?? null,
        hotel_name: hotel?.name ?? null,
        hotel_zone: hotel?.zone ?? null,
        notes: row.notes ?? null,
        status: row.status,
      });
    }

    // Ordina per orario di partenza
    merged.sort((a, b) => {
      const ta = a.departure_time ?? a.return_time ?? a.time ?? "99:99";
      const tb = b.departure_time ?? b.return_time ?? b.time ?? "99:99";
      if (ta !== tb) return ta.localeCompare(tb);
      return a.customer_name.localeCompare(b.customer_name);
    });

    return NextResponse.json({ ok: true, services: merged });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
