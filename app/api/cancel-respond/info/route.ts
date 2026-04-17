/**
 * GET /api/cancel-respond/info?token=UUID
 * Endpoint pubblico — carica i dettagli di una richiesta di cancellazione tramite token.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function makeAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get("token")?.trim();
    if (!token) return NextResponse.json({ ok: false, error: "Token mancante." }, { status: 400 });

    const admin = makeAdmin();
    if (!admin) return NextResponse.json({ ok: false, error: "Configurazione server mancante." }, { status: 500 });

    const { data: cr } = await admin
      .from("cancellation_requests")
      .select(`
        id, cancel_legs, status, penalty_cents, penalty_note,
        services(
          customer_name, pax,
          arrival_date, arrival_time,
          departure_date,
          hotels(name)
        )
      `)
      .eq("approval_token", token)
      .maybeSingle();

    if (!cr) return NextResponse.json({ ok: false, error: "Richiesta non trovata." }, { status: 404 });

    const svc = Array.isArray(cr.services) ? cr.services[0] : cr.services as Record<string, unknown>;
    const hotelRaw = svc?.hotels;
    const hotelName = (Array.isArray(hotelRaw) ? hotelRaw[0]?.name : (hotelRaw as { name?: string } | null)?.name) ?? "N/D";

    return NextResponse.json({
      ok: true,
      data: {
        id: cr.id,
        cancel_legs: cr.cancel_legs,
        status: cr.status,
        penalty_cents: cr.penalty_cents,
        penalty_note: cr.penalty_note,
        service: {
          customer_name: svc?.customer_name,
          pax: svc?.pax,
          hotel_name: hotelName,
          arrival_date: svc?.arrival_date ?? null,
          arrival_time: svc?.arrival_time ?? null,
          departure_date: svc?.departure_date ?? null,
        },
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
