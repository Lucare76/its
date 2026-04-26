/**
 * POST /api/admin/test-review-email
 * Invia un'email di test del workflow revisione agenzie a rennasday@gmail.com.
 * Solo admin. Usa dati fittizi per il 10 maggio 2026.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceListEmailHtml, buildServiceListPlainText } from "@/lib/server/service-list-email";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export const runtime = "nodejs";

const TEST_DATE  = "2026-05-10";
const TEST_EMAIL = "rennasday@gmail.com";
const TEST_AGENCY = "Aleste Viaggi (TEST)";

const TEST_SERVICES = [
  { service_id: "test-001", date: TEST_DATE, time: "09:00", customer_name: "Famiglia Bianchi", pax: 3, hotel_or_destination: "Hotel Moresco", direction: "arrival"   as const },
  { service_id: "test-002", date: TEST_DATE, time: "11:30", customer_name: "Coppia Verdi",     pax: 2, hotel_or_destination: "Hotel Regina Isabella", direction: "arrival" as const },
  { service_id: "test-003", date: TEST_DATE, time: "14:00", customer_name: "Rossi Group",      pax: 6, hotel_or_destination: "Porto Ischia",           direction: "departure" as const },
  { service_id: "test-004", date: TEST_DATE, time: "16:45", customer_name: "Tour Esposito",    pax: 4, hotel_or_destination: "Hotel San Montano",       direction: "arrival"   as const },
];

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  const apiKey = process.env.RESEND_API_KEY;
  const from   = getVerifiedFromEmail();
  if (!apiKey || !from) return NextResponse.json({ error: "RESEND_API_KEY o AGENCY_BOOKING_FROM_EMAIL non configurati." }, { status: 500 });

  // 1. Crea sessione di revisione
  const { data: sess, error: sessErr } = await auth.admin
    .from("agency_review_sessions")
    .insert({
      tenant_id:   auth.membership.tenant_id,
      agency_name: TEST_AGENCY,
      report_type: "arrivals_48h",
      target_date: TEST_DATE,
      services:    TEST_SERVICES,
    })
    .select("id, token")
    .single();

  if (sessErr || !sess) return NextResponse.json({ error: sessErr?.message ?? "Errore creazione sessione." }, { status: 500 });

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://ischiatransferservice.it";
  const reviewUrl = `${appUrl}/review/${sess.token}`;

  // 2. Invia email con bottoni revisione
  const html = buildServiceListEmailHtml({
    agencyName:   TEST_AGENCY,
    type:         "arrivals_48h",
    targetDate:   TEST_DATE,
    lines:        TEST_SERVICES,
    reviewToken:  sess.token,
  });
  const text = buildServiceListPlainText({
    agencyName:  TEST_AGENCY,
    type:        "arrivals_48h",
    targetDate:  TEST_DATE,
    lines:       TEST_SERVICES,
  });

  const res = await resendFetch(apiKey, {
    from,
    to: [TEST_EMAIL],
    subject: `[TEST] Riepilogo arrivi +48h — ${TEST_AGENCY} — ${TEST_DATE}`,
    html,
    text,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return NextResponse.json({ error: `Resend error ${res.status}: ${body.slice(0, 200)}` }, { status: 500 });
  }

  const resBody = await res.json().catch(() => null) as { id?: string } | null;

  return NextResponse.json({
    ok: true,
    sent_to:    TEST_EMAIL,
    message_id: resBody?.id ?? null,
    review_url: reviewUrl,
    session_id: sess.id,
    note: "Apri review_url per testare il flusso agenzia.",
  });
}
