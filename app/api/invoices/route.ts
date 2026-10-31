import {
  createStatement,
  statementData,
  statementSchema,
  statementError,
  statementItems,
} from "@/lib/server/agency-statements";
/**
 * GET  /api/invoices  — lista estratti conto del tenant
 * POST /api/invoices  — genera + salva (e opzionalmente invia) un estratto conto
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  generateInvoiceHtml,
  buildInvoiceXlsx,
} from "@/lib/server/invoice-pdf";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";
import { getRequestAppUrl } from "@/lib/app-url";
import { generateAgencyActionToken } from "@/lib/server/agency-action-token";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration=120;

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const admin = auth.admin as SupabaseClient;
    const tenantId = auth.membership.tenant_id;
    const url = new URL(request.url);
    const agencyId = url.searchParams.get("agency_id");
    const status = url.searchParams.get("status");

    let query = admin
      .from("agency_invoices")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("period_from", { ascending: false })
      .limit(200);

    if (agencyId) query = query.eq("agency_id", agencyId);
    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error)
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 },
      );
    return NextResponse.json({
      ok: true,
      invoices: (data ?? []).map((i) => ({
        ...i,
        invoice_data: statementItems(i.invoice_data ?? []),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Errore interno.",
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const parsed = statementSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const input = parsed.data;
  try {
    const admin = auth.admin as SupabaseClient;
    const tenantId = auth.membership.tenant_id;
    const query = admin
      .from("agencies")
      .select(
        "id,name,invoice_email,booking_email,contact_email,email,booking_emails,contact_emails",
      )
      .eq("tenant_id", tenantId);
    const { data: agency, error: agencyError } = await (
      input.agency_id
        ? query.eq("id", input.agency_id)
        : query.eq("name", input.agency_name)
    ).maybeSingle();
    if (agencyError || !agency)
      return NextResponse.json(
        {
          ok: false,
          error: "Agenzia non trovata: seleziona una voce dell’anagrafica.",
        },
        { status: 400 },
      );
    const email =
      agency.invoice_email ||
      agency.booking_email ||
      agency.booking_emails?.[0] ||
      agency.contact_email ||
      agency.contact_emails?.[0] ||
      agency.email;
    if (input.send && (!email || !process.env.RESEND_API_KEY))
      return NextResponse.json(
        {
          ok: false,
          error: "Email agenzia o servizio di invio non configurato.",
        },
        { status: 400 },
      );
    const { invoice, reused } = await createStatement(
      admin,
      tenantId,
      agency.id,
      input.period_from,
      input.period_to,
      input.date_basis,
    );
    const appUrl = getRequestAppUrl(request.headers);
    let reviewUrl = `${appUrl}/agency/statement`;
    try {
      reviewUrl = `${appUrl}/agency-estratto-conto?token=${encodeURIComponent(generateAgencyActionToken({ sid: "", aid: agency.id, tid: tenantId, act: "invoice_review", iid: invoice.id }, 60))}`;
    } catch {}
    const data = statementData(invoice, email, reviewUrl);
    const html = generateInvoiceHtml(data);
    // Repeated generation returns the existing document and never resends automatically.
    if (input.send && !reused) {
      const response = await resendFetch(process.env.RESEND_API_KEY!, {
        from: `Ischia Transfer Service <${getVerifiedFromEmail()}>`,
        to: [email],
        subject: `Estratto conto ${invoice.invoice_number} — ${agency.name}`,
        html,
        attachments: [
          {
            filename: `${invoice.invoice_number}.xlsx`,
            content: buildInvoiceXlsx(data).toString("base64"),
          },
        ],
      });
      if (!response.ok)
        return NextResponse.json(
          {
            ok: false,
            invoice_id: invoice.id,
            error:
              "Estratto salvato in bozza. Invio non riuscito: usa Re-invia.",
          },
          { status: 502 },
        );
      const { error } = await admin
        .from("agency_invoices")
        .update({
          status:
            invoice.paid_cents + invoice.waived_cents >= invoice.total_cents
              ? "paid"
              : "sent",
          sent_at: new Date().toISOString(),
        })
        .eq("tenant_id", tenantId)
        .eq("id", invoice.id);
      if (error)
        return NextResponse.json(
          {
            ok: false,
            error:
              "Email accettata ma stato non aggiornato. Verifica prima di reinviare.",
          },
          { status: 500 },
        );
    }
    return NextResponse.json({
      ok: true,
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      reused,
      items_count: invoice.services_count,
      total_cents: invoice.total_cents,
      html,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: statementError(error instanceof Error ? error.message : ""),
      },
      { status: 409 },
    );
  }
}
