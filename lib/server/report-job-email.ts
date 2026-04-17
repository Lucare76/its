import type { SupabaseClient } from "@supabase/supabase-js";
import { buildServiceListEmailHtml, buildServiceListPlainText, type ServiceListEmailType } from "@/lib/server/service-list-email";
import { getVerifiedFromEmail, resendFetch } from "@/lib/server/send-email";

type SummaryLine = {
  date: string;
  time: string;
  customer_name: string;
  pax: number;
  hotel_or_destination: string | null;
  direction: "arrival" | "departure";
  booking_kind?: string | null;
  service_type_code?: string | null;
};

export type ReportJobType = "arrivals_48h" | "departures_48h" | "bus_monday" | "statement_agency";

type AgencyRow = {
  name: string;
  billing_name: string | null;
  booking_email: string | null;
  contact_email: string | null;
  booking_emails: unknown;
  contact_emails: unknown;
};

export type ReportJobEmailResult =
  | { status: "sent"; recipient: string; providerMessageId: string | null; error: null }
  | { status: "failed"; recipient: string | null; providerMessageId: null; error: string };

function normalizeName(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeEmail(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function uniqueEmails(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = normalizeEmail(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function arrayEmails(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeEmail(String(item))).filter((item): item is string => Boolean(item));
}

async function resolveAgencyRecipient(admin: SupabaseClient, tenantId: string, ownerName: string | null) {
  if (!ownerName) {
    return { recipient: null, matchedAgency: null };
  }

  const normalizedOwner = normalizeName(ownerName);
  if (!normalizedOwner) {
    return { recipient: null, matchedAgency: null };
  }

  const { data, error } = await admin
    .from("agencies")
    .select("name, billing_name, booking_email, contact_email, booking_emails, contact_emails")
    .eq("tenant_id", tenantId)
    .limit(500);

  if (error) {
    return { recipient: null, matchedAgency: null };
  }

  const agencies = (data ?? []) as AgencyRow[];
  const exact =
    agencies.find((agency) => normalizeName(agency.name) === normalizedOwner) ??
    agencies.find((agency) => normalizeName(agency.billing_name) === normalizedOwner) ??
    null;

  const partial =
    exact ??
    agencies.find((agency) => {
      const name = normalizeName(agency.name);
      const billing = normalizeName(agency.billing_name);
      return name.includes(normalizedOwner) || normalizedOwner.includes(name) || billing.includes(normalizedOwner) || normalizedOwner.includes(billing);
    }) ??
    null;

  if (!partial) {
    return { recipient: null, matchedAgency: null };
  }

  const recipients = uniqueEmails([
    partial.booking_email,
    partial.contact_email,
    ...arrayEmails(partial.booking_emails),
    ...arrayEmails(partial.contact_emails)
  ]);

  return {
    recipient: recipients[0] ?? null,
    matchedAgency: partial.name
  };
}

function jobTypeToEmailType(jobType: ReportJobType): ServiceListEmailType {
  if (jobType === "arrivals_48h")   return "arrivals_48h";
  if (jobType === "departures_48h") return "departures_48h";
  if (jobType === "bus_monday")     return "bus_monday";
  return "arrivals_48h"; // statement_agency fallback
}

function buildSubject(jobType: ReportJobType, ownerName: string | null, targetDate: string) {
  const owner = ownerName?.trim() || "Agenzia";
  const labels: Record<ReportJobType, string> = {
    arrivals_48h:    "Riepilogo arrivi +48h",
    departures_48h:  "Riepilogo partenze +48h",
    bus_monday:      "Riepilogo linea bus domenica",
    statement_agency:"Estratto conto operativo",
  };
  return `${labels[jobType]} - ${owner} - ${targetDate}`;
}

export async function sendOperationalReportEmail(params: {
  admin: SupabaseClient;
  tenantId: string;
  jobType: ReportJobType;
  targetDate: string;
  ownerName: string | null;
  lines: SummaryLine[];
  /** Se true, crea una sessione di revisione e inserisce i bottoni Approva/Modifica nell'email */
  enableReview?: boolean;
}) : Promise<ReportJobEmailResult> {
  const { recipient, matchedAgency } = await resolveAgencyRecipient(params.admin, params.tenantId, params.ownerName);
  if (!recipient) {
    return {
      status: "failed",
      recipient: null,
      providerMessageId: null,
      error: `Destinatario email non trovato per ${params.ownerName ?? "owner sconosciuto"}.`
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = getVerifiedFromEmail();
  if (!apiKey || !from) {
    return {
      status: "failed",
      recipient,
      providerMessageId: null,
      error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)."
    };
  }

  // Crea sessione di revisione se richiesto
  let reviewToken: string | undefined;
  const emailType = jobTypeToEmailType(params.jobType);
  const isReviewableType = ["arrivals_48h", "departures_48h", "bus_monday"].includes(params.jobType);
  if (params.enableReview && isReviewableType && matchedAgency) {
    const services = params.lines.map((l) => ({
      date: l.date,
      time: l.time,
      customer_name: l.customer_name,
      pax: l.pax,
      hotel_or_destination: l.hotel_or_destination,
      direction: l.direction,
    }));
    const { data: sess } = await params.admin
      .from("agency_review_sessions")
      .insert({
        tenant_id:   params.tenantId,
        agency_name: matchedAgency,
        report_type: params.jobType,
        target_date: params.targetDate,
        services,
      })
      .select("token")
      .single();
    reviewToken = sess?.token ?? undefined;
  }

  const agencyName = matchedAgency ?? params.ownerName ?? "Agenzia";

  const response = await resendFetch(apiKey, {
    from,
    to: [recipient],
    subject: buildSubject(params.jobType, matchedAgency ?? params.ownerName, params.targetDate),
    html: buildServiceListEmailHtml({ agencyName, type: emailType, targetDate: params.targetDate, lines: params.lines, reviewToken }),
    text: buildServiceListPlainText({ agencyName, type: emailType, targetDate: params.targetDate, lines: params.lines })
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    return {
      status: "failed",
      recipient,
      providerMessageId: null,
      error: `Invio report fallito (${response.status}). ${bodyText.slice(0, 240)}`
    };
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  return {
    status: "sent",
    recipient,
    providerMessageId: body?.id ?? null,
    error: null
  };
}
