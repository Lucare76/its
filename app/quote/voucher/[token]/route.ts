import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildServiceQuoteVoucherHtml } from "@/lib/server/service-quote-voucher";

export const runtime = "nodejs";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

type Params = { params: Promise<{ token: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { token } = await params;
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
    return new NextResponse("Token non valido.", { status: 400 });
  }

  const admin = adminClient();
  const { data: quote, error } = await admin
    .from("service_quotes")
    .select("id,tenant_id,status")
    .eq("accept_token", token)
    .single();

  if (error || !quote) return new NextResponse("Voucher non trovato.", { status: 404 });
  if (quote.status !== "confirmed" && quote.status !== "paid") {
    return new NextResponse("Voucher non ancora disponibile.", { status: 409 });
  }

  const html = await buildServiceQuoteVoucherHtml(admin, String(quote.tenant_id), String(quote.id));
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}
