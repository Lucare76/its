/**
 * POST /api/services/medmar-send
 *
 * Marca i servizi MEDMAR/SNAV come inviati e spedisce l'email all'agenzia.
 * Body: { service_ids: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function generateMedmarEmailHtml(data: {
  agencyName: string;
  agencyEmail: string;
  customerName: string;
  customerPhone: string | null;
  pax: number;
  hotel: string;
  pratica: string;
  arrivo: { date: string; time: string | null; mezzo: string | null } | null;
  partenza: { date: string; time: string | null; mezzo: string | null } | null;
  sentAt: string;
}): string {
  const formatDate = (iso: string) => {
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };
  const formatTime = (t: string | null) => t ?? "—";

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Arial, sans-serif; color: #1a1a1a; background: #f5f5f5; margin: 0; padding: 24px; }
  .card { background: #fff; border-radius: 12px; max-width: 560px; margin: 0 auto; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  h2 { margin: 0 0 4px; font-size: 20px; color: #0f172a; }
  .subtitle { color: #64748b; font-size: 13px; margin: 0 0 24px; }
  .badge { display: inline-block; background: #dbeafe; color: #1e40af; border-radius: 20px; padding: 3px 12px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
  td { padding: 8px 0; font-size: 14px; }
  td:first-child { color: #64748b; width: 140px; }
  td:last-child { font-weight: 600; }
  .section { border-top: 1px solid #e2e8f0; margin-top: 20px; padding-top: 20px; }
  .tratta { background: #f8fafc; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; }
  .tratta-label { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: #64748b; text-transform: uppercase; margin-bottom: 6px; }
  .tratta-info { font-size: 14px; font-weight: 600; color: #0f172a; }
  .tratta-sub { font-size: 12px; color: #64748b; margin-top: 2px; }
  .footer { margin-top: 28px; font-size: 12px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="badge">⚓ Biglietto MEDMAR</div>
  <h2>Conferma servizio marittimo</h2>
  <p class="subtitle">Pratica ${data.pratica} — ${data.agencyName}</p>

  <table>
    <tr><td>Cliente</td><td>${data.customerName}</td></tr>
    <tr><td>Cellulare</td><td>${data.customerPhone ?? "—"}</td></tr>
    <tr><td>Passeggeri</td><td>${data.pax}</td></tr>
    <tr><td>Hotel</td><td>${data.hotel}</td></tr>
    <tr><td>N. Pratica</td><td>${data.pratica}</td></tr>
  </table>

  <div class="section">
    ${data.arrivo ? `
    <div class="tratta">
      <div class="tratta-label">Andata — Arrivo a Ischia</div>
      <div class="tratta-info">${formatDate(data.arrivo.date)} ore ${formatTime(data.arrivo.time)}</div>
      ${data.arrivo.mezzo ? `<div class="tratta-sub">${data.arrivo.mezzo}</div>` : ""}
    </div>` : ""}
    ${data.partenza ? `
    <div class="tratta">
      <div class="tratta-label">Ritorno — Partenza da Ischia</div>
      <div class="tratta-info">${formatDate(data.partenza.date)} ore ${formatTime(data.partenza.time)}</div>
      ${data.partenza.mezzo ? `<div class="tratta-sub">${data.partenza.mezzo}</div>` : ""}
    </div>` : ""}
  </div>

  <div class="footer">
    Inviato da Ischia Transfer Service — ${new Date(data.sentAt).toLocaleString("it-IT")}<br>
    info@ischiatransferservice.it
  </div>
</div>
</body>
</html>`;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  let body: { service_ids?: string[]; pdf_base64?: string; pdf_filename?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return NextResponse.json({ ok: false, error: "Body non valido." }, { status: 400 }); }

  const { service_ids, pdf_base64, pdf_filename = "biglietto-medmar.pdf" } = body;
  if (!service_ids?.length) {
    return NextResponse.json({ ok: false, error: "service_ids obbligatorio." }, { status: 400 });
  }

  // Recupera i servizi
  const { data: services, error: svcErr } = await (auth.admin as any)
    .from("services")
    .select("id, date, time, customer_name, customer_phone, pax, hotel_id, billing_party_name, notes, booking_service_kind, direction")
    .in("id", service_ids)
    .eq("tenant_id", tenantId);

  if (svcErr || !services?.length) {
    return NextResponse.json({ ok: false, error: "Servizi non trovati." }, { status: 404 });
  }

  const first = services[0] as any;
  const billingParty = first.billing_party_name ?? "";

  // Estrai numero pratica dalle note
  const practiceMatch = (first.notes ?? "").match(/\[practice:([^\]]+)\]/);
  const pratica = practiceMatch?.[1] ?? "N/D";

  // Recupera hotel
  const hotelId = first.hotel_id;
  let hotelName = "—";
  if (hotelId) {
    const { data: hotel } = await (auth.admin as any)
      .from("hotels")
      .select("name")
      .eq("id", hotelId)
      .maybeSingle();
    hotelName = hotel?.name ?? "—";
  }

  // Recupera email agenzia
  let agencyEmail: string | null = null;
  if (billingParty) {
    const { data: agency } = await (auth.admin as any)
      .from("agencies")
      .select("invoice_email, contact_email, booking_email")
      .eq("tenant_id", tenantId)
      .ilike("name", `%${billingParty}%`)
      .maybeSingle();
    agencyEmail = agency?.invoice_email ?? agency?.contact_email ?? agency?.booking_email ?? null;
  }

  // Determina andata e ritorno
  const sorted = [...services].sort((a: any, b: any) => a.date.localeCompare(b.date));
  const arrivoSvc = sorted.find((s: any) => s.direction === "arrival" || s.booking_service_kind?.includes("port")) ?? sorted[0];
  const partenzaSvc = sorted.find((s: any) => s.direction === "departure" || (sorted.length > 1 && s.id !== arrivoSvc?.id)) ?? null;

  const now = new Date().toISOString();
  const customerName = first.customer_name ?? "Cliente";
  const customerPhone = first.customer_phone ?? null;
  const pax = first.pax ?? 1;

  // Marca come inviati
  const { error: updateErr } = await (auth.admin as any)
    .from("services")
    .update({ medmar_ticket_sent_at: now, medmar_ticket_sent_by: userId })
    .in("id", service_ids)
    .eq("tenant_id", tenantId);

  if (updateErr) {
    return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
  }

  // Invia email se c'è un indirizzo
  if (agencyEmail && process.env.RESEND_API_KEY) {
    const fromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransferservice.it";
    const html = generateMedmarEmailHtml({
      agencyName: billingParty || "Agenzia",
      agencyEmail,
      customerName,
      customerPhone,
      pax,
      hotel: hotelName,
      pratica,
      arrivo: arrivoSvc ? { date: arrivoSvc.date, time: arrivoSvc.time ?? null, mezzo: arrivoSvc.booking_service_kind ?? null } : null,
      partenza: partenzaSvc ? { date: partenzaSvc.date, time: partenzaSvc.time ?? null, mezzo: partenzaSvc.booking_service_kind ?? null } : null,
      sentAt: now
    });

    const emailPayload: Record<string, unknown> = {
      from: `Ischia Transfer Service <${fromEmail}>`,
      to: [agencyEmail],
      subject: `Biglietto MEDMAR — ${customerName} (${pratica})`,
      html
    };
    if (pdf_base64) {
      emailPayload.attachments = [{ filename: pdf_filename, content: pdf_base64 }];
    }
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify(emailPayload)
    });
  }

  return NextResponse.json({ ok: true, sent_to: agencyEmail, pratica, marked: service_ids.length });
}
