import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildQuoteOfferHtml } from "@/lib/server/quote-offer-email";
import type { ServiceQuoteEmailData } from "@/lib/server/quote-offer-email";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const lang = (request.nextUrl.searchParams.get("lang") ?? "it") as "it" | "en";

  const [{ data: quote }, { data: tenant }] = await Promise.all([
    auth.admin.from("service_quotes").select("*").eq("id", id).eq("tenant_id", tenantId).single(),
    auth.admin.from("tenants").select("quote_company_phone,quote_company_whatsapp,quote_offer_validity_days,quote_swift_code,contact_phone").eq("id", tenantId).single(),
  ]);

  if (!quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const expiresAt = quote.expires_at ?? new Date(Date.now() + (tenant?.quote_offer_validity_days ?? 7) * 86400_000).toISOString();

  const data: ServiceQuoteEmailData = {
    quoteNumber:          quote.quote_number,
    customerFirstName:    quote.customer_first_name,
    customerLastName:     quote.customer_last_name,
    customerEmail:        quote.customer_email,
    customerLanguage:     lang,
    serviceType:          quote.service_type,
    direction:            quote.direction as "arrival" | "departure" | "round_trip" | null ?? null,
    arrivalDate:          quote.arrival_date ?? null,
    arrivalTime:          quote.arrival_time ?? null,
    arrivalFlightTrain:   quote.arrival_flight_train ?? null,
    departureDate:        quote.departure_date ?? null,
    departureTime:        quote.departure_time ?? null,
    departureFlightTrain: quote.departure_flight_train ?? null,
    hotelName:            quote.hotel_name ?? null,
    hotelAddress:         quote.hotel_address ?? null,
    pax:                  quote.pax,
    luggageNotes:         quote.luggage_notes ?? null,
    specialRequests:      quote.special_requests ?? null,
    priceCents:           quote.price_cents,
    currency:             quote.currency,
    priceNotes:           quote.price_notes ?? null,
    emailIntro:           quote.email_intro ?? null,
    iban:                 quote.iban ?? null,
    swiftCode:            (quote.swift_code ?? tenant?.quote_swift_code) ?? null,
    bankAccountHolder:    quote.bank_account_holder ?? null,
    paymentInstructions:  quote.payment_instructions ?? null,
    expiresAt,
    acceptUrl:            `${appUrl}/quote/accept/${quote.accept_token}`,
    companyPhone:         tenant?.quote_company_phone ?? null,
    companyWhatsapp:      tenant?.quote_company_whatsapp ?? null,
    footerPhone:          tenant?.contact_phone ?? null,
  };

  const { html, subject } = buildQuoteOfferHtml(data);
  return NextResponse.json({ ok: true, html, subject });
}
