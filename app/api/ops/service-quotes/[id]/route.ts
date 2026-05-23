import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const patchSchema = z.object({
  customer_first_name:  z.string().min(1).max(100).optional(),
  customer_last_name:   z.string().min(1).max(100).optional(),
  customer_email:       z.string().email().optional(),
  customer_phone:       z.string().max(40).nullable().optional(),
  customer_language:    z.enum(["it","en"]).optional(),
  service_type:         z.enum(["transfer_airport","transfer_station","transfer_port","excursion","shuttle","formula_snav","formula_medmar","custom"]).optional(),
  direction:            z.enum(["arrival","departure","round_trip"]).nullable().optional(),
  arrival_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  arrival_time:         z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  arrival_flight_train: z.string().max(100).nullable().optional(),
  departure_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departure_time:       z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  departure_flight_train: z.string().max(100).nullable().optional(),
  hotel_name:           z.string().max(200).nullable().optional(),
  hotel_address:        z.string().max(300).nullable().optional(),
  pax:                  z.number().int().min(1).max(200).optional(),
  luggage_notes:        z.string().max(1000).nullable().optional(),
  special_requests:     z.string().max(2000).nullable().optional(),
  price_cents:          z.number().int().min(0).optional(),
  price_notes:          z.string().max(1000).nullable().optional(),
  email_intro:          z.string().max(2000).nullable().optional(),
  payment_method:       z.string().max(40).nullable().optional(),
  iban:                 z.string().max(60).nullable().optional(),
  bank_account_holder:  z.string().max(200).nullable().optional(),
  payment_instructions: z.string().max(2000).nullable().optional(),
  notes_internal:       z.string().max(5000).nullable().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data, error } = await auth.admin
    .from("service_quotes")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (error || !data) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  return NextResponse.json({ ok: true, quote: data });
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { data: existing } = await auth.admin
    .from("service_quotes")
    .select("status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (!existing) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });
  if (existing.status === "confirmed" || existing.status === "cancelled") {
    return NextResponse.json({ error: "Non è possibile modificare un preventivo confermato o cancellato." }, { status: 409 });
  }

  const d = parsed.data;
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (d.customer_first_name !== undefined) updates.customer_first_name = d.customer_first_name.trim();
  if (d.customer_last_name  !== undefined) updates.customer_last_name  = d.customer_last_name.trim();
  if (d.customer_email      !== undefined) updates.customer_email      = d.customer_email.trim().toLowerCase();
  if (d.customer_phone      !== undefined) updates.customer_phone      = d.customer_phone?.trim() || null;
  if (d.customer_language   !== undefined) updates.customer_language   = d.customer_language;
  if (d.service_type        !== undefined) updates.service_type        = d.service_type;
  if (d.direction           !== undefined) updates.direction           = d.direction ?? null;
  if (d.arrival_date        !== undefined) updates.arrival_date        = d.arrival_date ?? null;
  if (d.arrival_time        !== undefined) updates.arrival_time        = d.arrival_time ?? null;
  if (d.arrival_flight_train !== undefined) updates.arrival_flight_train = d.arrival_flight_train?.trim() || null;
  if (d.departure_date      !== undefined) updates.departure_date      = d.departure_date ?? null;
  if (d.departure_time      !== undefined) updates.departure_time      = d.departure_time ?? null;
  if (d.departure_flight_train !== undefined) updates.departure_flight_train = d.departure_flight_train?.trim() || null;
  if (d.hotel_name          !== undefined) updates.hotel_name          = d.hotel_name?.trim() || null;
  if (d.hotel_address       !== undefined) updates.hotel_address       = d.hotel_address?.trim() || null;
  if (d.pax                 !== undefined) updates.pax                 = d.pax;
  if (d.luggage_notes       !== undefined) updates.luggage_notes       = d.luggage_notes?.trim() || null;
  if (d.special_requests    !== undefined) updates.special_requests    = d.special_requests?.trim() || null;
  if (d.price_cents         !== undefined) updates.price_cents         = d.price_cents;
  if (d.price_notes         !== undefined) updates.price_notes         = d.price_notes?.trim() || null;
  if (d.email_intro         !== undefined) updates.email_intro         = d.email_intro?.trim() || null;
  if (d.payment_method      !== undefined) updates.payment_method      = d.payment_method;
  if (d.iban                !== undefined) updates.iban                = d.iban?.trim() || null;
  if (d.bank_account_holder !== undefined) updates.bank_account_holder = d.bank_account_holder?.trim() || null;
  if (d.payment_instructions !== undefined) updates.payment_instructions = d.payment_instructions?.trim() || null;
  if (d.notes_internal      !== undefined) updates.notes_internal      = d.notes_internal?.trim() || null;

  const { data: updated, error } = await auth.admin
    .from("service_quotes")
    .update(updates)
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .select("id,quote_number,status,updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, quote: updated });
}
