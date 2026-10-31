/**
 * POST /api/invoices/[id]/mark-paid
 * Marca un estratto conto come pagato.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { z } from "zod";
import { statementError } from "@/lib/server/agency-statements";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user?.id ?? null;

  const schema = z.object({
    payment_note: z.string().trim().max(1000).optional(),
    amount_cents: z.number().int().positive().optional(),
    idempotency_key: z.string().uuid(),
    paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    method: z.string().trim().min(1).max(100),
    report_id: z.string().uuid().optional(),
  });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, error: "Dati pagamento non validi." },
      { status: 400 },
    );
  const b = parsed.data;
  const { data, error } = await auth.admin.rpc("pay_agency_statement", {
    p_tenant_id: tenantId,
    p_invoice_id: id,
    p_amount: b.amount_cents ?? null,
    p_key: b.idempotency_key,
    p_user_id: userId,
    p_note: b.payment_note ?? null,
    p_paid_on: b.paid_on,
    p_method: b.method,
    p_report_id: b.report_id ?? null,
  });
  if (error)
    return NextResponse.json(
      { ok: false, error: statementError(error.message) },
      { status: 409 },
    );
  return NextResponse.json({ ok: true, ...data });
}
