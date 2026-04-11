/**
 * GET /api/admin/test-send-email
 * Diagnostica: invia email di test e restituisce risposta Resend completa.
 * Non richiede autenticazione (solo per debug locale/vercel logs).
 * Rimuovere o proteggere dopo il debug.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.AGENCY_BOOKING_FROM_EMAIL ?? "noreply@ischiatransferservice.it";
  const opsEmail  = process.env.OPS_NOTIFY_EMAIL;
  const bccEmail  = process.env.NOTIFY_BCC_EMAIL;

  // Mostra configurazione senza inviare se non c'è il param ?send=1
  const url = new URL(request.url);
  if (url.searchParams.get("send") !== "1") {
    return NextResponse.json({
      info: "Aggiungi ?send=1 per inviare email di test",
      env: {
        RESEND_API_KEY:   apiKey ? `${apiKey.slice(0, 8)}…` : "⚠️ MANCANTE",
        AGENCY_BOOKING_FROM_EMAIL: fromEmail,
        OPS_NOTIFY_EMAIL:  opsEmail  ?? "⚠️ MANCANTE",
        NOTIFY_BCC_EMAIL:  bccEmail  ?? "⚠️ MANCANTE",
      },
    });
  }

  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "RESEND_API_KEY non configurata" }, { status: 500 });
  }
  if (!opsEmail) {
    return NextResponse.json({ ok: false, error: "OPS_NOTIFY_EMAIL non configurata" }, { status: 500 });
  }

  const from = `Ischia Transfer Service <${fromEmail}>`;
  const to   = [opsEmail];
  const bcc  = bccEmail ? [bccEmail] : [];

  const payload: Record<string, unknown> = {
    from,
    to,
    subject: "[TEST] Email diagnostica — Ischia Transfer",
    html: "<p>Questa è un'email di <strong>test diagnostica</strong>. Se la ricevi, Resend funziona correttamente.</p>",
    text: "Email di test diagnostica. Se la ricevi, Resend funziona correttamente.",
  };
  if (bcc.length) payload.bcc = bcc;

  let resendStatus = 0;
  let resendBody   = "";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    resendStatus = res.status;
    resendBody   = await res.text().catch(() => "");

    if (!res.ok) {
      return NextResponse.json({
        ok: false,
        resend_status: resendStatus,
        resend_error: resendBody,
        from,
        to,
        bcc,
      }, { status: 200 }); // 200 per leggere la risposta facilmente
    }

    let parsed: unknown = null;
    try { parsed = JSON.parse(resendBody); } catch { /* noop */ }

    return NextResponse.json({
      ok: true,
      message_id: (parsed as Record<string, unknown>)?.id ?? null,
      from,
      to,
      bcc,
      resend_status: resendStatus,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      resend_status: resendStatus,
      resend_body: resendBody,
    }, { status: 200 });
  }
}
