import type { SupabaseClient } from "@supabase/supabase-js";

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

function labelForJobType(jobType: ReportJobType) {
  if (jobType === "arrivals_48h") return "Riepilogo arrivi +48h";
  if (jobType === "departures_48h") return "Riepilogo partenze +48h";
  if (jobType === "bus_monday") return "Riepilogo linea bus domenica";
  return "Estratto conto operativo";
}

function buildSubject(jobType: ReportJobType, ownerName: string | null, targetDate: string) {
  const owner = ownerName?.trim() || "Agenzia";
  const label = labelForJobType(jobType);
  return `${label} - ${owner} - ${targetDate}`;
}

function buildPlainText(jobType: ReportJobType, ownerName: string | null, targetDate: string, lines: SummaryLine[]) {
  const owner = ownerName?.trim() || "Agenzia";
  const totalPax = lines.reduce((sum, line) => sum + line.pax, 0);
  const intro =
    jobType === "bus_monday"
      ? `In allegato logico trovi il riepilogo linea bus della domenica ${targetDate}, con arrivi e partenze della tua agenzia.`
      : `Ti inviamo il riepilogo operativo ${labelForJobType(jobType).toLowerCase()} con target ${targetDate}.`;

  const body = lines
    .sort((left, right) => `${left.date}T${left.time}`.localeCompare(`${right.date}T${right.time}`))
    .map(
      (line) =>
        `${line.date} ${line.time} | ${line.direction === "arrival" ? "Arrivo" : "Partenza"} | ${line.customer_name} | ${line.hotel_or_destination ?? "N/D"} | ${line.pax} pax`
    );

  return [
    `Ciao ${owner},`,
    "",
    intro,
    "",
    `Servizi nel lotto: ${lines.length}`,
    `Pax totali: ${totalPax}`,
    "",
    ...body,
    "",
    "Messaggio generato automaticamente da Ischia Transfer."
  ].join("\n");
}

function buildHtml(jobType: ReportJobType, ownerName: string | null, targetDate: string, lines: SummaryLine[]) {
  const owner = ownerName?.trim() || "Agenzia";
  const totalPax = lines.reduce((sum, line) => sum + line.pax, 0);
  const intro =
    jobType === "bus_monday"
      ? `Ti inviamo il riepilogo linea bus della domenica <strong>${targetDate}</strong>, con arrivi e partenze della tua agenzia.`
      : `Ti inviamo il riepilogo operativo <strong>${labelForJobType(jobType).toLowerCase()}</strong> con target <strong>${targetDate}</strong>.`;

  const rows = lines
    .sort((left, right) => `${left.date}T${left.time}`.localeCompare(`${right.date}T${right.time}`))
    .map(
      (line) =>
        `<tr><td style="padding:6px 8px;border:1px solid #dbe3ea;">${line.date}</td><td style="padding:6px 8px;border:1px solid #dbe3ea;">${line.time}</td><td style="padding:6px 8px;border:1px solid #dbe3ea;">${line.direction === "arrival" ? "Arrivo" : "Partenza"}</td><td style="padding:6px 8px;border:1px solid #dbe3ea;">${line.customer_name}</td><td style="padding:6px 8px;border:1px solid #dbe3ea;">${line.hotel_or_destination ?? "N/D"}</td><td style="padding:6px 8px;border:1px solid #dbe3ea;text-align:right;">${line.pax}</td></tr>`
    )
    .join("");

  return [
    `<p>Ciao ${owner},</p>`,
    `<p>${intro}</p>`,
    `<p><strong>Servizi nel lotto:</strong> ${lines.length}<br /><strong>Pax totali:</strong> ${totalPax}</p>`,
    `<table style="border-collapse:collapse;width:100%;font-size:14px;">`,
    `<thead><tr><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:left;">Data</th><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:left;">Ora</th><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:left;">Direzione</th><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:left;">Cliente</th><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:left;">Hotel / Destinazione</th><th style="padding:6px 8px;border:1px solid #dbe3ea;text-align:right;">Pax</th></tr></thead>`,
    `<tbody>${rows}</tbody>`,
    `</table>`,
    `<p style="margin-top:16px;">Messaggio generato automaticamente da Ischia Transfer.</p>`
  ].join("");
}

export async function sendOperationalReportEmail(params: {
  admin: SupabaseClient;
  tenantId: string;
  jobType: ReportJobType;
  targetDate: string;
  ownerName: string | null;
  lines: SummaryLine[];
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
  const from = process.env.AGENCY_BOOKING_FROM_EMAIL;
  if (!apiKey || !from) {
    return {
      status: "failed",
      recipient,
      providerMessageId: null,
      error: "Provider email non configurato (RESEND_API_KEY / AGENCY_BOOKING_FROM_EMAIL)."
    };
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [recipient],
      subject: buildSubject(params.jobType, matchedAgency ?? params.ownerName, params.targetDate),
      html: buildHtml(params.jobType, matchedAgency ?? params.ownerName, params.targetDate, params.lines),
      text: buildPlainText(params.jobType, matchedAgency ?? params.ownerName, params.targetDate, params.lines)
    })
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
