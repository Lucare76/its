import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildServicesQuery, serviceQueryFiltersSchema } from "@/lib/server/services-filter-builder";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { computeServicesListAggregates, hasExtraServicesFilters, servicesListExtraFiltersSchema } from "@/lib/server/services-list-aggregates";

export const runtime = "nodejs";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  page_size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().default(DEFAULT_PAGE_SIZE)
});

// GET is not used for listing (use POST with filters), but the auth check
// must still return 401 for unauthenticated requests rather than 405.
export async function GET(request: NextRequest) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "agency", "supervisor"],
    auditPrefix: "services_list"
  });
  if (auth instanceof NextResponse) return auth;
  return NextResponse.json({ error: "Use POST to list services." }, { status: 405 });
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizeServiceRoleRequest(request, {
      roles: ["admin", "operator", "agency", "supervisor"],
      membershipFields: ["agency_id"],
      auditPrefix: "services_list"
    });
    if (auth instanceof NextResponse) return auth;

    const payload = await request.json();
    const parsed = serviceQueryFiltersSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Filtri non validi." }, { status: 400 });
    }
    const paginationParsed = paginationSchema.safeParse(payload);
    if (!paginationParsed.success) {
      return NextResponse.json({ error: paginationParsed.error.issues[0]?.message ?? "Paginazione non valida." }, { status: 400 });
    }
    const extraFiltersParsed = servicesListExtraFiltersSchema.safeParse(payload);
    if (!extraFiltersParsed.success) {
      return NextResponse.json({ error: extraFiltersParsed.error.issues[0]?.message ?? "Filtri non validi." }, { status: 400 });
    }
    if (parsed.data.tenant_id !== auth.membership.tenant_id) {
      return NextResponse.json({ error: "Tenant non autorizzato." }, { status: 403 });
    }

    if (auth.membership.role === "agency" && !auth.membership.agency_id) {
      return NextResponse.json({ error: "Account agenzia non configurato." }, { status: 403 });
    }

    const filters = {
      ...parsed.data,
      agency_id: auth.membership.role === "agency" ? auth.membership.agency_id : parsed.data.agency_id
    };
    const { page, page_size: pageSize } = paginationParsed.data;
    const tenantId = auth.membership.tenant_id;
    const extraFilters = extraFiltersParsed.data;

    // Sprint Performance 14A fix: stats, the source/reviewed/agency/quality
    // filters, and the vessel/agency dropdown options must all reflect the
    // whole filtered dataset, not just the current page. This runs a
    // lightweight (minimal-column) pass over every matching service before
    // the page itself is fetched — see lib/server/services-list-aggregates.ts.
    let aggregates;
    try {
      aggregates = await computeServicesListAggregates({ admin: auth.admin, tenantId, baseFilters: filters, extraFilters });
    } catch (aggregateError) {
      const details =
        aggregateError instanceof Error
          ? { message: aggregateError.message, name: aggregateError.name }
          : aggregateError;
      console.error("Services list aggregates error", details);
      if (hasExtraServicesFilters(extraFilters)) {
        return NextResponse.json({ error: "Errore calcolo statistiche servizi." }, { status: 500 });
      }
      aggregates = {
        matchedIds: [] as string[],
        stats: {
          totale: 0,
          needsAttention: 0,
          lineeBus: 0,
          altriServizi: 0,
          daAssegnareInternamente: 0,
          promemoriaDaVerificare: 0
        },
        knownVessels: [] as string[],
        knownAgencies: [] as string[]
      };
    }

    let { query } = await buildServicesQuery({
      admin: auth.admin,
      filters,
      select: "*"
    });
    if (hasExtraServicesFilters(extraFilters)) {
      query = query.in("id", aggregates.matchedIds.length > 0 ? aggregates.matchedIds : [NIL_UUID]);
    }

    const from = (page - 1) * pageSize;
    // Fetch one extra row past the page boundary so `has_more` can be derived
    // without a separate (potentially heavy) COUNT query.
    const { data: rawServices, error: servicesError } = await query
      .order("date", { ascending: true })
      .order("time", { ascending: true })
      .range(from, from + pageSize);
    if (servicesError) {
      console.error("Services list query error", servicesError.message);
      return NextResponse.json({ error: "Errore caricamento servizi." }, { status: 500 });
    }

    const rows = rawServices ?? [];
    const hasMore = rows.length > pageSize;
    const services = hasMore ? rows.slice(0, pageSize) : rows;
    const serviceIds = services.map((service: Record<string, unknown>) => service.id as string);
    const inboundEmailIds = Array.from(
      new Set(
        services
          .map((service: Record<string, unknown>) => service.inbound_email_id)
          .filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      )
    );

    const [assignmentsResult, statusEventsResult, inboundResult] = await Promise.all([
      serviceIds.length > 0
        ? auth.admin.from("assignments").select("*").eq("tenant_id", tenantId).in("service_id", serviceIds)
        : Promise.resolve({ data: [], error: null }),
      serviceIds.length > 0
        ? auth.admin.from("status_events").select("*").eq("tenant_id", tenantId).in("service_id", serviceIds)
        : Promise.resolve({ data: [], error: null }),
      inboundEmailIds.length > 0
        ? auth.admin.from("inbound_emails").select("*").eq("tenant_id", tenantId).in("id", inboundEmailIds)
        : Promise.resolve({ data: [], error: null })
    ]);

    const relationsError = assignmentsResult.error ?? statusEventsResult.error ?? inboundResult.error;
    if (relationsError) {
      console.error("Services list relations error", relationsError.message);
      return NextResponse.json({ error: "Errore caricamento servizi." }, { status: 500 });
    }

    return NextResponse.json({
      services,
      assignments: assignmentsResult.data ?? [],
      status_events: statusEventsResult.data ?? [],
      inbound_emails: inboundResult.data ?? [],
      page,
      page_size: pageSize,
      has_more: hasMore,
      stats: aggregates.stats,
      known_vessels: aggregates.knownVessels,
      known_agencies: aggregates.knownAgencies
    });
  } catch (error) {
    console.error("Services list endpoint unexpected error", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
