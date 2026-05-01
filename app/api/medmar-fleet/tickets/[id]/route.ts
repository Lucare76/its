import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, user, membership } = auth;
  const tenantId = membership.tenant_id;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const action = String(b.action ?? "");

  // Fetch current ticket
  const { data: ticket, error: fetchErr } = await admin
    .from("medmar_fleet_tickets")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .single();

  if (fetchErr || !ticket) {
    return NextResponse.json({ ok: false, error: "Biglietto non trovato." }, { status: 404 });
  }

  if (ticket.status === "cancelled") {
    return NextResponse.json({ ok: false, error: "Biglietto già annullato." }, { status: 400 });
  }

  if (action === "use_outbound") {
    if (ticket.outbound_used) {
      return NextResponse.json({ ok: false, error: "Andata già marcata." }, { status: 400 });
    }
    const newOutbound = true;
    const newReturnUsed = ticket.return_used as boolean;
    const becomeUsed =
      (ticket.ticket_mode === "round_trip" && newOutbound && newReturnUsed) ||
      (ticket.ticket_mode === "single" && newOutbound);
    const { error } = await admin
      .from("medmar_fleet_tickets")
      .update({
        outbound_used: true,
        status: becomeUsed ? "used" : ticket.status,
      })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "use_return") {
    if (ticket.ticket_mode !== "round_trip") {
      return NextResponse.json({ ok: false, error: "Il biglietto non è A/R." }, { status: 400 });
    }
    if (ticket.return_used) {
      return NextResponse.json({ ok: false, error: "Ritorno già marcato." }, { status: 400 });
    }
    const newOutbound = ticket.outbound_used as boolean;
    const newReturn = true;
    const becomeUsed = newOutbound && newReturn;
    const { error } = await admin
      .from("medmar_fleet_tickets")
      .update({
        return_used: true,
        status: becomeUsed ? "used" : ticket.status,
      })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "cancel") {
    const { error } = await admin
      .from("medmar_fleet_tickets")
      .update({ status: "cancelled" })
      .eq("tenant_id", tenantId)
      .eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (action === "plate_change") {
    const new_vehicle_id = String(b.new_vehicle_id ?? "");
    const changeNotes = b.notes ? String(b.notes) : null;
    if (!new_vehicle_id) {
      return NextResponse.json({ ok: false, error: "new_vehicle_id obbligatorio." }, { status: 400 });
    }

    // Fetch new vehicle
    const { data: newVehicle, error: nvErr } = await admin
      .from("vehicles")
      .select("id, label, plate, vehicle_type, length_meters")
      .eq("tenant_id", tenantId)
      .eq("id", new_vehicle_id)
      .single();

    if (nvErr || !newVehicle) {
      return NextResponse.json({ ok: false, error: "Nuovo veicolo non trovato." }, { status: 404 });
    }

    // Lookup old price (already stored on ticket)
    const oldPriceCents = (ticket.price_cents as number) ?? 0;

    // Lookup new price for new vehicle+route+ticket_mode
    const { data: newPriceRows } = await admin
      .from("medmar_fleet_prices")
      .select("id, price_ar_cents, price_single_cents")
      .eq("tenant_id", tenantId)
      .eq("vehicle_type", newVehicle.vehicle_type)
      .eq("route", ticket.route)
      .is("valid_to", null)
      .lte("meters_from", newVehicle.length_meters)
      .gt("meters_to", newVehicle.length_meters)
      .order("valid_from", { ascending: false })
      .limit(1);

    const newPriceRow = newPriceRows?.[0] ?? null;
    const newPriceCents = newPriceRow
      ? ticket.ticket_mode === "round_trip"
        ? newPriceRow.price_ar_cents
        : newPriceRow.price_single_cents
      : 0;

    // Credit if new vehicle smaller (old price > new price)
    const creditCents = Math.max(0, oldPriceCents - newPriceCents);

    // Insert plate change record
    const { error: changeErr } = await admin
      .from("medmar_fleet_plate_changes")
      .insert({
        tenant_id: tenantId,
        ticket_id: id,
        original_plate: ticket.plate,
        original_meters: ticket.length_meters,
        new_plate: newVehicle.plate,
        new_meters: newVehicle.length_meters,
        new_vehicle_id: newVehicle.id,
        credit_cents: creditCents,
        changed_at: new Date().toISOString(),
        changed_by: user.id,
        notes: changeNotes,
      });

    if (changeErr) {
      return NextResponse.json({ ok: false, error: changeErr.message }, { status: 500 });
    }

    // Update ticket
    const { error: updateErr } = await admin
      .from("medmar_fleet_tickets")
      .update({
        vehicle_id: newVehicle.id,
        vehicle_type: newVehicle.vehicle_type,
        plate: newVehicle.plate,
        length_meters: newVehicle.length_meters,
        price_cents: newPriceCents,
        price_id: newPriceRow?.id ?? ticket.price_id,
      })
      .eq("tenant_id", tenantId)
      .eq("id", id);

    if (updateErr) {
      return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, credit_cents: creditCents, new_price_cents: newPriceCents });
  }

  return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "supervisor", "operator"],
    auditPrefix: "medmar_fleet",
  });
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;
  const { id } = await params;

  const { error } = await admin
    .from("medmar_fleet_tickets")
    .update({ status: "cancelled" })
    .eq("tenant_id", tenantId)
    .eq("id", id);

  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
