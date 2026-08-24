/**
 * POST /api/invoices/[id]/resend
 * Reinvia via email un estratto conto esistente all'agenzia.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { generateInvoiceHtml, buildInvoiceXlsx } from "@/lib/server/invoice-pdf";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";
import { getRequestAppUrl } from "@/lib/app-url";
import { generateAgencyActionToken } from "@/lib/server/agency-action-token";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const tenantId = auth.membership.tenant_id;
  const admin = auth.admin;

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

  // Rigenera HTML dall'invoice_data salvato — link con token se l'agenzia
  // e' risolta (funziona senza login), altrimenti fallback alla pagina che
  // richiede login. Se la generazione del token fallisce, non deve mai
  // bloccare il reinvio: fallback silenzioso.
  const appUrl = getRequestAppUrl(request.headers);
  let reviewUrl = `${appUrl}/agency/statement`;
  if (invoice.agency_id) {
    try {
      const token = generateAgencyActionToken({ sid: "", aid: invoice.agency_id, tid: tenantId, act: "invoice_review", iid: invoice.id }, 60);
      reviewUrl = `${appUrl}/agency-estratto-conto?token=${encodeURIComponent(token)}`;
    } catch { /* fallback gia' impostato sopra */ }
  }
  const html = generateInvoiceHtml({
    agencyName: invoice.agency_name,
    agencyEmail: invoiceEmail,
    periodFrom: invoice.period_from,
    periodTo: invoice.period_to,
    invoiceId: invoice.id,
    createdAt: invoice.created_at,
    items: invoice.invoice_data ?? [],
    totalCents: invoice.total_cents,
    reviewUrl,
  });

  const months = ["gen","feb","mar","apr","mag","giu","lug","ago","set","ott","nov","dic"];
  const [fy, fm] = (invoice.period_from as string).split("-");
  const [, tm] = (invoice.period_to as string).split("-");
  const periodLabel = fm === tm
    ? `${months[Number(fm) - 1]} ${fy}`
    : `${months[Number(fm) - 1]}–${months[Number(tm) - 1]} ${fy}`;

  const xlsxBuffer = buildInvoiceXlsx({
    agencyName: invoice.agency_name,
    agencyEmail: invoiceEmail,
    periodFrom: invoice.period_from,
    periodTo: invoice.period_to,
    invoiceId: invoice.id,
    createdAt: invoice.created_at,
    items: invoice.invoice_data ?? [],
    totalCents: invoice.total_cents,
  });
  const xlsxFilename = `estratto_conto_${String(invoice.agency_name).replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase()}_${invoice.period_from}_${invoice.period_to}.xlsx`;

  const fromEmail = getVerifiedFromEmail();
  const res = await resendFetch(process.env.RESEND_API_KEY!, {
    from: `Ischia Transfer Service <${fromEmail}>`,
    to: [invoiceEmail],
    subject: `Estratto conto ${periodLabel} — ${invoice.agency_name}`,
    html,
    attachments: [{ filename: xlsxFilename, content: xlsxBuffer.toString("base64") }],
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
