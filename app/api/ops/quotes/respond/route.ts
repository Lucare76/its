/**
 * GET /api/ops/quotes/respond?token=xxx&action=accepted|rejected
 * Endpoint pubblico — il cliente clicca il link dall'email.
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
  const action = searchParams.get("action");

  if (!token || !["accepted", "rejected"].includes(action ?? "")) {
    return NextResponse.redirect(new URL("/quote/respond?error=invalid", request.url));
  }

  const admin = adminClient();
  const { data: quote } = await admin
    .from("quotes")
    .select("id, status, route_label, price_cents, currency, client_name")
    .eq("response_token", token)
    .maybeSingle();

  if (!quote) return NextResponse.redirect(new URL("/quote/respond?error=notfound", request.url));
  if (quote.status !== "sent") return NextResponse.redirect(new URL(`/quote/respond?error=alreadyresponded&status=${String(quote.status)}`, request.url));

  await admin.from("quotes").update({ status: action }).eq("id", String(quote.id));

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";
  return NextResponse.redirect(new URL(`/quote/respond?success=${action}&route=${encodeURIComponent(String(quote.route_label))}`, appUrl));
}
