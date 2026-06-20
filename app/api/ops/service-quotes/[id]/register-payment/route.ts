import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendQuoteConfirmEmail } from "@/lib/server/quote-offer-email";
import type { QuoteConfirmEmailData } from "@/lib/server/quote-offer-email";

export const runtime = "nodejs";

const bodySchema = z.object({
  payment_reference: z.string().max(200).nullable().optional(),
  total_paid_cents:  z.number().int().min(0).optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const { data: quote, error: fetchErr } = await auth.admin
    .from("service_quotes")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (fetchErr || !quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  const allowedStatuses = ["accepted", "offer_sent", "paid"];
  if (!allowedStatuses.includes(quote.status)) {
    return NextResponse.json({ error: `Stato non valido per registrazione pagamento: ${quote.status}.` }, { status: 409 });
  }

  const { data: tenant } = await auth.admin
    .from("tenants")
    .select("quote_company_phone,quote_company_whatsapp,contact_phone")
    .eq("id", tenantId)
    .single();

  const { data: quoteItems } = await auth.admin
    .from("service_quote_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("quote_id", id)
    .order("sort_order", { ascending: true });
  const itemsTotalCents = (quoteItems ?? []).reduce((sum, item) => sum + Number(item.total_price_cents ?? 0), 0);

  const now = new Date().toISOString();
  const totalPaidCents = parsed.data.total_paid_cents ?? (itemsTotalCents || (quote.price_cents * quote.pax));

  const { error: updateErr } = await auth.admin
    .from("service_quotes")
    .update({
      status:            "confirmed",
      paid_at:           now,
      confirmed_at:      now,
      payment_reference: parsed.data.payment_reference?.trim() || null,
      updated_at:        now,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  // Send confirmation email (non-blocking — failure doesn't roll back status)
  const emailData: QuoteConfirmEmailData = {
    quoteNumber:       quote.quote_number,
    customerFirstName: quote.customer_first_name,
    customerLastName:  quote.customer_last_name,
    customerEmail:     quote.customer_email,
    customerLanguage:  (quote.customer_language as "it" | "en") ?? "it",
    serviceType:       quote.service_type,
    direction:         (quote.direction as "arrival" | "departure" | "round_trip" | null) ?? null,
    arrivalDate:       quote.arrival_date ?? null,
    arrivalTime:       quote.arrival_time ?? null,
    arrivalFlightTrain: quote.arrival_flight_train ?? null,
    departureDate:     quote.departure_date ?? null,
    departureTime:     quote.departure_time ?? null,
    departureFlightTrain: quote.departure_flight_train ?? null,
    hotelName:         quote.hotel_name ?? null,
    hotelAddress:      quote.hotel_address ?? null,
    pax:               quote.pax,
    luggageNotes:      quote.luggage_notes ?? null,
    specialRequests:   quote.special_requests ?? null,
    priceCents:        quote.price_cents,
    currency:          quote.currency,
    priceNotes:        quote.price_notes ?? null,
    emailIntro:        quote.email_intro ?? null,
    iban:              quote.iban ?? null,
    swiftCode:         (quote.swift_code as string | null) ?? null,
    bankAccountHolder: quote.bank_account_holder ?? null,
    paymentInstructions: quote.payment_instructions ?? null,
    companyPhone:      tenant?.quote_company_phone ?? null,
    companyWhatsapp:   tenant?.quote_company_whatsapp ?? null,
    footerPhone:       tenant?.contact_phone ?? null,
    totalPaidCents,
    items:             quoteItems ?? [],
    totalPriceCents:   itemsTotalCents || null,
  };

  const emailResult = await sendQuoteConfirmEmail(emailData);

  return NextResponse.json({ ok: true, email_sent: emailResult.ok, email_error: emailResult.error ?? null });
}
