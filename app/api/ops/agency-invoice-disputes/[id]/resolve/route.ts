/**
 * POST /api/ops/agency-invoice-disputes/[id]/resolve
 * Body: { action: "approve" | "reject", resolution_note?: string }
 * approve -> applica proposed_price_cents a services.agency_quoted_price_cents.
 * reject  -> nessuna modifica al prezzo, solo stato della contestazione.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";
import { sendAgencyInvoiceDisputeResolvedEmail } from "@/lib/server/agency-approval-email";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["approve", "reject"]),
  resolution_note: z.string().trim().max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { id: disputeId } = await params;
  const tenantId = auth.membership.tenant_id;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }
  const { action, resolution_note } = parsed.data;

  type DisputeRow = {
    id: string;
    service_id: string;
    original_price_cents: number;
    proposed_price_cents: number;
    status: string;
    services: { customer_name: string | null; customer_first_name: string | null; customer_last_name: string | null; date: string | null; email_confirmation_to: string | null } | Array<{ customer_name: string | null; customer_first_name: string | null; customer_last_name: string | null; date: string | null; email_confirmation_to: string | null }> | null;
    agencies: { contact_email: string | null; booking_email: string | null } | Array<{ contact_email: string | null; booking_email: string | null }> | null;
  };

  const { data: disputeRaw, error: fetchErr } = await auth.admin
    .from("agency_invoice_disputes")
    .select(
      "id, service_id, original_price_cents, proposed_price_cents, status, " +
      "services(customer_name, customer_first_name, customer_last_name, date, email_confirmation_to), " +
      "agencies(contact_email, booking_email)"
    )
    .eq("id", disputeId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!disputeRaw) return NextResponse.json({ error: "Segnalazione non trovata." }, { status: 404 });
  const dispute = disputeRaw as unknown as DisputeRow;
  if (dispute.status !== "pending") {
    return NextResponse.json({ error: "Questa segnalazione è già stata risolta." }, { status: 409 });
  }

  const now = new Date().toISOString();

  if (action === "approve") {
    const { error: updateSvcErr } = await auth.admin
      .from("services")
      .update({ agency_quoted_price_cents: dispute.proposed_price_cents })
      .eq("id", dispute.service_id)
      .eq("tenant_id", tenantId);
    if (updateSvcErr) return NextResponse.json({ error: updateSvcErr.message }, { status: 500 });
  }

  const { error: updateDisputeErr } = await auth.admin
    .from("agency_invoice_disputes")
    .update({
      status: action === "approve" ? "approved" : "rejected",
      resolved_by: auth.user.id,
      resolved_at: now,
      resolution_note: resolution_note?.trim() || null,
    })
    .eq("id", disputeId)
    .eq("tenant_id", tenantId);
  if (updateDisputeErr) return NextResponse.json({ error: updateDisputeErr.message }, { status: 500 });

  auditLog({
    event: "agency_invoice_dispute_resolved",
    tenantId,
    userId: auth.user.id,
    role: auth.membership.role,
    serviceId: dispute.service_id,
    outcome: action === "approve" ? "approved" : "rejected",
    details: { dispute_id: disputeId, proposed_price_cents: dispute.proposed_price_cents },
  });

  // Notifica l'agenzia con l'esito — best-effort: la risoluzione e' gia'
  // salvata anche se l'invio fallisce (stessa logica usata in
  // app/api/agency/invoice-disputes/route.ts).
  try {
    const serviceRow = Array.isArray(dispute.services) ? dispute.services[0] : dispute.services;
    const agencyRow = Array.isArray(dispute.agencies) ? dispute.agencies[0] : dispute.agencies;
    const emailTo = serviceRow?.email_confirmation_to ?? agencyRow?.booking_email ?? agencyRow?.contact_email ?? null;
    if (emailTo) {
      const customerName = [serviceRow?.customer_first_name, serviceRow?.customer_last_name].filter(Boolean).join(" ") || serviceRow?.customer_name || "Cliente";
      const emailResult = await sendAgencyInvoiceDisputeResolvedEmail({
        to: emailTo,
        customerName,
        serviceDate: serviceRow?.date ?? null,
        originalPriceCents: dispute.original_price_cents,
        proposedPriceCents: dispute.proposed_price_cents,
        approved: action === "approve",
        resolutionNote: resolution_note?.trim() || null,
      });
      if (emailResult.status === "failed") {
        auditLog({
          event: "agency_invoice_dispute_resolved_notify_failed",
          level: "warn",
          tenantId,
          serviceId: dispute.service_id,
          details: { dispute_id: disputeId, error: emailResult.error },
        });
      }
    }
  } catch (error) {
    auditLog({
      event: "agency_invoice_dispute_resolved_notify_failed",
      level: "warn",
      tenantId,
      serviceId: dispute.service_id,
      details: { dispute_id: disputeId, error: error instanceof Error ? error.message : "unknown" },
    });
  }

  return NextResponse.json({ ok: true, status: action === "approve" ? "approved" : "rejected" });
}
