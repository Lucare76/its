import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeQuoteItems, quoteItemsForInsert, quoteItemsTotalCents } from "@/lib/server/service-quote-items";

export const runtime = "nodejs";

const serviceTypeSchema = z.enum([
  "transfer_airport","transfer_station","transfer_port",
  "excursion","shuttle","formula_snav","formula_medmar","custom"
]);

const quoteItemSchema = z.object({
  item_type: z.enum(["service", "free_text"]),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(3000).nullable().optional(),
  service_type: serviceTypeSchema.nullable().optional(),
  direction: z.enum(["arrival","departure","round_trip"]).nullable().optional(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  arrival_flight_train: z.string().max(100).nullable().optional(),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  departure_flight_train: z.string().max(100).nullable().optional(),
  hotel_name: z.string().max(200).nullable().optional(),
  hotel_address: z.string().max(300).nullable().optional(),
  pax: z.number().int().min(0).max(200).nullable().optional(),
  quantity: z.number().int().min(1).max(999).nullable().optional(),
  luggage_notes: z.string().max(1000).nullable().optional(),
  special_requests: z.string().max(2000).nullable().optional(),
  unit_price_cents: z.number().int().min(0).nullable().optional(),
  total_price_cents: z.number().int().min(0).nullable().optional(),
  price_notes: z.string().max(1000).nullable().optional(),
});

const createSchema = z.object({
  customer_first_name: z.string().min(1).max(100),
  customer_last_name:  z.string().min(1).max(100),
  customer_email:      z.string().email(),
  customer_phone:      z.string().max(40).nullable().optional(),
  customer_language:   z.enum(["it", "en"]).default("it"),

  service_type: serviceTypeSchema,
  direction: z.enum(["arrival","departure","round_trip"]).nullable().optional(),

  arrival_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  arrival_time:         z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  arrival_flight_train: z.string().max(100).nullable().optional(),

  departure_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  departure_time:         z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  departure_flight_train: z.string().max(100).nullable().optional(),

  hotel_name:       z.string().max(200).nullable().optional(),
  hotel_address:    z.string().max(300).nullable().optional(),
  pax:              z.number().int().min(1).max(200).default(1),
  luggage_notes:    z.string().max(1000).nullable().optional(),
  special_requests: z.string().max(2000).nullable().optional(),

  price_cents:  z.number().int().min(0),
  currency:     z.string().length(3).default("EUR"),
  price_notes:  z.string().max(1000).nullable().optional(),

  email_intro:          z.string().max(2000).nullable().optional(),
  payment_method:       z.string().max(40).nullable().optional(),
  swift_code:           z.string().max(20).nullable().optional(),
  payment_instructions: z.string().max(2000).nullable().optional(),

  notes_internal: z.string().max(5000).nullable().optional(),
  items: z.array(quoteItemSchema).min(1).max(30).optional(),
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const { searchParams } = request.nextUrl;
  const status = searchParams.get("status");

  let query = auth.admin
    .from("service_quotes")
    .select("id,quote_number,status,customer_first_name,customer_last_name,customer_email,customer_phone,customer_language,service_type,direction,arrival_date,departure_date,hotel_name,pax,price_cents,currency,offer_sent_at,accepted_at,paid_at,confirmed_at,expires_at,created_at,updated_at,notes_internal")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const quoteIds = (data ?? []).map((quote) => quote.id as string);
  const { data: items } = quoteIds.length > 0
    ? await auth.admin
      .from("service_quote_items")
      .select("*")
      .eq("tenant_id", tenantId)
      .in("quote_id", quoteIds)
      .order("sort_order", { ascending: true })
    : { data: [] };
  const itemsByQuote = new Map<string, unknown[]>();
  for (const item of items ?? []) {
    const quoteId = String((item as { quote_id: string }).quote_id);
    itemsByQuote.set(quoteId, [...(itemsByQuote.get(quoteId) ?? []), item]);
  }

  return NextResponse.json({
    ok: true,
    quotes: (data ?? []).map((quote) => ({
      ...quote,
      items: itemsByQuote.get(String(quote.id)) ?? [],
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const d = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const normalizedItems = normalizeQuoteItems(d.items ?? [], {
    service_type: d.service_type,
    direction: d.direction ?? null,
    arrival_date: d.arrival_date ?? null,
    arrival_time: d.arrival_time ?? null,
    arrival_flight_train: d.arrival_flight_train?.trim() || null,
    departure_date: d.departure_date ?? null,
    departure_time: d.departure_time ?? null,
    departure_flight_train: d.departure_flight_train?.trim() || null,
    hotel_name: d.hotel_name?.trim() || null,
    hotel_address: d.hotel_address?.trim() || null,
    pax: d.pax,
    luggage_notes: d.luggage_notes?.trim() || null,
    special_requests: d.special_requests?.trim() || null,
    price_cents: d.price_cents,
    price_notes: d.price_notes?.trim() || null,
  });
  const primary = normalizedItems.find((item) => item.item_type === "service") ?? normalizedItems[0];

  // Fetch tenant settings for payment defaults
  const { data: tenant } = await auth.admin
    .from("tenants")
    .select("quote_iban,quote_bank_holder,quote_payment_instructions,quote_company_phone,quote_company_whatsapp,quote_swift_code")
    .eq("id", tenantId)
    .single();

  // Generate progressive quote number (DB function)
  const { data: quoteNumberData, error: seqErr } = await auth.admin
    .rpc("next_quote_number", { p_tenant_id: tenantId });
  if (seqErr) return NextResponse.json({ error: "Errore generazione numero preventivo." }, { status: 500 });

  const insertRow = {
    tenant_id: tenantId,
    quote_number: quoteNumberData as string,
    customer_first_name: d.customer_first_name.trim(),
    customer_last_name:  d.customer_last_name.trim(),
    customer_email:      d.customer_email.trim().toLowerCase(),
    customer_phone:      d.customer_phone?.trim() || null,
    customer_language:   d.customer_language,
    service_type:        primary.service_type ?? d.service_type,
    direction:           primary.direction ?? d.direction ?? null,
    arrival_date:        primary.arrival_date ?? d.arrival_date ?? null,
    arrival_time:        primary.arrival_time ?? d.arrival_time ?? null,
    arrival_flight_train: primary.arrival_flight_train ?? d.arrival_flight_train?.trim() ?? null,
    departure_date:      primary.departure_date ?? d.departure_date ?? null,
    departure_time:      primary.departure_time ?? d.departure_time ?? null,
    departure_flight_train: primary.departure_flight_train ?? d.departure_flight_train?.trim() ?? null,
    hotel_name:          primary.hotel_name ?? d.hotel_name?.trim() ?? null,
    hotel_address:       primary.hotel_address ?? d.hotel_address?.trim() ?? null,
    pax:                 primary.pax || d.pax,
    luggage_notes:       primary.luggage_notes ?? d.luggage_notes?.trim() ?? null,
    special_requests:    primary.special_requests ?? d.special_requests?.trim() ?? null,
    price_cents:         primary.unit_price_cents || d.price_cents,
    currency:            d.currency,
    price_notes:         d.price_notes?.trim() || null,
    email_intro:         d.email_intro?.trim() || null,
    payment_method:      d.payment_method || "bank_transfer",
    iban:                tenant?.quote_iban || null,
    swift_code:          d.swift_code?.trim() || tenant?.quote_swift_code || null,
    bank_account_holder: tenant?.quote_bank_holder || null,
    payment_instructions: d.payment_instructions?.trim() || tenant?.quote_payment_instructions || null,
    notes_internal:      d.notes_internal?.trim() || null,
    created_by:          auth.user.id,
    status:              "draft",
  };

  const { data: inserted, error: insertErr } = await auth.admin
    .from("service_quotes")
    .insert(insertRow)
    .select("id,quote_number,status")
    .single();

  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  const { error: itemsErr } = await auth.admin
    .from("service_quote_items")
    .insert(quoteItemsForInsert(tenantId, inserted.id, normalizedItems));
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    quote: { ...inserted, total_price_cents: quoteItemsTotalCents(normalizedItems), items: normalizedItems },
  }, { status: 201 });
}
