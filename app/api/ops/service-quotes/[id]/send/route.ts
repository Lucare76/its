import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendQuoteOfferEmail } from "@/lib/server/quote-offer-email";
import type { ServiceQuoteEmailData } from "@/lib/server/quote-offer-email";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: quote, error: fetchErr } = await auth.admin
    .from("service_quotes")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (fetchErr || !quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  if (quote.status !== "draft" && quote.status !== "offer_sent") {
    return NextResponse.json({ error: `Stato non valido per invio offerta: ${quote.status}.` }, { status: 409 });
  }

  const { data: quoteItems } = await auth.admin
    .from("service_quote_items")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("quote_id", id)
    .order("sort_order", { ascending: true });
  const totalPriceCents = (quoteItems ?? []).reduce((sum, item) => sum + Number(item.total_price_cents ?? 0), 0);

  const { data: tenant } = await auth.admin
    .from("tenants")
    .select("quote_offer_validity_days,quote_company_phone,quote_company_whatsapp,quote_iban,quote_bank_holder,quote_payment_instructions,quote_swift_code,contact_phone")
    .eq("id", tenantId)
    .single();

  const validityDays = tenant?.quote_offer_validity_days ?? 7;
  const expiresAt = new Date(Date.now() + validityDays * 86400_000).toISOString();

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const acceptUrl = `${appUrl}/quote/accept/${quote.accept_token}`;

  const emailData: ServiceQuoteEmailData = {
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
    priceMode:         quote.price_mode ?? "per_person",
    currency:          quote.currency,
    priceNotes:        quote.price_notes ?? null,
    emailIntro:        quote.email_intro ?? null,
    iban:              quote.iban ?? tenant?.quote_iban ?? null,
    swiftCode:         (quote.swift_code ?? tenant?.quote_swift_code) ?? null,
    bankAccountHolder: quote.bank_account_holder ?? tenant?.quote_bank_holder ?? null,
    paymentInstructions: quote.payment_instructions ?? tenant?.quote_payment_instructions ?? null,
    expiresAt,
    acceptUrl,
    companyPhone:     tenant?.quote_company_phone ?? null,
    companyWhatsapp:  tenant?.quote_company_whatsapp ?? null,
    footerPhone:      tenant?.contact_phone ?? null,
    items:            quoteItems ?? [],
    totalPriceCents:  totalPriceCents || null,
  };

  const result = await sendQuoteOfferEmail(emailData);
  if (!result.ok) return NextResponse.json({ error: result.error ?? "Errore invio email." }, { status: 500 });

  const now = new Date().toISOString();
  const { error: updateErr } = await auth.admin
    .from("service_quotes")
    .update({
      status:         "offer_sent",
      offer_sent_at:  now,
      expires_at:     expiresAt,
      accept_token_expires_at: expiresAt,
      updated_at:     now,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, expires_at: expiresAt });
}
