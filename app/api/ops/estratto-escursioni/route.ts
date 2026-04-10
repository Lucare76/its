import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type LineRow = { id: string; name: string; price_agency_cents: number; price_retail_cents: number };
type UnitRow = { id: string; excursion_date: string; excursion_line_id: string; label: string };
type AllocRow = {
  id: string; excursion_unit_id: string; customer_name: string; pax: number;
  agency_name: string | null; hotel_name: string | null; phone: string | null; notes: string | null;
};

export type EscursioneBooking = {
  id: string;
  date: string;
  line_name: string;
  bus_label: string;
  customer_name: string;
  hotel_name: string | null;
  phone: string | null;
  pax: number;
  agency_name: string;
  price_agency_cents: number;
  price_retail_cents: number;
  total_agency_cents: number;
  total_retail_cents: number;
  notes: string | null;
};

export type AgencyStatement = {
  agency_name: string;
  bookings: EscursioneBooking[];
  total_pax: number;
  total_agency_cents: number;
  total_retail_cents: number;
};

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const sp = req.nextUrl.searchParams;
    const from = sp.get("from") ?? new Date().toISOString().slice(0, 7) + "-01";
    const to = sp.get("to") ?? new Date().toISOString().slice(0, 10);
    const filterAgency = sp.get("agency") ?? "";

    // 1. Lines del tenant
    const { data: linesData, error: linesErr } = await auth.admin
      .from("excursion_lines")
      .select("id,name,price_agency_cents,price_retail_cents")
      .eq("tenant_id", tenantId);
    if (linesErr) throw new Error(linesErr.message);
    const lines = (linesData ?? []) as LineRow[];
    const lineMap = new Map(lines.map((l) => [l.id, l]));

    // 2. Units nel range di date
    const { data: unitsData, error: unitsErr } = await auth.admin
      .from("excursion_units")
      .select("id,excursion_date,excursion_line_id,label")
      .in("excursion_line_id", lines.map((l) => l.id))
      .gte("excursion_date", from)
      .lte("excursion_date", to)
      .order("excursion_date");
    if (unitsErr) throw new Error(unitsErr.message);
    const units = (unitsData ?? []) as UnitRow[];
    const unitMap = new Map(units.map((u) => [u.id, u]));

    if (units.length === 0) {
      return NextResponse.json({ ok: true, statements: [], from, to });
    }

    // 3. Allocations per queste units
    let allocQuery = auth.admin
      .from("excursion_allocations")
      .select("id,excursion_unit_id,customer_name,pax,agency_name,hotel_name,phone,notes")
      .in("excursion_unit_id", units.map((u) => u.id))
      .order("customer_name");

    if (filterAgency) {
      allocQuery = allocQuery.ilike("agency_name", `%${filterAgency}%`);
    }

    const { data: allocData, error: allocErr } = await allocQuery;
    if (allocErr) throw new Error(allocErr.message);
    const allocs = (allocData ?? []) as AllocRow[];

    // 4. Raggruppa per agenzia
    const byAgency = new Map<string, EscursioneBooking[]>();
    for (const a of allocs) {
      const unit = unitMap.get(a.excursion_unit_id);
      if (!unit) continue;
      const line = lineMap.get(unit.excursion_line_id);
      if (!line) continue;

      const agencyKey = (a.agency_name?.trim() || "— Diretto —");
      const booking: EscursioneBooking = {
        id: a.id,
        date: unit.excursion_date,
        line_name: line.name,
        bus_label: unit.label,
        customer_name: a.customer_name,
        hotel_name: a.hotel_name,
        phone: a.phone,
        pax: a.pax,
        agency_name: agencyKey,
        price_agency_cents: line.price_agency_cents,
        price_retail_cents: line.price_retail_cents,
        total_agency_cents: line.price_agency_cents * a.pax,
        total_retail_cents: line.price_retail_cents * a.pax,
        notes: a.notes,
      };

      if (!byAgency.has(agencyKey)) byAgency.set(agencyKey, []);
      byAgency.get(agencyKey)!.push(booking);
    }

    const statements: AgencyStatement[] = Array.from(byAgency.entries())
      .sort(([a], [b]) => a.localeCompare(b, "it"))
      .map(([agency_name, bookings]) => ({
        agency_name,
        bookings: bookings.sort((a, b) => a.date.localeCompare(b.date) || a.line_name.localeCompare(b.line_name)),
        total_pax: bookings.reduce((s, b) => s + b.pax, 0),
        total_agency_cents: bookings.reduce((s, b) => s + b.total_agency_cents, 0),
        total_retail_cents: bookings.reduce((s, b) => s + b.total_retail_cents, 0),
      }));

    return NextResponse.json({ ok: true, statements, from, to });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}
