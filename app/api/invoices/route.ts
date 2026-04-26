/**
 * GET  /api/invoices  — lista estratti conto del tenant
 * POST /api/invoices  — genera + salva (e opzionalmente invia) un estratto conto
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { generateInvoiceHtml, type InvoiceLineItem } from "@/lib/server/invoice-pdf";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";
import { type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type ServiceRow = {
  id: string;
  date: string | null;
  time: string | null;
  customer_name: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  billing_party_name: string | null;
  booking_service_kind: string | null;
  service_type: string | null;
  notes: string | null;
  source_total_amount_cents: number | null;
  pax: number | null;
};

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
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, invoices: data ?? [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Restituisce tutti i billing_party_name distinti che corrispondono all'agenzia.
 * Usa matching bidirezionale: cerca se il nome agenzia contiene il billing_party_name
 * O se il billing_party_name contiene il nome agenzia (es. "SOSANDRA" ↔ "SOSANDRA TOUR BY ROSSELLA…").
 */
async function resolveBillingNames(
  admin: SupabaseClient,
  tenantId: string,
  agencyName: string
): Promise<string[]> {
  const { data } = await admin
    .from("services")
    .select("billing_party_name")
    .eq("tenant_id", tenantId)
    .not("billing_party_name", "is", null);

  if (!data?.length) return [agencyName];

  const agencyLower = agencyName.toLowerCase();
  const distinct = [...new Set((data as Array<{ billing_party_name: string }>)
    .map((r) => r.billing_party_name)
    .filter(Boolean)
  )];

  const matched = distinct.filter((bpn) => {
    const bpnLower = bpn.toLowerCase();
    return agencyLower.includes(bpnLower) || bpnLower.includes(agencyLower);
  });

  // Se non c'è nessun match, fallback al nome agenzia originale (ilike nel caller)
  return matched.length > 0 ? matched : [];
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const admin = auth.admin as SupabaseClient;
  const tenantId = auth.membership.tenant_id;

  let body: { agency_id?: string; agency_name?: string; period_from?: string; period_to?: string; send?: boolean };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body JSON non valido." }, { status: 400 }); }

  const { agency_id, agency_name, period_from, period_to, send = false } = body;
  if (!agency_name || !period_from || !period_to) {
    return NextResponse.json({ ok: false, error: "agency_name, period_from, period_to obbligatori." }, { status: 400 });
  }

  // Recupera agenzia — email priorità: booking > contact > invoice
  const { data: agencyRow } = await admin
    .from("agencies")
    .select("id, name, booking_email, contact_email, invoice_email, booking_emails, contact_emails, email")
    .eq("tenant_id", tenantId)
    .eq("name", agency_name)
    .maybeSingle();

  const invoiceEmail: string | null =
    (agencyRow as any)?.booking_email ??
    (Array.isArray((agencyRow as any)?.booking_emails) && (agencyRow as any).booking_emails.length > 0 ? (agencyRow as any).booking_emails[0] : null) ??
    (agencyRow as any)?.contact_email ??
    (Array.isArray((agencyRow as any)?.contact_emails) && (agencyRow as any).contact_emails.length > 0 ? (agencyRow as any).contact_emails[0] : null) ??
    (agencyRow as any)?.invoice_email ??
    (agencyRow as any)?.email ??
    null;

  // Risolve i billing_party_name che corrispondono all'agenzia (matching bidirezionale)
  const billingNames = await resolveBillingNames(admin, tenantId, agency_name);

  let serviceQuery = admin
    .from("services")
    .select("id, date, time, customer_name, customer_first_name, customer_last_name, billing_party_name, booking_service_kind, service_type, notes, source_total_amount_cents, pax")
    .eq("tenant_id", tenantId)
    .eq("is_draft", false)
    .gte("date", period_from)
    .lte("date", period_to)
    .order("date");

  if (billingNames.length > 0) {
    serviceQuery = serviceQuery.in("billing_party_name", billingNames);
  } else {
    // Fallback ilike se non ci sono billing_party_name nel DB
    serviceQuery = serviceQuery.ilike("billing_party_name", `%${agency_name}%`);
  }

  const { data: services, error: servicesError } = await serviceQuery;
  if (servicesError) return NextResponse.json({ ok: false, error: servicesError.message }, { status: 500 });

  const items: InvoiceLineItem[] = ((services ?? []) as ServiceRow[]).map((s) => {
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
  const { data: invoice, error: insertError } = await admin
    .from("agency_invoices")
    .insert({
      tenant_id: tenantId,
      agency_id: (agencyRow as any)?.id ?? agency_id ?? null,
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

  if (insertError || !(invoice as any)?.id) {
    return NextResponse.json({ ok: false, error: insertError?.message ?? "Errore creazione estratto conto." }, { status: 500 });
  }

  const invoiceId = (invoice as any).id as string;

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
    const fromEmail = getVerifiedFromEmail();
    const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
    const [fy, fm] = period_from.split("-");
    const periodLabel = fm === period_to.split("-")[1]
      ? `${months[Number(fm)-1]} ${fy}`
      : `${months[Number(fm)-1]}-${months[Number(period_to.split("-")[1])-1]} ${fy}`;

    await resendFetch(process.env.RESEND_API_KEY!, {
      from: `Ischia Transfer Service <${fromEmail}>`,
      to: [invoiceEmail],
      subject: `Estratto conto ${periodLabel} — ${agency_name}`,
      html
    });

    await admin
      .from("agency_invoices")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", invoiceId);
  }

  return NextResponse.json({ ok: true, invoice_id: invoiceId, items_count: items.length, total_cents: totalCents, html });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
