/**
 * GET  /api/medmar-ar/tickets  — lista biglietti con filtri
 * POST /api/medmar-ar/tickets  — emetti nuovo biglietto
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { DEFAULT_PRICES_CENTS, type PriceType } from "@/lib/medmar-ar/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const dateFrom = url.searchParams.get("date_from") ?? new Date().toISOString().slice(0, 10);
  const dateTo = url.searchParams.get("date_to") ?? dateFrom;
  const route = url.searchParams.get("route");
  const mode = url.searchParams.get("mode");
  const search = url.searchParams.get("q");

  let query = admin
    .from("medmar_ar_tickets")
    .select(`
      *,
      medmar_ar_ticket_legs (
        id, leg_type, leg_time, leg_route, price_per_pax_cents,
        status, original_booking_id, reassigned_booking_id,
        status_changed_at, status_changed_by
      )
    `)
    .eq("tenant_id", tenantId)
    .gte("travel_date", dateFrom)
    .lte("travel_date", dateTo)
    .order("travel_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (route) query = query.eq("route", route);
  if (mode) query = query.eq("ticket_mode", mode);
  if (search) query = query.ilike("voucher_number", `%${search}%`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, tickets: data ?? [] });
}

const createTicketSchema = z.object({
  voucher_number: z.string().min(1).max(50),
  travel_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  route: z.enum(["pozzuoli_ischia", "pozzuoli_casamicciola", "napoli_ischia", "napoli_casamicciola"]),
  pax_count: z.number().int().min(1).max(500),
  ticket_mode: z.enum(["round_trip", "single_outbound", "single_return"]),
  outbound_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  return_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  booking_ids: z.array(z.string().uuid()).optional().default([]),
  notes: z.string().max(500).nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership, user } = auth;
  const tenantId = membership.tenant_id;

  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ ok: false, error: "JSON non valido." }, { status: 400 }); }

  const parsed = createTicketSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const d = parsed.data;

  // Validazioni aggiuntive
  if (d.ticket_mode !== "single_return" && !d.outbound_time) {
    return NextResponse.json({ ok: false, error: "Orario andata obbligatorio." }, { status: 400 });
  }
  if (d.ticket_mode === "round_trip" && !d.return_time) {
    return NextResponse.json({ ok: false, error: "Orario ritorno obbligatorio per A/R." }, { status: 400 });
  }

  // Recupera prezzi attivi
  const { data: priceRows } = await admin
    .from("medmar_ar_prices")
    .select("price_type, price_cents")
    .eq("tenant_id", tenantId)
    .lte("valid_from", d.travel_date)
    .or(`valid_to.is.null,valid_to.gte.${d.travel_date}`)
    .order("valid_from", { ascending: false });

  const prices: Record<PriceType, number> = { ...DEFAULT_PRICES_CENTS };
  const seen = new Set<string>();
  for (const row of priceRows ?? []) {
    if (!seen.has(row.price_type)) {
      prices[row.price_type as PriceType] = row.price_cents;
      seen.add(row.price_type);
    }
  }

  // Calcola prezzi
  let unitPriceCents: number;
  let totalCents: number;

  if (d.pax_count >= 12) {
    unitPriceCents = prices.single_trip_12_or_more;
    totalCents = unitPriceCents * d.pax_count;
  } else if (d.ticket_mode === "round_trip") {
    unitPriceCents = prices.round_trip_per_leg; // per tratta
    totalCents = unitPriceCents * 2 * d.pax_count;
  } else {
    unitPriceCents = prices.single_trip_under_12;
    totalCents = unitPriceCents * d.pax_count;
  }

  // Inserisci biglietto
  const { data: ticket, error: ticketErr } = await admin
    .from("medmar_ar_tickets")
    .insert({
      tenant_id: tenantId,
      voucher_number: d.voucher_number.trim(),
      travel_date: d.travel_date,
      route: d.route,
      pax_count: d.pax_count,
      ticket_mode: d.ticket_mode,
      outbound_time: d.outbound_time ?? null,
      return_time: d.return_time ?? null,
      unit_price_cents: unitPriceCents,
      total_price_cents: totalCents,
      issuing_operator_id: user.id,
      notes: d.notes ?? null,
    })
    .select()
    .single();

  if (ticketErr || !ticket) {
    if (ticketErr?.code === "23505") {
      return NextResponse.json({ ok: false, error: "Voucher già esistente per questa data." }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: ticketErr?.message ?? "Errore creazione biglietto." }, { status: 500 });
  }

  // Crea legs
  const legs: Array<Record<string, unknown>> = [];
  const pricePerLeg = d.pax_count >= 12 ? prices.single_trip_12_or_more : prices.round_trip_per_leg;

  if (d.ticket_mode !== "single_return") {
    legs.push({
      tenant_id: tenantId,
      ticket_id: ticket.id,
      leg_type: "outbound",
      leg_time: d.outbound_time ?? null,
      leg_route: d.route,
      price_per_pax_cents: d.ticket_mode === "single_outbound" ? prices.single_trip_under_12 : pricePerLeg,
      status: "used",
      original_booking_id: d.booking_ids[0] ?? null,
    });
  }

  if (d.ticket_mode !== "single_outbound") {
    legs.push({
      tenant_id: tenantId,
      ticket_id: ticket.id,
      leg_type: "return",
      leg_time: d.return_time ?? null,
      leg_route: d.route,
      price_per_pax_cents: d.ticket_mode === "single_return" ? prices.single_trip_under_12 : pricePerLeg,
      status: d.ticket_mode === "round_trip" ? "used" : "not_applicable",
      original_booking_id: d.booking_ids[0] ?? null,
    });
  }

  if (d.ticket_mode === "single_outbound") {
    legs.push({
      tenant_id: tenantId,
      ticket_id: ticket.id,
      leg_type: "return",
      leg_time: null,
      leg_route: d.route,
      price_per_pax_cents: prices.single_trip_under_12,
      status: "not_applicable",
      original_booking_id: null,
    });
  }

  const { error: legsErr } = await admin.from("medmar_ar_ticket_legs").insert(legs);
  if (legsErr) {
    // Rollback manuale del biglietto
    await admin.from("medmar_ar_tickets").delete().eq("id", ticket.id);
    return NextResponse.json({ ok: false, error: "Errore creazione tratte." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ticket, unit_price_cents: unitPriceCents, total_price_cents: totalCents });
}
