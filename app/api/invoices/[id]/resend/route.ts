/**
 * POST /api/invoices/[id]/resend
 * Reinvia via email un estratto conto esistente all'agenzia.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { generateInvoiceHtml } from "@/lib/server/invoice-pdf";
import { getVerifiedFromEmail } from "@/lib/server/send-email";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const admin = auth.admin as any;

  // Carica l'estratto conto
  const { data: invoice, error } = await admin
    .from("agency_invoices")
    .select("*")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .single();

  if (error || !invoice) {
    return NextResponse.json({ ok: false, error: "Estratto conto non trovato." }, { status: 404 });
  }

  // Recupera email agenzia
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

  if (!process.env.RESEND_API_KEY) {
    return NextResponse.json({ ok: false, error: "RESEND_API_KEY non configurata." }, { status: 500 });
  }

  // Rigenera HTML dall'invoice_data salvato
  const html = generateInvoiceHtml({
    agencyName: invoice.agency_name,
    agencyEmail: invoiceEmail,
    periodFrom: invoice.period_from,
    periodTo: invoice.period_to,
    invoiceId: invoice.id,
    createdAt: invoice.created_at,
    items: invoice.invoice_data ?? [],
    totalCents: invoice.total_cents,
  });

  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  const [fy, fm] = (invoice.period_from as string).split("-");
  const [, tm] = (invoice.period_to as string).split("-");
  const periodLabel = fm === tm
    ? `${months[Number(fm) - 1]} ${fy}`
    : `${months[Number(fm) - 1]}–${months[Number(tm) - 1]} ${fy}`;

  const fromEmail = getVerifiedFromEmail();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `Ischia Transfer Service <${fromEmail}>`,
      to: [invoiceEmail],
      subject: `Estratto conto ${periodLabel} — ${invoice.agency_name}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    return NextResponse.json({ ok: false, error: `Errore invio: ${err}` }, { status: 500 });
  }

  // Aggiorna stato a "sent"
  await admin
    .from("agency_invoices")
    .update({ status: "sent", sent_at: new Date().toISOString() })
    .eq("id", id)
    .eq("tenant_id", tenantId);

  return NextResponse.json({ ok: true, sent_to: invoiceEmail });
}
