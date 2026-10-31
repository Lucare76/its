import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { statementError } from "@/lib/server/agency-statements";
export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const { data, error } = await auth.admin
    .from("agency_statement_payment_reports")
    .select(
      "id,invoice_id,amount_cents,paid_on,method,note,status,created_at,agency_invoices(invoice_number,agency_name)",
    )
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("status", "pending")
    .order("created_at");
  if (error)
    return NextResponse.json(
      { error: "Impossibile leggere i pagamenti da verificare." },
      { status: 503 },
    );
  return NextResponse.json({ ok: true, reports: data ?? [] });
}
export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const p = z
    .object({
      report_id: z.string().uuid(),
      action: z.enum(["verify", "reject"]),
    })
    .safeParse(await request.json().catch(() => null));
  if (!p.success)
    return NextResponse.json(
      { error: "Richiesta non valida." },
      { status: 400 },
    );
  const { data: r, error: e } = await auth.admin
    .from("agency_statement_payment_reports")
    .select("*")
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("id", p.data.report_id)
    .maybeSingle();
  if (e || !r)
    return NextResponse.json(
      { error: "Segnalazione non trovata." },
      { status: 404 },
    );
  if (r.status !== "pending")
    return NextResponse.json(
      { error: "Segnalazione già gestita." },
      { status: 409 },
    );
  if (p.data.action === "reject") {
    const { data: updated, error } = await auth.admin
      .from("agency_statement_payment_reports")
      .update({
        status: "rejected",
        verified_at: new Date().toISOString(),
        verified_by: auth.user.id,
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", r.id)
      .eq("status", "pending")
      .select("id");
    if (!error && !updated?.length)
      return NextResponse.json(
        { error: "Segnalazione già gestita." },
        { status: 409 },
      );
    if (error)
      return NextResponse.json(
        { error: "Operazione non completata." },
        { status: 500 },
      );
  } else {
    const { error } = await auth.admin.rpc("pay_agency_statement", {
      p_tenant_id: auth.membership.tenant_id,
      p_invoice_id: r.invoice_id,
      p_amount: r.amount_cents,
      p_key: r.id,
      p_user_id: auth.user.id,
      p_note: r.note,
      p_paid_on: r.paid_on,
      p_method: r.method,
      p_report_id: r.id,
    });
    if (error)
      return NextResponse.json(
        { error: statementError(error.message) },
        { status: 409 },
      );
  }
  return NextResponse.json({ ok: true });
}
