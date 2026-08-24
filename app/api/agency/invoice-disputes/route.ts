/**
 * POST /api/agency/invoice-disputes — l'agenzia segnala un prezzo che
 * ritiene sbagliato su una riga dell'estratto conto già inviata (una
 * prenotazione con agency_quoted_price_cents valorizzato). Crea una
 * contestazione "pending"; la risoluzione (approva/rifiuta) è solo lato ITS
 * — vedi app/api/ops/agency-invoice-disputes/[id]/resolve/route.ts.
 * GET /api/agency/invoice-disputes — l'agenzia vede lo stato delle proprie.
 *
 * Distinta dal meccanismo services.approval_status/price_mismatch (quello
 * scatta quando l'agenzia INSERISCE una nuova prenotazione con un prezzo che
 * non combacia col listino interno — verso opposto: qui è l'agenzia a
 * proporre una correzione su una riga già fatturata).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { sendOperatorInvoiceDisputeNotifyEmail } from "@/lib/server/agency-approval-email";
import { getRequestAppUrl } from "@/lib/app-url";

export const runtime = "nodejs";

type AgencyExtra = { agency_id?: string | null };

async function authorizeAgencyOnly(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest<"agency", AgencyExtra>(request, {
    roles: ["agency"],
    membershipFields: ["agency_id"],
    auditPrefix: "agency_invoice_dispute",
  });
  if (auth instanceof NextResponse) return auth;
  const agencyId = auth.membership.agency_id ?? null;
  if (!agencyId) {
    return NextResponse.json({ error: "Nessuna agenzia collegata a questo account." }, { status: 403 });
  }
  return { admin: auth.admin, user: auth.user, tenantId: auth.membership.tenant_id, agencyId };
}

const postSchema = z.object({
  service_id: z.string().uuid(),
  agency_invoice_id: z.string().uuid().nullable().optional(),
  proposed_price_cents: z.number().int().min(0).max(9999900),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, user, tenantId, agencyId } = auth;

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }
  const { service_id, agency_invoice_id, proposed_price_cents, note } = parsed.data;

  const { data: service, error: serviceErr } = await admin
    .from("services")
    .select("id, agency_id, agency_quoted_price_cents, date, customer_name, customer_first_name, customer_last_name")
    .eq("id", service_id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (serviceErr) return NextResponse.json({ error: serviceErr.message }, { status: 500 });
  if (!service) return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
  if (service.agency_id !== agencyId) {
    return NextResponse.json({ error: "Questa prenotazione non appartiene alla tua agenzia." }, { status: 403 });
  }
  if (service.agency_quoted_price_cents == null) {
    return NextResponse.json({ error: "Nessun prezzo concordato da contestare su questa pratica." }, { status: 422 });
  }

  const { data: existingPending, error: existingErr } = await admin
    .from("agency_invoice_disputes")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("service_id", service_id)
    .eq("status", "pending")
    .maybeSingle();
  if (existingErr) return NextResponse.json({ error: existingErr.message }, { status: 500 });
  if (existingPending) {
    return NextResponse.json({ error: "Hai già una segnalazione in attesa per questa pratica." }, { status: 409 });
  }

  const { data: dispute, error: insertErr } = await admin
    .from("agency_invoice_disputes")
    .insert({
      tenant_id: tenantId,
      agency_id: agencyId,
      agency_invoice_id: agency_invoice_id ?? null,
      service_id,
      original_price_cents: service.agency_quoted_price_cents,
      proposed_price_cents,
      agency_note: note?.trim() || null,
      status: "pending",
      created_by: user.id,
    })
    .select("id, original_price_cents, proposed_price_cents, status, created_at")
    .single();
  if (insertErr || !dispute) {
    return NextResponse.json({ error: insertErr?.message ?? "Errore creazione segnalazione." }, { status: 500 });
  }

  auditLog({
    event: "agency_invoice_dispute_created",
    tenantId,
    userId: user.id,
    role: "agency",
    serviceId: service_id,
    outcome: "pending",
    details: { dispute_id: dispute.id, original_price_cents: dispute.original_price_cents, proposed_price_cents: dispute.proposed_price_cents },
  });

  // Notifica ITS via email — best-effort: la segnalazione e' gia' salvata e
  // visibile in /agency-statement anche se l'invio fallisce (stessa logica
  // "mai far percepire come fallita un'operazione gia' commit-ata" usata
  // altrove nel repo, es. lib/server/whatsapp/webhook-processing.ts).
  try {
    const { data: agencyRow } = await admin
      .from("agencies")
      .select("name")
      .eq("id", agencyId)
      .maybeSingle();
    const appUrl = getRequestAppUrl(request.headers);
    const customerName = [service.customer_first_name, service.customer_last_name].filter(Boolean).join(" ") || service.customer_name || "Cliente";
    const emailResult = await sendOperatorInvoiceDisputeNotifyEmail({
      agencyName: agencyRow?.name ?? "Agenzia",
      customerName,
      serviceDate: service.date ?? null,
      originalPriceCents: dispute.original_price_cents,
      proposedPriceCents: dispute.proposed_price_cents,
      agencyNote: note?.trim() || null,
      reviewUrl: `${appUrl}/agency-statement`,
    });
    if (emailResult.status === "failed") {
      auditLog({
        event: "agency_invoice_dispute_notify_failed",
        level: "warn",
        tenantId,
        serviceId: service_id,
        details: { dispute_id: dispute.id, error: emailResult.error },
      });
    }
  } catch (error) {
    auditLog({
      event: "agency_invoice_dispute_notify_failed",
      level: "warn",
      tenantId,
      serviceId: service_id,
      details: { dispute_id: dispute.id, error: error instanceof Error ? error.message : "unknown" },
    });
  }

  return NextResponse.json({ ok: true, dispute });
}

export async function GET(request: NextRequest) {
  const auth = await authorizeAgencyOnly(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, tenantId, agencyId } = auth;

  const { data, error } = await admin
    .from("agency_invoice_disputes")
    .select("id, service_id, original_price_cents, proposed_price_cents, agency_note, status, resolution_note, created_at, resolved_at")
    .eq("tenant_id", tenantId)
    .eq("agency_id", agencyId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, disputes: data ?? [] });
}
