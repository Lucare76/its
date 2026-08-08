import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

// GET — load quote details by token (for the public accept page)
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ error: "Token non valido." }, { status: 400 });
  }

  const admin = adminClient();
  const { data: quote, error } = await admin
    .from("service_quotes")
    .select("id,tenant_id,quote_number,status,customer_first_name,customer_last_name,customer_language,service_type,direction,arrival_date,arrival_time,arrival_flight_train,departure_date,departure_time,departure_flight_train,hotel_name,hotel_address,pax,luggage_notes,special_requests,price_cents,price_mode,currency,price_notes,email_intro,iban,swift_code,bank_account_holder,payment_instructions,expires_at,accept_token_expires_at")
    .eq("accept_token", token)
    .single();

  if (error || !quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  const { data: items } = await admin
    .from("service_quote_items")
    .select("*")
    .eq("tenant_id", quote.tenant_id)
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true });

  return NextResponse.json({ ok: true, quote: { ...quote, items: items ?? [] } });
}

// POST — accept the quote
export async function POST(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return NextResponse.json({ error: "Token non valido." }, { status: 400 });
  }

  const admin = adminClient();
  const { data: quote, error: fetchErr } = await admin
    .from("service_quotes")
    .select("id,status,accept_token_expires_at")
    .eq("accept_token", token)
    .single();

  if (fetchErr || !quote) return NextResponse.json({ error: "Preventivo non trovato." }, { status: 404 });

  if (quote.status === "accepted" || quote.status === "paid" || quote.status === "confirmed") {
    return NextResponse.json({ ok: true, already_accepted: true });
  }

  if (quote.status !== "offer_sent") {
    return NextResponse.json({ error: "Offerta non disponibile per l'accettazione." }, { status: 409 });
  }

  if (quote.accept_token_expires_at && new Date(quote.accept_token_expires_at) < new Date()) {
    return NextResponse.json({ error: "L'offerta è scaduta." }, { status: 410 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? request.headers.get("x-real-ip")
    ?? null;

  const now = new Date().toISOString();
  const { error: updateErr } = await admin
    .from("service_quotes")
    .update({
      status:      "accepted",
      accepted_at: now,
      accepted_ip: ip,
      updated_at:  now,
    })
    .eq("id", quote.id);

  if (updateErr) {
    auditLog({
      event: "public_service_quote_accept_failed",
      level: "error",
      details: { quoteId: quote.id, message: updateErr.message },
    });
    return NextResponse.json({ error: "Impossibile completare l'accettazione del preventivo." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, already_accepted: false });
}
