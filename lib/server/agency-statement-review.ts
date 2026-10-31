import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  sendOperatorInvoiceBatchDisputeNotifyEmail,
  sendOperatorInvoiceApprovedNotifyEmail,
} from "@/lib/server/agency-approval-email";
import { statementError } from "@/lib/server/agency-statements";
import { NextResponse } from "next/server";
const correction = z.object({
  service_id: z.string().uuid(),
  proposed_price_cents: z.number().int().min(0).max(9999900),
  note: z.string().trim().max(1000).optional(),
});
export const reviewSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({
    action: z.literal("draft"),
    corrections: z.array(correction).max(200),
  }),
  z.object({
    action: z.literal("dispute"),
    corrections: z.array(correction).min(1).max(200),
  }),
]);
export async function reviewStatement(
  admin: SupabaseClient,
  tenantId: string,
  agencyId: string,
  invoiceId: string,
  body: unknown,
  userId: string | null,
  appUrl: string,
) {
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const b = parsed.data;
  const { data: invoice, error: readError } = await admin
    .from("agency_invoices")
    .select(
      "id,agency_name,invoice_number,period_from,period_to,total_cents,invoice_data",
    )
    .eq("tenant_id", tenantId)
    .eq("agency_id", agencyId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (readError || !invoice)
    return NextResponse.json(
      { error: "Estratto non trovato." },
      { status: 404 },
    );
  const { data, error } = await admin.rpc("review_agency_statement", {
    p_tenant_id: tenantId,
    p_agency_id: agencyId,
    p_invoice_id: invoiceId,
    p_action: b.action,
    p_corrections: b.action === "approve" ? [] : b.corrections,
    p_user_id: userId,
  });
  if (error)
    return NextResponse.json(
      { error: statementError(error.message) },
      { status: 409 },
    );
  if (b.action === "draft") return NextResponse.json({ ok: true, draft: true });
  // The RPC wins once. Only the winning final submission can send one notification email.
  let emailStatus = "failed";
  try {
    const label = `${invoice.agency_name} · ${invoice.invoice_number}`;
    const result =
      b.action === "approve"
        ? await sendOperatorInvoiceApprovedNotifyEmail({
            agencyName: label,
            periodFrom: invoice.period_from,
            periodTo: invoice.period_to,
            totalCents: invoice.total_cents,
          })
        : await sendOperatorInvoiceBatchDisputeNotifyEmail({
            agencyName: label,
            periodFrom: invoice.period_from,
            periodTo: invoice.period_to,
            reviewUrl: `${appUrl}/agency-statement`,
            corrections: b.corrections.map((c) => {
              const item = (
                invoice.invoice_data as Array<{
                  service_id: string;
                  cliente_nome: string;
                  data_servizio: string;
                  importo_cents: number;
                }>
              ).find((i) => i.service_id === c.service_id)!;
              return {
                customerName: item.cliente_nome,
                serviceDate: item.data_servizio,
                originalPriceCents: item.importo_cents,
                proposedPriceCents: c.proposed_price_cents,
                agencyNote: c.note ?? null,
              };
            }),
          });
    emailStatus = result.status;
  } catch {
    console.error("statement_review_email_failed", { tenantId, invoiceId });
  }
  return NextResponse.json({
    ok: true,
    agency_review_status: b.action === "approve" ? "approved" : "disputed",
    disputes: data?.disputes ?? [],
    email_notification: emailStatus,
  });
}
