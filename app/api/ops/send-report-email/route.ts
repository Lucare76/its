/**
 * POST /api/ops/send-report-email
 * Invia un riepilogo operativo direttamente a un'agenzia con bottoni Approva/Modifica.
 * Chiamato dal CRM agenzie (invio manuale).
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceListEmailHtml, buildServiceListPlainText, type ServiceListEmailType } from "@/lib/server/service-list-email";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export const runtime = "nodejs";

const REPORT_LABELS: Record<string, string> = {
  arrivals_48h:   "Riepilogo arrivi +48h",
  departures_48h: "Riepilogo partenze +48h",
  bus_monday:     "Riepilogo linea bus domenica",
};

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as {
    agency_name: string;
    report_type: string;
    target_date: string;
    services: unknown[];
    review_token?: string;
    to_email?: string; // override destinatario
  } | null;

  if (!body?.agency_name || !body?.report_type || !body?.target_date || !body?.services?.length) {
    return NextResponse.json({ error: "Dati mancanti." }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from   = getVerifiedFromEmail();
  if (!apiKey || !from) return NextResponse.json({ error: "Email provider non configurato." }, { status: 500 });

  // Risolvi email destinatario
  let toEmail = body.to_email ?? "";
  if (!toEmail) {
    const { data: agency } = await auth.admin
      .from("agencies")
      .select("booking_email, contact_email")
      .eq("tenant_id", auth.membership.tenant_id)
      .ilike("name", `%${body.agency_name}%`)
      .maybeSingle();
    toEmail = agency?.booking_email ?? agency?.contact_email ?? "";
  }

  if (!toEmail) {
    return NextResponse.json({ error: `Email non trovata per ${body.agency_name}.` }, { status: 422 });
  }

  const emailType = body.report_type as ServiceListEmailType;
  const label = REPORT_LABELS[body.report_type] ?? body.report_type;
  const lines = (body.services as any[]).map((s) => ({
    date:                s.date,
    time:                s.time,
    customer_name:       s.customer_name,
    pax:                 s.pax,
    hotel_or_destination: s.hotel_or_destination ?? null,
    direction:           s.direction as "arrival" | "departure",
    transport_type:      s.transport_type ?? null,
    transport_time:      s.transport_time ?? null,
  }));

  const html = buildServiceListEmailHtml({
    agencyName:  body.agency_name,
    type:        emailType,
    targetDate:  body.target_date,
    lines,
    reviewToken: body.review_token,
  });
  const text = buildServiceListPlainText({
    agencyName: body.agency_name,
    type:       emailType,
    targetDate: body.target_date,
    lines,
  });

  const res = await resendFetch(apiKey, {
    from,
    to: [toEmail],
    subject: `${label} — ${body.agency_name} — ${body.target_date}`,
    html,
    text,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return NextResponse.json({ error: `Invio fallito (${res.status}): ${errBody.slice(0, 200)}` }, { status: 500 });
  }

  const resBody = await res.json().catch(() => null) as { id?: string } | null;
  return NextResponse.json({ ok: true, sent_to: toEmail, message_id: resBody?.id ?? null });
}
