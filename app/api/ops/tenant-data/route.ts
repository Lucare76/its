import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchAllServices } from "@/lib/server/fetch-all-services";

const DATASET_VALUES = [
  "services",
  "assignments",
  "statusEvents",
  "hotels",
  "memberships",
  "busLotConfigs",
  "inboundEmails"
] as const;
type Dataset = (typeof DATASET_VALUES)[number];

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida (atteso YYYY-MM-DD)");

const scopeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("date"), date: isoDateSchema }),
  z.object({ mode: z.literal("range"), from: isoDateSchema, to: isoDateSchema }),
  z.object({ mode: z.literal("ids"), ids: z.array(z.string().uuid()).min(1).max(500) })
]);
type ServiceScope = z.infer<typeof scopeSchema>;

const SERVICE_QUERY_PAGE = 1000;
const ID_CHUNK_SIZE = 300;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Fetches only the services relevant to `scope`, replacing fetchAllServices()
 * for scoped requests (Sprint Performance 13 — FASE 9). For date/range scopes
 * this filters on `date`, `arrival_date` and `departure_date` together: that
 * mirrors buildOperationalInstances()'s date resolution (arrival_date, falling
 * back to `date` for direction=arrival services; same for departure) as a safe
 * SUPERSET — the client's existing buildOperationalInstances() then re-derives
 * the exact per-instance date/direction from the full row, so this filter only
 * has to avoid excluding anything the client would keep, never has to be exact.
 */
async function fetchScopedServices(admin: SupabaseClient, tenantId: string, scope: ServiceScope) {
  if (scope.mode === "ids") {
    return admin.from("services").select("*").eq("tenant_id", tenantId).in("id", scope.ids);
  }

  const orFilter =
    scope.mode === "date"
      ? `date.eq.${scope.date},arrival_date.eq.${scope.date},departure_date.eq.${scope.date}`
      : `and(date.gte.${scope.from},date.lte.${scope.to}),and(arrival_date.gte.${scope.from},arrival_date.lte.${scope.to}),and(departure_date.gte.${scope.from},departure_date.lte.${scope.to})`;

  const all: Record<string, unknown>[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .or(orFilter)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + SERVICE_QUERY_PAGE - 1);
    if (error) return { data: null, error };
    if (data) all.push(...data);
    if (!data || data.length < SERVICE_QUERY_PAGE) break;
    from += SERVICE_QUERY_PAGE;
  }
  return { data: all, error: null };
}

/** Scoped assignments/status_events: service_id IN (chunked) returned service ids, tenant-filtered. */
async function fetchByServiceIdChunks(admin: SupabaseClient, table: "assignments" | "status_events", tenantId: string, serviceIds: string[]) {
  const results = await Promise.all(
    chunk(serviceIds, ID_CHUNK_SIZE).map((ids) => admin.from(table).select("*").eq("tenant_id", tenantId).in("service_id", ids))
  );
  const failed = results.find((result) => result.error);
  if (failed?.error) return { data: null, error: failed.error };
  return { data: results.flatMap((result) => result.data ?? []), error: null };
}

export async function GET(request: NextRequest) {
  const startedAt = Date.now();
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const params = request.nextUrl.searchParams;
    const rawScopeMode = params.get("service_scope");

    // ---- LEGACY PATH: no service_scope param (or explicitly "legacy") ----
    // Byte-for-byte identical to the pre-Sprint-13 behavior: every dataset,
    // fetchAllServices() for the full tenant history. This is what keeps every
    // non-migrated consumer working unchanged.
    if (!rawScopeMode || rawScopeMode === "legacy") {
      const includeInboundEmails = params.get("include_inbound_emails") === "true";

      const [servicesResult, assignmentsResult, busLotConfigsResult, statusEventsResult, hotelsResult, membershipsResult, inboundResult] =
        await Promise.all([
          fetchAllServices(auth.admin, tenantId),
          auth.admin.from("assignments").select("*").eq("tenant_id", tenantId),
          (async () => {
            const result = await auth.admin.from("bus_lot_configs").select("*").eq("tenant_id", tenantId);
            return result.error ? { data: [], error: null } : result;
          })(),
          auth.admin.from("status_events").select("*").eq("tenant_id", tenantId),
          auth.admin.from("hotels").select("*").eq("tenant_id", tenantId),
          auth.admin.from("memberships").select("user_id, tenant_id, role, full_name").eq("tenant_id", tenantId),
          includeInboundEmails
            ? auth.admin.from("inbound_emails").select("*").eq("tenant_id", tenantId)
            : Promise.resolve({ data: [], error: null })
        ]);

      const error =
        servicesResult.error ??
        assignmentsResult.error ??
        statusEventsResult.error ??
        hotelsResult.error ??
        membershipsResult.error ??
        inboundResult.error;

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }

      return NextResponse.json({
        ok: true,
        tenant_id: tenantId,
        user_id: auth.user.id,
        role: auth.membership.role,
        services: servicesResult.data ?? [],
        assignments: assignmentsResult.data ?? [],
        bus_lot_configs: busLotConfigsResult.data ?? [],
        status_events: statusEventsResult.data ?? [],
        hotels: hotelsResult.data ?? [],
        memberships: membershipsResult.data ?? [],
        inbound_emails: inboundResult.data ?? []
      });
    }

    // ---- SCOPED PATH ----
    const datasetsParam = params.get("datasets") ?? "";
    const datasetsParseResult = z
      .array(z.enum(DATASET_VALUES))
      .safeParse(datasetsParam.split(",").map((value) => value.trim()).filter(Boolean));
    if (!datasetsParseResult.success) {
      return NextResponse.json({ ok: false, error: "Parametro 'datasets' non valido" }, { status: 400 });
    }
    const datasets = new Set<Dataset>(datasetsParseResult.data);

    let scopeInput: unknown;
    if (rawScopeMode === "date") {
      scopeInput = { mode: "date", date: params.get("date") ?? "" };
    } else if (rawScopeMode === "range") {
      scopeInput = { mode: "range", from: params.get("from") ?? "", to: params.get("to") ?? "" };
    } else if (rawScopeMode === "ids") {
      scopeInput = {
        mode: "ids",
        ids: (params.get("ids") ?? "").split(",").map((value) => value.trim()).filter(Boolean)
      };
    } else {
      return NextResponse.json({ ok: false, error: "Parametro 'service_scope' non valido" }, { status: 400 });
    }
    const scopeParsed = scopeSchema.safeParse(scopeInput);
    if (!scopeParsed.success) {
      return NextResponse.json(
        { ok: false, error: scopeParsed.error.issues[0]?.message ?? "Parametro 'service_scope' non valido" },
        { status: 400 }
      );
    }
    const scope = scopeParsed.data;
    if (scope.mode === "range" && scope.from > scope.to) {
      return NextResponse.json({ ok: false, error: "'from' deve precedere o coincidere con 'to'" }, { status: 400 });
    }

    let services: Record<string, unknown>[] = [];
    if (datasets.has("services")) {
      const result = await fetchScopedServices(auth.admin, tenantId, scope);
      if (result.error) {
        return NextResponse.json({ ok: false, error: result.error.message }, { status: 500 });
      }
      services = (result.data ?? []) as Record<string, unknown>[];
    }
    // Sprint Performance 13 — FASE 10/11: assignments/status_events are scoped
    // to the service ids the (scoped) services query actually returned, never
    // to the whole tenant. Zero service ids -> [] without querying at all.
    const serviceIds = services.map((service) => service.id as string);

    const [assignmentsResult, statusEventsResult, hotelsResult, membershipsResult, busLotConfigsResult, inboundResult] = await Promise.all([
      datasets.has("assignments") && serviceIds.length > 0
        ? fetchByServiceIdChunks(auth.admin, "assignments", tenantId, serviceIds)
        : Promise.resolve({ data: [], error: null }),
      datasets.has("statusEvents") && serviceIds.length > 0
        ? fetchByServiceIdChunks(auth.admin, "status_events", tenantId, serviceIds)
        : Promise.resolve({ data: [], error: null }),
      datasets.has("hotels") ? auth.admin.from("hotels").select("*").eq("tenant_id", tenantId) : Promise.resolve({ data: [], error: null }),
      datasets.has("memberships")
        ? auth.admin.from("memberships").select("user_id, tenant_id, role, full_name").eq("tenant_id", tenantId)
        : Promise.resolve({ data: [], error: null }),
      datasets.has("busLotConfigs")
        ? (async () => {
            const result = await auth.admin.from("bus_lot_configs").select("*").eq("tenant_id", tenantId);
            return result.error ? { data: [], error: null } : result;
          })()
        : Promise.resolve({ data: [], error: null }),
      datasets.has("inboundEmails")
        ? auth.admin.from("inbound_emails").select("*").eq("tenant_id", tenantId)
        : Promise.resolve({ data: [], error: null })
    ]);

    const error =
      assignmentsResult.error ?? statusEventsResult.error ?? hotelsResult.error ?? membershipsResult.error ?? inboundResult.error;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    if (process.env.NODE_ENV !== "production") {
      // Dev-only structured timing — no PII, no tokens, no row contents.
      console.debug("[tenant-data:scoped]", {
        mode: scope.mode,
        datasets: [...datasets],
        services_count: services.length,
        assignments_count: assignmentsResult.data?.length ?? 0,
        status_events_count: statusEventsResult.data?.length ?? 0,
        duration_ms: Date.now() - startedAt
      });
    }

    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      user_id: auth.user.id,
      role: auth.membership.role,
      services,
      assignments: assignmentsResult.data ?? [],
      bus_lot_configs: busLotConfigsResult.data ?? [],
      status_events: statusEventsResult.data ?? [],
      hotels: hotelsResult.data ?? [],
      memberships: membershipsResult.data ?? [],
      inbound_emails: inboundResult.data ?? []
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
