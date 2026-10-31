/**
 * GET  /api/agency/statement-token?token=xxx — vista pubblica (no login)
 * dell'estratto conto per agenzie senza account nell'area agenzia. Il token
 * (HMAC self-contained, lib/server/agency-action-token.ts, act:"invoice_review")
 * autorizza SOLO l'estratto conto specifico per cui e' stato generato.
 *
 * POST /api/agency/statement-token — riscontro dell'agenzia sull'INTERO
 * estratto conto, in un'unica chiamata (mai una email per riga contestata):
 *   { token, action: "approve" }                              — tutto corretto
 *   { token, action: "dispute", corrections: [{service_id, proposed_price_cents, note}] } — correzioni in blocco
 * Equivalente pubblico (no login) di POST /api/agency/invoices/[id]/review.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { reviewStatement } from "@/lib/server/agency-statement-review";
import { statementItems } from "@/lib/server/agency-statements";
import { verifyAgencyActionToken } from "@/lib/server/agency-action-token";
import { getRequestAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(
    /^["']|["']$/g,
    "",
  );
  if (!url || !key) throw new Error("Supabase non configurato.");
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const payload = verifyAgencyActionToken(token);
  if (!payload || payload.act !== "invoice_review" || !payload.iid) {
    return NextResponse.json(
      { error: "Token non valido o scaduto." },
      { status: 400 },
    );
  }

  const admin = adminClient();

  const { data: invoice, error: invErr } = await admin
    .from("agency_invoices")
    .select(
      "id, invoice_number, date_basis, paid_cents, waived_cents, review_draft, agency_name, period_from, period_to, status, total_cents, services_count, invoice_data, sent_at, agency_review_status, agency_reviewed_at",
    )
    .eq("id", payload.iid)
    .eq("tenant_id", payload.tid)
    .eq("agency_id", payload.aid)
    .maybeSingle();
  if (invErr)
    return NextResponse.json({ error: invErr.message }, { status: 500 });
  if (!invoice)
    return NextResponse.json(
      { error: "Estratto conto non trovato." },
      { status: 404 },
    );

  const { data: disputes, error: dispErr } = await admin
    .from("agency_invoice_disputes")
    .select(
      "id, service_id, original_price_cents, proposed_price_cents, status, resolution_note, created_at, resolved_at",
    )
    .eq("tenant_id", payload.tid)
    .eq("agency_id", payload.aid)
    .eq("agency_invoice_id", payload.iid);
  if (dispErr)
    return NextResponse.json({ error: dispErr.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    invoice: {
      ...invoice,
      invoice_data: statementItems(invoice.invoice_data ?? []),
    },
    disputes: disputes ?? [],
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const payload = verifyAgencyActionToken(
    typeof body?.token === "string" ? body.token : "",
  );
  if (!payload || payload.act !== "invoice_review" || !payload.iid)
    return NextResponse.json(
      { error: "Token non valido o scaduto." },
      { status: 400 },
    );
  return reviewStatement(
    adminClient(),
    payload.tid,
    payload.aid,
    payload.iid,
    body,
    null,
    getRequestAppUrl(request.headers),
  );
}
