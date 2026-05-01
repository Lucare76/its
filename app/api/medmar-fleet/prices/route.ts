import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const { data, error } = await admin
    .from("medmar_fleet_prices")
    .select("*")
    .eq("tenant_id", tenantId)
    .is("valid_to", null)
    .order("vehicle_type", { ascending: true })
    .order("route", { ascending: true })
    .order("meters_from", { ascending: true });

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, prices: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor"],
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
  const vehicle_type = String(b.vehicle_type ?? "");
  const meters_from = Number(b.meters_from ?? 0);
  const meters_to = Number(b.meters_to ?? 0);
  const route = String(b.route ?? "");
  const price_ar_cents = Number(b.price_ar_cents ?? 0);
  const price_single_cents = Number(b.price_single_cents ?? 0);
  const notes = b.notes ? String(b.notes) : null;
  const valid_from = b.valid_from ? String(b.valid_from) : new Date().toISOString().slice(0, 10);

  if (!["taxi", "bus", "camion"].includes(vehicle_type)) {
    return NextResponse.json({ ok: false, error: "vehicle_type non valido (taxi|bus|camion)." }, { status: 400 });
  }
  if (!route) return NextResponse.json({ ok: false, error: "route obbligatoria." }, { status: 400 });
  if (meters_from >= meters_to) {
    return NextResponse.json({ ok: false, error: "meters_from deve essere < meters_to." }, { status: 400 });
  }
  if (price_ar_cents < 0 || price_single_cents < 0) {
    return NextResponse.json({ ok: false, error: "Prezzi non validi." }, { status: 400 });
  }

  const today = new Date().toISOString().slice(0, 10);

  // Expire old matching price
  await admin
    .from("medmar_fleet_prices")
    .update({ valid_to: today })
    .eq("tenant_id", tenantId)
    .eq("vehicle_type", vehicle_type)
    .eq("route", route)
    .eq("meters_from", meters_from)
    .eq("meters_to", meters_to)
    .is("valid_to", null);

  const { data: newPrice, error: insertErr } = await admin
    .from("medmar_fleet_prices")
    .insert({
      tenant_id: tenantId,
      vehicle_type,
      meters_from,
      meters_to,
      route,
      price_ar_cents,
      price_single_cents,
      notes,
      valid_from,
      valid_to: null,
      created_by: user.id,
    })
    .select()
    .single();

  if (insertErr || !newPrice) {
    return NextResponse.json({ ok: false, error: insertErr?.message ?? "Errore inserimento prezzo." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, price: newPrice });
}
