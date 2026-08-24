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

  const { data: dispute, error: fetchErr } = await auth.admin
    .from("agency_invoice_disputes")
    .select("id, service_id, proposed_price_cents, status")
    .eq("id", disputeId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (fetchErr) return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  if (!dispute) return NextResponse.json({ error: "Segnalazione non trovata." }, { status: 404 });
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

  return NextResponse.json({ ok: true, status: action === "approve" ? "approved" : "rejected" });
}
