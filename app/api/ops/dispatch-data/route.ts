import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { loadOperationalVehicles } from "@/lib/server/vehicle-catalog";
import type { Service } from "@/lib/types";

export const runtime = "nodejs";

const SERVICES_PAGE = 1000;
// Storico oltre questa finestra viene incluso solo se il servizio non e' in uno
// stato terminale (dispatch/inbox non mostrano mai servizi completato/cancelled
// vecchi, ma devono sempre vedere i servizi ancora attivi, a prescindere dalla data).
const SERVICES_LOOKBACK_DAYS = 30;
const TERMINAL_SERVICE_STATUSES = ["completato", "cancelled"];
const ASSIGNMENTS_CHUNK = 300;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function fetchDispatchServices(admin: SupabaseClient, tenantId: string) {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - SERVICES_LOOKBACK_DAYS);
  const fromDateIso = fromDate.toISOString().slice(0, 10);
  const activeStatusFilter = `status.not.in.(${TERMINAL_SERVICE_STATUSES.join(",")})`;

  const all: Service[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await admin
      .from("services")
      .select("*")
      .eq("tenant_id", tenantId)
      .or(`date.gte.${fromDateIso},${activeStatusFilter}`)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + SERVICES_PAGE - 1);
    if (error) return { data: null, error };
    if (data) all.push(...(data as Service[]));
    if (!data || data.length < SERVICES_PAGE) break;
    from += SERVICES_PAGE;
  }
  return { data: all, error: null };
}

async function fetchAssignmentsForServices(admin: SupabaseClient, tenantId: string, serviceIds: string[]) {
  if (serviceIds.length === 0) return { data: [], error: null };
  const all: Record<string, unknown>[] = [];
  for (const ids of chunkArray(serviceIds, ASSIGNMENTS_CHUNK)) {
    const { data, error } = await admin
      .from("assignments")
      .select("id, tenant_id, service_id, driver_user_id, driver_profile_id, vehicle_label")
      .eq("tenant_id", tenantId)
      .in("service_id", ids);
    if (error) return { data: null, error };
    all.push(...(data ?? []));
  }
  return { data: all, error: null };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;

    const [servicesResult, hotelsResult, membershipsResult, inboundResult, vehiclesResult, driverRegistry] = await Promise.all([
      fetchDispatchServices(auth.admin, tenantId),
      auth.admin.from("hotels").select("id, tenant_id, name").eq("tenant_id", tenantId),
      auth.admin
        .from("memberships")
        .select("user_id, tenant_id, role, full_name")
        .eq("tenant_id", tenantId),
      auth.admin
        .from("inbound_emails")
        .select("id, tenant_id, subject, parsed_json, body_text, raw_text, created_at")
        .eq("tenant_id", tenantId),
      loadOperationalVehicles(auth.admin, tenantId, { activeOnly: true }),
      listDriverRegistry(auth.admin, tenantId, { activeOnly: true }),
    ]);

    if (servicesResult.error) {
      return NextResponse.json({ ok: false, error: servicesResult.error.message }, { status: 500 });
    }

    const serviceIds = (servicesResult.data ?? []).map((s) => s.id);
    const assignmentsResult = await fetchAssignmentsForServices(auth.admin, tenantId, serviceIds);

    const error =
      assignmentsResult.error ??
      hotelsResult.error ??
      membershipsResult.error ??
      inboundResult.error ??
      null;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      user_id: auth.user.id,
      services: servicesResult.data ?? [],
      assignments: assignmentsResult.data ?? [],
      hotels: hotelsResult.data ?? [],
      memberships: membershipsResult.data ?? [],
      driver_profiles: driverRegistry,
      inbound_emails: inboundResult.data ?? [],
      vehicles: vehiclesResult ?? []
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
