import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? todayIso();

  const { data, error } = await admin
    .from("medmar_fleet_tickets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("travel_date", date)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, tickets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, user, membership } = auth;
  const tenantId = membership.tenant_id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const vehicle_id = String(b.vehicle_id ?? "");
  const route = String(b.route ?? "");
  const travel_date = String(b.travel_date ?? todayIso());
  const ticket_mode = String(b.ticket_mode ?? "");
  const outbound_time = b.outbound_time ? String(b.outbound_time) : null;
  const return_time = b.return_time ? String(b.return_time) : null;
  const notes = b.notes ? String(b.notes) : null;

  if (!vehicle_id) return NextResponse.json({ ok: false, error: "vehicle_id obbligatorio." }, { status: 400 });
  if (!route) return NextResponse.json({ ok: false, error: "route obbligatoria." }, { status: 400 });
  if (!["round_trip", "single"].includes(ticket_mode)) {
    return NextResponse.json({ ok: false, error: "ticket_mode non valido (round_trip|single)." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travel_date)) {
    return NextResponse.json({ ok: false, error: "travel_date non valida (YYYY-MM-DD)." }, { status: 400 });
  }

  // Fetch vehicle
  const { data: vehicle, error: vehicleErr } = await admin
    .from("vehicles")
    .select("id, label, plate, vehicle_type, length_meters")
    .eq("tenant_id", tenantId)
    .eq("id", vehicle_id)
    .single();

  if (vehicleErr || !vehicle) {
    return NextResponse.json({ ok: false, error: "Veicolo non trovato." }, { status: 404 });
  }

  // Lookup current price
  const { data: priceRows } = await admin
    .from("medmar_fleet_prices")
    .select("id, price_ar_cents, price_single_cents")
    .eq("tenant_id", tenantId)
    .eq("vehicle_type", vehicle.vehicle_type)
    .eq("route", route)
    .is("valid_to", null)
    .lte("meters_from", vehicle.length_meters)
    .gt("meters_to", vehicle.length_meters)
    .order("valid_from", { ascending: false })
    .limit(1);

  const priceRow = priceRows?.[0] ?? null;
  const price_cents = priceRow
    ? ticket_mode === "round_trip"
      ? priceRow.price_ar_cents
      : priceRow.price_single_cents
    : 0;
  const price_id = priceRow?.id ?? null;

  // Generate voucher_number: YYYYMMDD-NNN
  const dateStr = travel_date.replace(/-/g, "");
  const { count } = await admin
    .from("medmar_fleet_tickets")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("travel_date", travel_date);
  const seq = ((count ?? 0) + 1).toString().padStart(3, "0");
  const voucher_number = `${dateStr}-${seq}`;

  const { data: ticket, error: insertErr } = await admin
    .from("medmar_fleet_tickets")
    .insert({
      tenant_id: tenantId,
      voucher_number,
      travel_date,
      vehicle_id: vehicle.id,
      vehicle_type: vehicle.vehicle_type,
      plate: vehicle.plate,
      length_meters: vehicle.length_meters,
      route,
      ticket_mode,
      outbound_time: outbound_time ?? null,
      return_time: ticket_mode === "round_trip" ? (return_time ?? null) : null,
      price_cents,
      price_id,
      status: "active",
      outbound_used: false,
      return_used: false,
      notes: notes ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (insertErr || !ticket) {
    return NextResponse.json({ ok: false, error: insertErr?.message ?? "Errore creazione biglietto." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket });
}
