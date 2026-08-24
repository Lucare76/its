/**
 * POST /api/invoices/[id]/remind
 * Invia un sollecito di pagamento all'agenzia per un estratto conto gia'
 * inviato (status "sent") e non ancora saldato. Non cambia lo stato
 * dell'estratto: solo email, il "Segna pagato" resta l'unica azione che
 * marca status="paid" (POST /api/invoices/[id]/mark-paid).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendAgencyInvoicePaymentReminderEmail } from "@/lib/server/agency-approval-email";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const admin = auth.admin;

  const { data: invoice, error } = await admin
    .from("agency_invoices")
    .select("id, agency_name, period_from, period_to, total_cents, services_count, status, sent_at")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!invoice) return NextResponse.json({ ok: false, error: "Estratto conto non trovato." }, { status: 404 });
  if (invoice.status !== "sent") {
    return NextResponse.json({ ok: false, error: "Il sollecito è disponibile solo per estratti già inviati e non ancora saldati." }, { status: 409 });
  }

  const { data: agencyRow } = await admin
    .from("agencies")
    .select("invoice_email, contact_email, booking_email")
    .eq("tenant_id", tenantId)
    .eq("name", invoice.agency_name)
    .maybeSingle();

  const invoiceEmail = agencyRow?.invoice_email ?? agencyRow?.contact_email ?? agencyRow?.booking_email ?? null;
  if (!invoiceEmail) {
    return NextResponse.json({ ok: false, error: "Nessuna email configurata per questa agenzia." }, { status: 400 });
  }

  const emailResult = await sendAgencyInvoicePaymentReminderEmail({
    to: invoiceEmail,
    agencyName: invoice.agency_name,
    periodFrom: invoice.period_from,
    periodTo: invoice.period_to,
    totalCents: invoice.total_cents,
    servicesCount: invoice.services_count,
    sentAt: invoice.sent_at,
  });

  if (emailResult.status === "failed") {
    return NextResponse.json({ ok: false, error: emailResult.error ?? "Invio fallito." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, sent_to: invoiceEmail });
}
