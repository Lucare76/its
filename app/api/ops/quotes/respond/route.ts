/**
 * POST /api/ops/quotes/respond  { token, action: "accepted" | "rejected" }
 * Endpoint pubblico, autorizzato dal token del preventivo (pagina /quote/respond).
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

function serviceMapping(code: unknown) {
  const normalized = String(code ?? "");
  switch (normalized) {
    case "bus_city_hotel":
      return { booking_service_kind: "bus_city_hotel", service_type_code: "bus_line", service_type: "bus_tour", vessel: "Linea bus" };
    case "excursion":
      return { booking_service_kind: "excursion", service_type_code: "excursion", service_type: "bus_tour", vessel: "Escursione" };
    case "transfer_airport_hotel":
      return { booking_service_kind: "transfer_airport_hotel", service_type_code: "transfer_airport_hotel", service_type: "transfer", vessel: "Aeroporto" };
    case "transfer_airport_hotel_exclusive":
      return { booking_service_kind: "transfer_airport_hotel_exclusive", service_type_code: "transfer_airport_hotel", service_type: "transfer", vessel: "Aeroporto esclusivo" };
    case "transfer_airport_hotel_aliscafo":
      return { booking_service_kind: "transfer_airport_hotel_aliscafo", service_type_code: "ferry_transfer", service_type: "transfer", vessel: "Aeroporto + aliscafo" };
    case "transfer_train_hotel":
      return { booking_service_kind: "transfer_train_hotel", service_type_code: "transfer_station_hotel", service_type: "transfer", vessel: "Stazione" };
    case "transfer_train_hotel_exclusive":
      return { booking_service_kind: "transfer_train_hotel_exclusive", service_type_code: "transfer_station_hotel", service_type: "transfer", vessel: "Stazione esclusivo" };
    case "transfer_train_hotel_aliscafo":
      return { booking_service_kind: "transfer_train_hotel_aliscafo", service_type_code: "ferry_transfer", service_type: "transfer", vessel: "Stazione + aliscafo" };
    case "formula_snav":
      return { booking_service_kind: "formula_snav", service_type_code: "ferry_transfer", service_type: "transfer", vessel: "SNAV" };
    case "formula_medmar_napoli":
      return { booking_service_kind: "formula_medmar_napoli", service_type_code: "ferry_transfer", service_type: "transfer", vessel: "MEDMAR Napoli" };
    case "formula_medmar_pozzuoli":
      return { booking_service_kind: "formula_medmar_pozzuoli", service_type_code: "ferry_transfer", service_type: "transfer", vessel: "MEDMAR Pozzuoli" };
    case "transfer_port_hotel":
    default:
      return { booking_service_kind: "transfer_port_hotel", service_type_code: "transfer_port_hotel", service_type: "transfer", vessel: "Porto" };
  }
}

async function createServicesFromAcceptedQuote(admin: ReturnType<typeof adminClient>, quote: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const tenantId = String(quote.tenant_id ?? "");
  const quoteId = String(quote.id ?? "");
  const customerName = String(quote.client_name ?? "").trim() || "Cliente preventivo";
  const pax = Math.max(1, Number(quote.passenger_count ?? 1));
  const routeLabel = String(quote.route_label ?? "");
  const serviceKind = String(quote.service_kind ?? "Preventivo");
  const mappedService = serviceMapping(quote.quote_service_code);
  const { data: wps } = await admin.from("quote_waypoints").select("label, waypoint_type").eq("quote_id", quoteId).order("sort_order");
  const pickupWaypoints = (wps ?? []).filter((w: { waypoint_type?: string | null }) => (w.waypoint_type ?? "pickup") === "pickup").map((w: { label: string }) => w.label);
  const dropoffWaypoints = (wps ?? []).filter((w: { waypoint_type?: string | null }) => w.waypoint_type === "dropoff").map((w: { label: string }) => w.label);

  const legs = [
    quote.arrival_date ? { direction: "arrival", date: String(quote.arrival_date), leg: "arrival" } : null,
    quote.departure_date ? { direction: "departure", date: String(quote.departure_date), leg: "departure" } : null,
  ].filter((leg): leg is { direction: "arrival" | "departure"; date: string; leg: string } => Boolean(leg));

  if (!tenantId || !quoteId || legs.length === 0) return { ok: true };

  // hotel_id è NOT NULL: recuperiamo il primo hotel del tenant come placeholder.
  const { data: hotels } = await admin.from("hotels").select("id").eq("tenant_id", tenantId).eq("is_active", true).limit(1);
  const placeholderHotelId = hotels?.[0]?.id;
  if (!placeholderHotelId) {
    console.error("[quotes] nessun hotel trovato per il tenant, impossibile creare servizi dal preventivo", quoteId);
    return { ok: false, error: "Nessun hotel disponibile per creare i servizi." };
  }

  const notes = [
    `Generato da preventivo accettato ${quoteId}.`,
    routeLabel ? `Tratta: ${routeLabel}` : "",
    serviceKind ? `Servizio: ${serviceKind}` : "",
    pickupWaypoints.length > 0 ? `Punti di carico: ${pickupWaypoints.join(" - ")}` : "",
    dropoffWaypoints.length > 0 ? `Punti di scarico: ${dropoffWaypoints.join(" - ")}` : "",
    quote.notes ? `Note preventivo: ${String(quote.notes)}` : "",
    "Orario, hotel e dettagli operativi da completare.",
  ].filter(Boolean).join("\n");

  const rows = legs.map((leg) => ({
    tenant_id: tenantId,
    is_draft: true,
    status: "needs_review",
    direction: leg.direction,
    date: leg.date,
    time: "00:00",
    arrival_date: leg.direction === "arrival" ? leg.date : null,
    arrival_time: leg.direction === "arrival" ? "00:00" : null,
    departure_date: leg.direction === "departure" ? leg.date : null,
    departure_time: leg.direction === "departure" ? "00:00" : null,
    service_type: mappedService.service_type,
    service_type_code: mappedService.service_type_code,
    booking_service_kind: mappedService.booking_service_kind,
    vessel: mappedService.vessel,
    pax,
    hotel_id: placeholderHotelId,
    customer_name: customerName,
    customer_email: quote.client_email ? String(quote.client_email) : null,
    phone: "",
    notes,
    billing_party_name: null,
    source_quote_id: quoteId,
    source_quote_leg: leg.leg,
  }));

  const { error } = await admin.from("services").upsert(rows, { onConflict: "tenant_id,source_quote_id,source_quote_leg", ignoreDuplicates: true });
  if (error) {
    console.error("[quotes] conversione preventivo in servizio fallita", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * GET: i vecchi link portano alla pagina del preventivo, senza eseguire nulla.
 * Accetta/rifiuta avviene solo con POST dalla pagina (un GET può essere aperto
 * da anteprime link e antivirus della posta).
 */
export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const target = new URL("/quote/respond", request.url);
  if (token) target.searchParams.set("token", token);
  return NextResponse.redirect(target);
}

function todayRome() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: unknown; action?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const action = body?.action === "accepted" || body?.action === "rejected" ? body.action : null;
  if (!token || token.length > 200 || !action) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });

  const admin = adminClient();
  const { data: quote } = await admin
    .from("quotes")
    .select("id, tenant_id, status, valid_until, quote_service_code, route_label, service_kind, price_cents, currency, passenger_count, arrival_date, departure_date, notes, client_name, client_email")
    .eq("response_token", token)
    .maybeSingle();

  if (!quote) return NextResponse.json({ ok: false, error: "notfound" }, { status: 404 });
  if (quote.status !== "sent") return NextResponse.json({ ok: false, error: "alreadyresponded", status: String(quote.status) }, { status: 409 });
  if (action === "accepted" && quote.valid_until && String(quote.valid_until) < todayRome()) {
    return NextResponse.json({ ok: false, error: "expired" }, { status: 410 });
  }

  // Passaggio atomico sent -> risposta: un doppio click o due schede non creano i servizi due volte.
  const { data: claimed, error: claimError } = await admin
    .from("quotes")
    .update({ status: action })
    .eq("id", String(quote.id))
    .eq("status", "sent")
    .select("id")
    .maybeSingle();
  if (claimError) return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  if (!claimed) return NextResponse.json({ ok: false, error: "alreadyresponded", status: action }, { status: 409 });

  if (action === "accepted") {
    const result = await createServicesFromAcceptedQuote(admin, quote as Record<string, unknown>);
    if (!result.ok) {
      await admin.from("quotes").update({ status: "sent" }).eq("id", String(quote.id)).eq("status", "accepted");
      return NextResponse.json({ ok: false, error: "service_creation_failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, action, route: String(quote.route_label ?? "") });
}
