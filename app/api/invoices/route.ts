/**
 * GET  /api/invoices  — lista estratti conto del tenant
 * POST /api/invoices  — genera + salva (e opzionalmente invia) un estratto conto
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { generateInvoiceHtml, type InvoiceLineItem } from "@/lib/server/invoice-pdf";

export const runtime = "nodejs";

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const url = new URL(request.url);
  const agencyId = url.searchParams.get("agency_id");
  const status = url.searchParams.get("status");

  let query = (auth.admin as any)
    .from("agency_invoices")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("period_from", { ascending: false })
    .limit(200);

  if (agencyId) query = query.eq("agency_id", agencyId);
  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, invoices: data ?? [] });
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;

  let body: { agency_id?: string; agency_name?: string; period_from?: string; period_to?: string; send?: boolean };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { agency_id, agency_name, period_from, period_to, send = false } = body;
  if (!agency_name || !period_from || !period_to) {
    return NextResponse.json({ ok: false, error: "agency_name, period_from, period_to obbligatori." }, { status: 400 });
  }

  // Recupera agenzia
  const { data: agencyRow } = await (auth.admin as any)
    .from("agencies")
    .select("id, name, invoice_email, contact_email, booking_email")
    .eq("tenant_id", tenantId)
    .eq("name", agency_name)
    .maybeSingle();

  const invoiceEmail = agencyRow?.invoice_email ?? agencyRow?.contact_email ?? agencyRow?.booking_email ?? null;

  // Recupera servizi nel periodo
  const { data: services, error: servicesError } = await (auth.admin as any)
    .from("services")
    .select("id, date, time, customer_name, customer_first_name, customer_last_name, billing_party_name, booking_service_kind, service_type, notes, source_total_amount_cents, pax")
    .eq("tenant_id", tenantId)
    .eq("is_draft", false)
    .ilike("billing_party_name", `%${agency_name}%`)
    .gte("date", period_from)
    .lte("date", period_to)
    .order("date");

  if (servicesError) return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });

  const items: InvoiceLineItem[] = (services ?? []).map((s: any) => {
    // Estrai numero pratica dalle note
    const practiceMatch = (s.notes ?? "").match(/\[practice:([^\]]+)\]/);
    const practiceNumber = practiceMatch?.[1] ?? "—";
    const clienteName = [s.customer_first_name, s.customer_last_name].filter(Boolean).join(" ") || s.customer_name || "—";
    const tipoServizio = s.booking_service_kind ?? s.service_type ?? "transfer";
    return {
      numero_pratica: practiceNumber,
      cliente_nome: clienteName,
      data_servizio: s.date ?? period_from,
      tipo_servizio: tipoServizio,
      importo_cents: s.source_total_amount_cents ?? 0
    };
  });

  const totalCents = items.reduce((sum, i) => sum + i.importo_cents, 0);
  const createdAt = new Date().toISOString();

  // Salva nel DB
  const { data: invoice, error: insertError } = await (auth.admin as any)
    .from("agency_invoices")
    .insert({
      tenant_id: tenantId,
      agency_id: agencyRow?.id ?? agency_id ?? null,
      agency_name,
      period_from,
      period_to,
      status: "draft",
      total_cents: totalCents,
      services_count: items.length,
      invoice_data: items,
      created_at: createdAt
    })
    .select("id")
    .single();

  if (insertError || !invoice?.id) {
    return NextResponse.json({ ok: false, error: insertError?.message ?? "Errore creazione estratto conto." }, { status: 500 });
  }

  const invoiceId = invoice.id as string;

  // Genera HTML
  const html = generateInvoiceHtml({
    agencyName: agency_name,
    agencyEmail: invoiceEmail,
    periodFrom: period_from,
    periodTo: period_to,
    invoiceId,
    createdAt,
    items,
    totalCents
  });

  // Invia via Resend se richiesto
  if (send && invoiceEmail && process.env.RESEND_API_KEY) {
    const fromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransfer.it";
    const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
    const [fy, fm] = period_from.split("-");
    const [ty, tm] = period_to.split("-");
    const periodLabel = fm === tm ? `${months[Number(fm)-1]} ${fy}` : `${months[Number(fm)-1]}-${months[Number(tm)-1]} ${fy}`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `Ischia Transfer Service <${fromEmail}>`,
        to: [invoiceEmail],
        subject: `Estratto conto ${periodLabel} — ${agency_name}`,
        html
      })
    });

    await (auth.admin as any)
      .from("agency_invoices")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", invoiceId);
  }

  return NextResponse.json({ ok: true, invoice_id: invoiceId, items_count: items.length, total_cents: totalCents, html });
}
