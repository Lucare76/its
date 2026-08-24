/**
 * POST /api/agency/invoices/[id]/review — riscontro dell'agenzia (loggata)
 * sull'INTERO estratto conto in un'unica chiamata (mai una email per riga
 * contestata):
 *   { action: "approve" }                              — tutto corretto
 *   { action: "dispute", corrections: [{service_id, proposed_price_cents, note}] } — correzioni in blocco
 * Equivalente autenticato di POST /api/agency/statement-token (usato dalle
 * agenzie senza account, via link con token nell'email).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { sendOperatorInvoiceBatchDisputeNotifyEmail, sendOperatorInvoiceApprovedNotifyEmail } from "@/lib/server/agency-approval-email";
import { getRequestAppUrl } from "@/lib/app-url";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

type AgencyExtra = { agency_id?: string | null };

async function authorizeAgencyOnly(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest<"agency", AgencyExtra>(request, {
    roles: ["agency"],
    membershipFields: ["agency_id"],
    auditPrefix: "agency_invoice_review",
  });
  if (auth instanceof NextResponse) return auth;
  const agencyId = auth.membership.agency_id ?? null;
  if (!agencyId) {
    return NextResponse.json({ error: "Nessuna agenzia collegata a questo account." }, { status: 403 });
  }
  return { admin: auth.admin, user: auth.user, tenantId: auth.membership.tenant_id, agencyId };
}

type InvoiceLineItem = {
  service_id: string;
  numero_pratica: string;
  cliente_nome: string;
  data_servizio: string;
  tipo_servizio: string;
  importo_cents: number;
};

const correctionSchema = z.object({
  service_id: z.string().uuid(),
  proposed_price_cents: z.number().int().min(0).max(9999900),
  note: z.string().trim().max(1000).optional(),
});

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("dispute"), corrections: z.array(correctionSchema).min(1).max(200) }),
]);

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, tenantId, agencyId } = auth;
  const { id: invoiceId } = await params;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }
  const body = parsed.data;

  const { data: invoice, error: invErr } = await admin
    .from("agency_invoices")
    .select("id, agency_name, period_from, period_to, total_cents, invoice_data, agency_review_status")
    .eq("id", invoiceId)
    .eq("tenant_id", tenantId)
    .eq("agency_id", agencyId)
    .maybeSingle();
  if (invErr) return NextResponse.json({ error: invErr.message }, { status: 500 });
  if (!invoice) return NextResponse.json({ error: "Estratto conto non trovato." }, { status: 404 });
  if (invoice.agency_review_status !== "pending") {
    return NextResponse.json({ error: "Questo estratto conto è già stato revisionato." }, { status: 409 });
  }

  const now = new Date().toISOString();
  const appUrl = getRequestAppUrl(request.headers);

  if (body.action === "approve") {
    const { error: updateErr } = await admin
      .from("agency_invoices")
      .update({ agency_review_status: "approved", agency_reviewed_at: now })
      .eq("id", invoice.id);
    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    auditLog({
      event: "agency_invoice_approved",
      tenantId,
      role: "agency",
      outcome: "approved",
      details: { invoice_id: invoice.id, via: "session" },
    });

    try {
      await sendOperatorInvoiceApprovedNotifyEmail({
        agencyName: invoice.agency_name,
        periodFrom: invoice.period_from,
        periodTo: invoice.period_to,
        totalCents: invoice.total_cents,
      });
    } catch (error) {
      auditLog({
        event: "agency_invoice_approved_notify_failed",
        level: "warn",
        tenantId,
        details: { invoice_id: invoice.id, error: error instanceof Error ? error.message : "unknown" },
      });
    }

    return NextResponse.json({ ok: true, agency_review_status: "approved" });
  }

  // action === "dispute"
  const items = (invoice.invoice_data ?? []) as InvoiceLineItem[];
  const itemById = new Map(items.map((i) => [i.service_id, i]));
  for (const c of body.corrections) {
    if (!itemById.has(c.service_id)) {
      return NextResponse.json({ error: "Una delle pratiche non appartiene a questo estratto conto." }, { status: 403 });
    }
  }

  const serviceIds = body.corrections.map((c) => c.service_id);
  const { data: services, error: servicesErr } = await admin
    .from("services")
    .select("id, agency_id, agency_quoted_price_cents, date, customer_name, customer_first_name, customer_last_name")
    .in("id", serviceIds)
    .eq("tenant_id", tenantId);
  if (servicesErr) return NextResponse.json({ error: servicesErr.message }, { status: 500 });

  const serviceById = new Map((services ?? []).map((s) => [s.id, s]));
  for (const c of body.corrections) {
    const svc = serviceById.get(c.service_id);
    if (!svc || svc.agency_id !== agencyId) {
      return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
    }
    if (svc.agency_quoted_price_cents == null) {
      return NextResponse.json({ error: "Una pratica non ha un prezzo concordato da contestare." }, { status: 422 });
    }
  }

  const insertRows = body.corrections.map((c) => {
    const svc = serviceById.get(c.service_id)!;
    return {
      tenant_id: tenantId,
      agency_id: agencyId,
      agency_invoice_id: invoice.id,
      service_id: c.service_id,
      original_price_cents: svc.agency_quoted_price_cents as number,
      proposed_price_cents: c.proposed_price_cents,
      agency_note: c.note?.trim() || null,
      status: "pending",
      created_by: auth.user.id,
    };
  });

  const { data: inserted, error: insertErr } = await admin
    .from("agency_invoice_disputes")
    .insert(insertRows)
    .select("id, service_id, original_price_cents, proposed_price_cents");
  if (insertErr || !inserted) {
    return NextResponse.json({ error: insertErr?.message ?? "Errore creazione segnalazioni." }, { status: 500 });
  }

  const { error: updateErr } = await admin
    .from("agency_invoices")
    .update({ agency_review_status: "disputed", agency_reviewed_at: now })
    .eq("id", invoice.id);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

  auditLog({
    event: "agency_invoice_dispute_batch_created",
    tenantId,
    userId: auth.user.id,
    role: "agency",
    outcome: "pending",
    details: { invoice_id: invoice.id, via: "session", count: inserted.length },
  });

  try {
    const corrections = body.corrections.map((c) => {
      const svc = serviceById.get(c.service_id)!;
      const customerName = [svc.customer_first_name, svc.customer_last_name].filter(Boolean).join(" ") || svc.customer_name || "Cliente";
      return {
        customerName,
        serviceDate: svc.date ?? null,
        originalPriceCents: svc.agency_quoted_price_cents as number,
        proposedPriceCents: c.proposed_price_cents,
        agencyNote: c.note?.trim() || null,
      };
    });
    const emailResult = await sendOperatorInvoiceBatchDisputeNotifyEmail({
      agencyName: invoice.agency_name,
      periodFrom: invoice.period_from,
      periodTo: invoice.period_to,
      corrections,
      reviewUrl: `${appUrl}/agency-statement`,
    });
    if (emailResult.status === "failed") {
      auditLog({
        event: "agency_invoice_dispute_batch_notify_failed",
        level: "warn",
        tenantId,
        details: { invoice_id: invoice.id, error: emailResult.error },
      });
    }
  } catch (error) {
    auditLog({
      event: "agency_invoice_dispute_batch_notify_failed",
      level: "warn",
      tenantId,
      details: { invoice_id: invoice.id, error: error instanceof Error ? error.message : "unknown" },
    });
  }

  return NextResponse.json({ ok: true, agency_review_status: "disputed", disputes: inserted });
}
