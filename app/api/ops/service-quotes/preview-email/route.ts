import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildQuoteOfferHtml } from "@/lib/server/quote-offer-email";
import type { ServiceQuoteEmailData } from "@/lib/server/quote-offer-email";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as Partial<ServiceQuoteEmailData> | null;
  if (!body) return NextResponse.json({ error: "Dati non validi." }, { status: 400 });

  const { data: tenant } = await auth.admin
    .from("tenants")
    .select("contact_phone")
    .eq("id", auth.membership.tenant_id)
    .single();

  // Fill required fields with placeholders if missing
  const data: ServiceQuoteEmailData = {
    quoteNumber:          body.quoteNumber          ?? "ANTEPRIMA",
    customerFirstName:    body.customerFirstName     ?? "[Nome]",
    customerLastName:     body.customerLastName      ?? "[Cognome]",
    customerEmail:        body.customerEmail         ?? "cliente@email.com",
    customerLanguage:     body.customerLanguage      ?? "it",
    serviceType:          body.serviceType           ?? "transfer_airport",
    direction:            body.direction             ?? null,
    arrivalDate:          body.arrivalDate           ?? null,
    arrivalTime:          body.arrivalTime           ?? null,
    arrivalFlightTrain:   body.arrivalFlightTrain    ?? null,
    departureDate:        body.departureDate         ?? null,
    departureTime:        body.departureTime         ?? null,
    departureFlightTrain: body.departureFlightTrain  ?? null,
    hotelName:            body.hotelName             ?? null,
    hotelAddress:         body.hotelAddress          ?? null,
    pax:                  body.pax                  ?? 1,
    luggageNotes:         body.luggageNotes          ?? null,
    specialRequests:      body.specialRequests       ?? null,
    priceCents:           body.priceCents            ?? 0,
    currency:             body.currency              ?? "EUR",
    priceNotes:           body.priceNotes            ?? null,
    emailIntro:           body.emailIntro            ?? null,
    iban:                 body.iban                  ?? null,
    swiftCode:            body.swiftCode             ?? null,
    bankAccountHolder:    body.bankAccountHolder     ?? null,
    paymentInstructions:  body.paymentInstructions   ?? null,
    expiresAt:            body.expiresAt             ?? new Date(Date.now() + 7 * 86400_000).toISOString(),
    acceptUrl:            body.acceptUrl             ?? "#anteprima",
    companyPhone:         body.companyPhone          ?? null,
    companyWhatsapp:      body.companyWhatsapp       ?? null,
    footerPhone:          tenant?.contact_phone      ?? null,
  };

  const { html, subject } = buildQuoteOfferHtml(data);
  return NextResponse.json({ ok: true, html, subject });
}
