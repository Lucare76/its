import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getServiceOperationalSource, getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import { isUndeliveredReminder } from "@/lib/service-reminder";
import { buildServicesQuery, type ServiceQueryFilters } from "@/lib/server/services-filter-builder";
import type { InboundEmail, Service } from "@/lib/types";

// Sprint Performance 14A regression fix. The 4 extra filters below (source,
// reviewed, agency, quality) depend on lib/service-pdf-metadata.ts, which
// derives its answer from notes-marker fallbacks and nested inbound_emails
// JSON — not from plain columns. Re-implementing that logic as SQL would
// fork the semantics from the client. Instead we fetch a MINIMAL column
// projection (never `select("*")`) for the whole filtered dataset and run
// the exact same pure functions used on the client, once per request.
export const servicesListExtraFiltersSchema = z.object({
  source: z.enum(["all", "pdf", "agency", "manual"]).optional().default("all"),
  reviewed: z.enum(["all", "yes", "no"]).optional().default("all"),
  agency: z.string().max(200).optional().default("all"),
  quality: z.enum(["all", "low"]).optional().default("all")
});

export type ServicesListExtraFilters = z.infer<typeof servicesListExtraFiltersSchema>;

const AGGREGATE_SELECT =
  "id, vessel, notes, excursion_details, agency_id, inbound_email_id, service_type_code, booking_service_kind, reminder_status, sent_at";
const AGGREGATE_SELECT_COMPAT =
  "id, vessel, notes, excursion_details, agency_id, inbound_email_id, service_type_code, booking_service_kind";

type AggregateRow = {
  id: string;
  vessel: string | null;
  notes: string | null;
  excursion_details: unknown;
  agency_id: string | null;
  inbound_email_id: string | null;
  service_type_code: string | null;
  booking_service_kind: string | null;
  reminder_status: string | null;
  sent_at: string | null;
};

function isServicesReminderSchemaDrift(error: unknown) {
  const maybeError = error as { code?: string; message?: string } | null;
  const message = String(maybeError?.message ?? "");
  return (
    maybeError?.code === "42703" ||
    message.includes("reminder_status") ||
    message.includes("sent_at") ||
    message === "Bad Request" ||
    message.includes("Could not find") ||
    message.includes("column")
  );
}

function normalizeAggregateRows(rows: unknown[], reminderStatsAvailable: boolean): AggregateRow[] {
  return rows.map((row) => {
    const item = row as Partial<AggregateRow>;
    return {
      ...item,
      reminder_status: reminderStatsAvailable ? item.reminder_status ?? null : null,
      sent_at: reminderStatsAvailable ? item.sent_at ?? null : null
    } as AggregateRow;
  });
}

export type ServicesListStats = {
  totale: number;
  needsAttention: number;
  lineeBus: number;
  altriServizi: number;
  daAssegnareInternamente: number;
  promemoriaDaVerificare: number;
};

export type ServicesListAggregates = {
  matchedIds: string[];
  stats: ServicesListStats;
  knownVessels: string[];
  knownAgencies: string[];
};

interface ComputeArgs {
  admin: SupabaseClient;
  tenantId: string;
  baseFilters: ServiceQueryFilters;
  extraFilters: ServicesListExtraFilters;
}

export async function computeServicesListAggregates({
  admin,
  tenantId,
  baseFilters,
  extraFilters
}: ComputeArgs): Promise<ServicesListAggregates> {
  const { query } = await buildServicesQuery({ admin, filters: baseFilters, select: AGGREGATE_SELECT });
  let reminderStatsAvailable = true;
  let { data, error } = await query;
  if (error) {
    if (!isServicesReminderSchemaDrift(error)) throw error;

    // Some environments have not applied the reminder tracking columns yet.
    // The services list must still load; only the optional "undelivered
    // reminders" statistic is unavailable in that case.
    const fallback = await buildServicesQuery({ admin, filters: baseFilters, select: AGGREGATE_SELECT_COMPAT });
    const fallbackResult = await fallback.query;
    if (fallbackResult.error) throw fallbackResult.error;
    data = fallbackResult.data;
    error = null;
    reminderStatsAvailable = false;
  }
  const rows = normalizeAggregateRows(data ?? [], reminderStatsAvailable);

  const inboundEmailIds = Array.from(
    new Set(rows.map((row) => row.inbound_email_id).filter((id): id is string => typeof id === "string" && id.length > 0))
  );
  const { data: inboundRows, error: inboundError } =
    inboundEmailIds.length > 0
      ? await admin.from("inbound_emails").select("id, parsed_json").eq("tenant_id", tenantId).in("id", inboundEmailIds)
      : { data: [] as unknown[], error: null };
  if (inboundError) throw inboundError;
  const inboundEmails = (inboundRows ?? []) as InboundEmail[];

  const knownVessels = new Set<string>();
  const knownAgencies = new Set<string>();
  const metaById = new Map<string, ReturnType<typeof getServicePdfOperationalMeta>>();
  const matched: AggregateRow[] = [];

  for (const row of rows) {
    if (row.vessel) knownVessels.add(row.vessel);

    // AGGREGATE_SELECT only carries the fields these two functions read
    // (notes, excursion_details, inbound_email_id, agency_id); the cast
    // keeps us reusing the client's exact semantics without duplicating it.
    const serviceForMeta = row as unknown as Service;
    const pdfMeta = getServicePdfOperationalMeta(serviceForMeta, inboundEmails);
    const source = getServiceOperationalSource(serviceForMeta, inboundEmails);
    metaById.set(row.id, pdfMeta);
    if (pdfMeta.agencyName) knownAgencies.add(pdfMeta.agencyName);

    const bySource = extraFilters.source === "all" || source === extraFilters.source;
    const byReviewed =
      extraFilters.reviewed === "all" ||
      (extraFilters.reviewed === "yes" ? Boolean(pdfMeta.manualReview) : Boolean(pdfMeta.isPdf && !pdfMeta.manualReview));
    const byAgency = extraFilters.agency === "all" || pdfMeta.agencyName === extraFilters.agency;
    const byQuality = extraFilters.quality === "all" || (pdfMeta.isPdf && pdfMeta.parsingQuality === "low");
    if (bySource && byReviewed && byAgency && byQuality) matched.push(row);
  }

  const matchedIds = matched.map((row) => row.id);

  const { data: assignmentRows, error: assignmentsError } =
    matchedIds.length > 0
      ? await admin.from("assignments").select("service_id, driver_user_id").eq("tenant_id", tenantId).in("service_id", matchedIds)
      : { data: [] as unknown[], error: null };
  if (assignmentsError) throw assignmentsError;
  const driverByServiceId = new Map(
    ((assignmentRows ?? []) as Array<{ service_id: string; driver_user_id: string | null }>).map((row) => [
      row.service_id,
      row.driver_user_id
    ])
  );

  let needsAttention = 0;
  let lineeBus = 0;
  let daAssegnareInternamente = 0;
  let promemoriaDaVerificare = 0;
  for (const row of matched) {
    const pdfMeta = metaById.get(row.id);
    if (pdfMeta?.reviewRecommended) needsAttention++;
    if (row.service_type_code === "bus_line" || row.booking_service_kind === "bus_city_hotel") lineeBus++;
    if (!driverByServiceId.get(row.id)) daAssegnareInternamente++;
    if (reminderStatsAvailable && isUndeliveredReminder(row)) promemoriaDaVerificare++;
  }

  return {
    matchedIds,
    stats: {
      totale: matchedIds.length,
      needsAttention,
      lineeBus,
      altriServizi: matchedIds.length - lineeBus,
      daAssegnareInternamente,
      promemoriaDaVerificare
    },
    knownVessels: Array.from(knownVessels).sort((a, b) => a.localeCompare(b, "it")),
    knownAgencies: Array.from(knownAgencies).sort((a, b) => a.localeCompare(b, "it"))
  };
}

export function hasExtraServicesFilters(extraFilters: ServicesListExtraFilters): boolean {
  return extraFilters.source !== "all" || extraFilters.reviewed !== "all" || extraFilters.agency !== "all" || extraFilters.quality !== "all";
}
