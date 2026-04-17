import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tenantId = (auth as any).membership.tenant_id as string;

    const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
    if (q.length < 2) return NextResponse.json({ ok: true, results: [] });

    const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "30"), 100);

    // Cerca per nome cliente o telefono su tutti i servizi non cancellati
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (auth as any).admin
      .from("services")
      .select(`
        id, date, time, status, direction, pax, customer_name, phone,
        vessel, booking_service_kind, service_type,
        arrival_date, arrival_time, departure_date, departure_time,
        transport_code, notes, meeting_point,
        hotels(name)
      `)
      .eq("tenant_id", tenantId)
      .eq("is_draft", false)
      .neq("status", "cancelled")
      .or(`customer_name.ilike.%${q}%,phone.ilike.%${q}%`)
      .order("date", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);

    type Row = {
      id: string; date: string; time: string; status: string;
      direction: string; pax: number; customer_name: string; phone: string | null;
      vessel: string | null; booking_service_kind: string | null; service_type: string | null;
      arrival_date: string | null; arrival_time: string | null;
      departure_date: string | null; departure_time: string | null;
      transport_code: string | null; notes: string | null; meeting_point: string | null;
      hotels: { name: string } | null;
    };

    const results = ((data ?? []) as unknown as Row[]).map((r) => ({
      id: r.id,
      customer_name: r.customer_name,
      phone: r.phone,
      date: r.date,
      status: r.status,
      direction: r.direction,
      pax: r.pax,
      vessel: r.vessel,
      booking_service_kind: r.booking_service_kind,
      arrival_date: r.arrival_date,
      departure_date: r.departure_date,
      transport_code: r.transport_code,
      hotel_name: r.hotels?.name ?? null,
      meeting_point: r.meeting_point,
      notes: r.notes,
    }));

    return NextResponse.json({ ok: true, results });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore" },
      { status: 500 }
    );
  }
}
