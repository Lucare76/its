/**
 * GET /api/quote/details?token=xxx
 * Endpoint pubblico — restituisce i dettagli del preventivo per il portale cliente.
 * Non richiede autenticazione (accessibile dal link email).
 */
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json({ ok: false, error: "Token mancante." }, { status: 400 });
  }

  const admin = adminClient();

  const { data: quote } = await admin
    .from("quotes")
    .select("id, route_label, service_kind, price_cents, currency, passenger_count, valid_until, notes, client_name, status")
    .eq("response_token", token)
    .maybeSingle();

  if (!quote) {
    return NextResponse.json({ ok: false, error: "Preventivo non trovato." }, { status: 404 });
  }

  // Non esporre preventivi in stati non validi
  if (!["sent", "accepted", "rejected"].includes(quote.status as string)) {
    return NextResponse.json({ ok: false, error: "Preventivo non disponibile." }, { status: 404 });
  }

  const { data: wps } = await admin
    .from("quote_waypoints")
    .select("label")
    .eq("quote_id", String(quote.id))
    .order("sort_order");

  return NextResponse.json({
    ok: true,
    quote: {
      id: quote.id,
      route_label: quote.route_label,
      service_kind: quote.service_kind,
      price_cents: quote.price_cents,
      currency: quote.currency,
      passenger_count: quote.passenger_count ?? null,
      valid_until: quote.valid_until ?? null,
      notes: quote.notes ?? null,
      client_name: quote.client_name ?? null,
      status: quote.status,
      waypoints: (wps ?? []).map((w: { label: string }) => w.label),
    },
  });
}
