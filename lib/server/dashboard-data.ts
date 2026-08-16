import type { SupabaseClient } from "@supabase/supabase-js";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { needsInboxReview } from "@/lib/inbox-review";
import { isInboxPdfReviewOpen, isInboxPdfTestNoise } from "@/lib/pdf/parser";
import { getServicePdfOperationalMeta } from "@/lib/service-pdf-metadata";
import type { InboundEmail, Service } from "@/lib/types";

// Sprint Performance 14B. Dashboard used to run useTenantOperationalData() in
// legacy mode (fetchAllServices + all assignments/hotels/memberships/inbound
// emails for the whole tenant history) purely to compute a handful of
// date-scoped KPIs. This module fetches only the bounded slices those KPIs
// actually need and reuses the SAME pure formulas the client used to run
// in-browser (buildOperationalInstances, getServicePdfOperationalMeta,
// isInboxPdfReviewOpen/isInboxPdfTestNoise, needsInboxReview) so results stay
// byte-identical — never reimplemented as fragile hand-rolled SQL/JS
// duplicates. The undelivered-reminder KPI is hardcoded to empty — see the
// BUGFIX comment below computeDashboardData for why.

const SERVICE_ID_CHUNK_SIZE = 300;

export type DashboardHotel = { id: string; name: string; zone: string };
export type DashboardAssignment = { service_id: string; driver_profile_id: string | null; vehicle_label: string };
export type DashboardReminderSampleService = Pick<
  Service,
  "id" | "date" | "arrival_date" | "time" | "arrival_time" | "outbound_time" | "departure_time" | "return_time" | "customer_name" | "reminder_status" | "sent_at"
>;

export type DashboardData = {
  windowServices: Service[];
  hotels: DashboardHotel[];
  assignments: DashboardAssignment[];
  todayPdfNeedsAttentionCount: number;
  inboxPdfNeedsReviewCount: number;
  inboxToReviewCount: number;
  undeliveredReminderCount: number;
  undeliveredReminderSample: DashboardReminderSampleService[];
};

interface ComputeDashboardDataArgs {
  admin: SupabaseClient;
  tenantId: string;
  /** dayOffset-aware "today" (YYYY-MM-DD), caller-computed. */
  today: string;
  /** Fixed "now + 48h" (YYYY-MM-DD), caller-computed, independent of dayOffset. */
  next48h: string;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Mirrors app/api/ops/tenant-data/route.ts's fetchScopedServices() range-mode
 * OR filter (Sprint Performance 13): a safe superset of every date field
 * buildOperationalInstances() can resolve an instance date from (date,
 * arrival_date, departure_date), so running that SAME function against this
 * bounded set reproduces byte-identical instances to running it against the
 * full tenant history. tenant-data/route.ts itself is intentionally not
 * touched or imported from — this is a parallel, independent implementation
 * of the same safe-superset idea for a different bounded window.
 */
async function fetchWindowServices(admin: SupabaseClient, tenantId: string, from: string, to: string): Promise<Service[]> {
  const orFilter = `and(date.gte.${from},date.lte.${to}),and(arrival_date.gte.${from},arrival_date.lte.${to}),and(departure_date.gte.${from},departure_date.lte.${to})`;
  const { data, error } = await admin
    .from("services")
    .select("*")
    .eq("tenant_id", tenantId)
    .or(orFilter)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as Service[];
}

async function fetchAssignmentsForServiceIds(admin: SupabaseClient, tenantId: string, serviceIds: string[]): Promise<DashboardAssignment[]> {
  if (serviceIds.length === 0) return [];
  const results = await Promise.all(
    chunk(serviceIds, SERVICE_ID_CHUNK_SIZE).map((ids) =>
      admin.from("assignments").select("service_id, driver_profile_id, vehicle_label").eq("tenant_id", tenantId).in("service_id", ids)
    )
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  return results.flatMap((result) => (result.data ?? []) as DashboardAssignment[]);
}

export async function computeDashboardData({ admin, tenantId, today, next48h }: ComputeDashboardDataArgs): Promise<DashboardData> {
  const rangeFrom = today <= next48h ? today : next48h;
  const rangeTo = today <= next48h ? next48h : today;

  const windowServices = await fetchWindowServices(admin, tenantId, rangeFrom, rangeTo);
  const serviceIds = windowServices.map((service) => service.id);

  const [hotelsResult, assignments, inboundResult] = await Promise.all([
    admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId),
    fetchAssignmentsForServiceIds(admin, tenantId, serviceIds),
    // Minimal projection: needsInboxReview/isInboxPdfReviewOpen/
    // isInboxPdfTestNoise only ever read parsed_json (+ subject for the
    // noise check) — never raw_text/body_html/body_text/raw_json, which is
    // most of an inbound_emails row's actual size.
    admin.from("inbound_emails").select("id, subject, parsed_json").eq("tenant_id", tenantId)
  ]);

  if (hotelsResult.error) throw hotelsResult.error;
  if (inboundResult.error) throw inboundResult.error;

  const inboundEmails = (inboundResult.data ?? []) as unknown as InboundEmail[];

  const todayInstances = buildOperationalInstances(windowServices).filter((instance) => instance.date === today);
  const todayServiceIds = new Set(todayInstances.map((instance) => instance.serviceId));
  const todayServices = windowServices.filter((service) => todayServiceIds.has(service.id));
  const todayPdfNeedsAttentionCount = todayServices.filter(
    (service) => getServicePdfOperationalMeta(service, inboundEmails).reviewRecommended
  ).length;

  const inboxPdfNeedsReviewCount = inboundEmails.filter((email) => {
    const parsedJson = (email.parsed_json ?? null) as Record<string, unknown> | null;
    return !isInboxPdfTestNoise({ subject: email.subject, parsedJson }) && isInboxPdfReviewOpen(parsedJson);
  }).length;
  const inboxToReviewCount = inboundEmails.filter((email) => needsInboxReview(email.parsed_json)).length;

  // BUGFIX (post-14B): supabase/migrations/0001_schema.sql declares
  // services.reminder_status/sent_at, but this project's actual services
  // table does not have them (verified directly against Supabase: PostgREST
  // 42703 "column services.reminder_status does not exist" — the migration
  // was apparently never applied here). The legacy pre-14B client code read
  // these same fields off a `select("*")` fetch, which silently returns
  // `undefined` for missing columns instead of erroring, so
  // service.reminder_status was always `undefined` there too and this KPI
  // was always empty in practice. An explicit-column select (unlike `*`)
  // makes PostgREST reject unknown columns outright, which is what broke
  // GET /api/ops/dashboard-data with a 500. Hardcoding the same
  // (already-real) empty result here removes the crash without querying
  // columns that don't exist and without changing the KPI's actual value.
  // Once those columns are truly migrated in, reintroduce the query and
  // reuse lib/service-reminder.ts's isUndeliveredReminder() as before.
  const undeliveredReminderCount = 0;
  const undeliveredReminderSample: DashboardReminderSampleService[] = [];

  return {
    windowServices,
    hotels: (hotelsResult.data ?? []) as DashboardHotel[],
    assignments,
    todayPdfNeedsAttentionCount,
    inboxPdfNeedsReviewCount,
    inboxToReviewCount,
    undeliveredReminderCount,
    undeliveredReminderSample
  };
}
