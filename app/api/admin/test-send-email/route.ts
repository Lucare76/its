/**
 * GET /api/admin/test-send-email
 * Diagnostica: invia email di test con template reali per verifica mobile.
 * ?send=1       → email diagnostica semplice
 * ?send=booking → email riepilogo prenotazione (template reale)
 * ?send=operator → email notifica operatore (template reale)
 */
import { NextRequest, NextResponse } from "next/server";
import { sendAgencyBookingConfirmationEmail } from "@/lib/server/agency-booking-email";
import { sendOperatorNotifyEmail } from "@/lib/server/agency-approval-email";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.ischiatransferservice.it";

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;
  const apiKey   = process.env.RESEND_API_KEY;
  const fromEmail = getVerifiedFromEmail();
  const opsEmail  = process.env.OPS_NOTIFY_EMAIL;
  const bccEmail  = process.env.NOTIFY_BCC_EMAIL;

  const url  = new URL(request.url);
  const send = url.searchParams.get("send");

  // Solo info configurazione
  if (!send) {
    return NextResponse.json({
      info: "Parametri: ?send=1 (semplice) | ?send=booking (conferma agenzia) | ?send=operator (notifica operatore)",
      env: {
        RESEND_API_KEY:            apiKey ? `${apiKey.slice(0, 8)}…` : "⚠️ MANCANTE",
        AGENCY_BOOKING_FROM_EMAIL: fromEmail,
        OPS_NOTIFY_EMAIL:          opsEmail  ?? "⚠️ MANCANTE",
        NOTIFY_BCC_EMAIL:          bccEmail  ?? "⚠️ MANCANTE",
      },
    });
  }

  if (!apiKey)   return NextResponse.json({ ok: false, error: "RESEND_API_KEY non configurata" }, { status: 500 });
  if (!opsEmail) return NextResponse.json({ ok: false, error: "OPS_NOTIFY_EMAIL non configurata" }, { status: 500 });

  // --- Email riepilogo prenotazione agenzia ---
  if (send === "booking") {
    const result = await sendAgencyBookingConfirmationEmail({
      to: opsEmail,
      customerName: "Mario Rossi",
      recipientName: "Aleste Viaggi",
      serviceKindLabel: "Formula SNAV — Transfer porto → Hotel Moresco",
      arrivalDate: "2026-05-10",
      arrivalTime: "10:30",
      departureDate: "2026-05-17",
      departureTime: "09:00",
      hotelName: "Hotel Moresco",
      pax: 3,
      notes: "Volo FR1234. Camera doppia + singola. Cliente allergico al glutine.",
      pendingConfirmation: true,
    });
    return NextResponse.json({ ok: result.status !== "failed", status: result.status, error: result.error, sent_to: opsEmail, bcc: bccEmail });
  }

  // --- Email notifica operatore ---
  if (send === "operator") {
    const result = await sendOperatorNotifyEmail({
      serviceId: "test-service-001",
      customerName: "Mario Rossi",
      customerPhone: "+39 333 1234567",
      customerEmail: "mario.rossi@example.com",
      agencyName: "Aleste Viaggi",
      serviceCtx: {
        kind: "formula_snav",
        transportCode: "FR1234 / FR5678",
        busCityOrigin: null,
        excursionTitle: null,
        hotelName: "Hotel Moresco",
      },
      arrivalDate: "2026-05-10",
      arrivalTime: "10:30",
      departureDate: "2026-05-17",
      departureTime: "09:00",
      hotelName: "Hotel Moresco",
      pax: 3,
      notes: "Camera doppia + singola. Cliente allergico al glutine.",
      approvalUrl: `${APP_URL}/operator/approve/test-token-abc123`,
      quotedPriceCents: 18500,
      catalogPriceCents: 18500,
    });
    return NextResponse.json({ ok: result.status !== "failed", status: result.status, error: result.error, sent_to: opsEmail, bcc: bccEmail });
  }

  // --- Email diagnostica semplice (?send=1) ---
  const from    = `Ischia Transfer Service <${fromEmail}>`;
  const payload: Record<string, unknown> = {
    from,
    to: [opsEmail],
    subject: "[TEST] Email diagnostica — Ischia Transfer",
    html: "<p>Questa è un'email di <strong>test diagnostica</strong>. Se la ricevi, Resend funziona correttamente.</p>",
    text: "Email di test diagnostica. Se la ricevi, Resend funziona correttamente.",
  };
  if (bccEmail) payload.bcc = [bccEmail];

  try {
    const res = await resendFetch(apiKey, payload);
    const resendStatus = res.status;
    const resendBody   = await res.text().catch(() => "");
    if (!res.ok) return NextResponse.json({ ok: false, resend_status: resendStatus, resend_error: resendBody });
    let parsed: unknown = null;
    try { parsed = JSON.parse(resendBody); } catch { /* noop */ }
    return NextResponse.json({ ok: true, message_id: (parsed as Record<string, unknown>)?.id ?? null, from, to: [opsEmail], bcc: bccEmail ? [bccEmail] : [] });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Network error" });
  }
}
