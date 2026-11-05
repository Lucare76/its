/**
 * POST /api/ops/send-report-email
 * Invia un riepilogo operativo direttamente a un'agenzia con bottoni Approva/Modifica.
 * Chiamato dal CRM agenzie (invio manuale).
 */
import * as XLSX from "xlsx";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildServiceListEmailHtml, buildServiceListPlainText, type ServiceLine, type ServiceListEmailType } from "@/lib/server/service-list-email";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

export const runtime = "nodejs";

const REPORT_LABELS: Record<string, string> = {
  arrivals_day: "Riepilogo arrivi del giorno",
  departures_day: "Riepilogo partenze del giorno",
  arrivals_departures_day: "Riepilogo arrivi e partenze del giorno",
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
  const lines = body.services as ServiceLine[];
  const workbook = XLSX.utils.book_new();
  for (const [direction, sheetName] of [["arrival", "Arrivi"], ["departure", "Partenze"]] as const) {
    const rows = lines.filter((line) => line.direction === direction)
      .sort((a, b) => `${a.date}T${a.time}`.localeCompare(`${b.date}T${b.time}`));
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Data", "Ora servizio", "Pratica ITS", "Cliente", "Telefono", "Pax", "Hotel / Destinazione",
       "Mezzo", "Orario mezzo", "Riferimento mezzo", "Orario pickup", "Punto di incontro"],
      ...rows.map((line) => [line.date, line.time, line.practice_number ?? "", line.customer_name,
        line.phone ?? "", line.pax, line.hotel_or_destination ?? "", line.transport_type ?? "",
        line.transport_time ?? "", line.transport_reference ?? "", line.pickup_time ?? "", line.meeting_point ?? ""]),
    ]);
    sheet["!cols"] = [13, 13, 19, 29, 19, 7, 30, 16, 14, 22, 15, 32].map((wch) => ({ wch }));
    sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1:L1" };
    XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  }
  const attachment = XLSX.write(workbook, { bookType: "xlsx", type: "base64" }) as string;

  const html = buildServiceListEmailHtml({
    agencyName:  body.agency_name,
    type:        emailType,
    targetDate:  body.target_date,
    lines,
    includeOperationalDetails: true,
    reviewToken: body.review_token,
  });
  const text = buildServiceListPlainText({
    agencyName: body.agency_name,
    type:       emailType,
    targetDate: body.target_date,
    lines,
    includeOperationalDetails: true,
  });

  const res = await resendFetch(apiKey, {
    from,
    to: [toEmail],
    subject: `${label} — ${body.agency_name} — ${body.target_date}`,
    html,
    text,
    attachments: [{ filename: `riepilogo-${body.target_date.replace(/[^0-9-]/g, "")}.xlsx`, content: attachment }],
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return NextResponse.json({ error: `Invio fallito (${res.status}): ${errBody.slice(0, 200)}` }, { status: 500 });
  }

  const resBody = await res.json().catch(() => null) as { id?: string } | null;
  return NextResponse.json({ ok: true, sent_to: toEmail, message_id: resBody?.id ?? null });
}
