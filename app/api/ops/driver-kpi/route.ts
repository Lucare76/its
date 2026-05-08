/**
 * GET /api/ops/driver-kpi?days=7|30|all
 * KPI per autista: servizi assegnati, completati, pax, arrivi/partenze.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const url = new URL(request.url);
    const daysParam = url.searchParams.get("days") ?? "30";

    let fromDate: string | null = null;
    if (daysParam !== "all") {
      const days = parseInt(daysParam, 10);
      if (!isNaN(days) && days > 0) {
        const d = new Date();
        d.setDate(d.getDate() - days);
        fromDate = d.toISOString().slice(0, 10);
      }
    }

    // Prima filtra i servizi del periodo: evita query .in() enormi su tutte le assegnazioni storiche.
    let svcQuery = auth.admin
      .from("services")
      .select("id, date, pax, direction, status")
      .eq("tenant_id", tenantId);

    if (fromDate) svcQuery = svcQuery.gte("date", fromDate);

    const { data: services, error: sErr } = await svcQuery;
    if (sErr) throw new Error(sErr.message);
    if (!services?.length) return NextResponse.json({ ok: true, kpi: [], from_date: fromDate });

    const serviceIds = services.map((service) => service.id as string);
    const assignments: Array<{ service_id: string; driver_user_id: string | null }> = [];

    for (const ids of chunkArray(serviceIds, 300)) {
      const { data: chunk, error: aErr } = await auth.admin
        .from("assignments")
        .select("service_id, driver_user_id")
        .eq("tenant_id", tenantId)
        .not("driver_user_id", "is", null)
        .in("service_id", ids);

      if (aErr) throw new Error(aErr.message);
      assignments.push(...((chunk ?? []) as Array<{ service_id: string; driver_user_id: string | null }>));
    }

    if (!assignments.length) return NextResponse.json({ ok: true, kpi: [], from_date: fromDate });

    // Nomi autisti dai profili driver_profiles
    const { data: driverProfiles } = await auth.admin
      .from("driver_profiles")
      .select("id, user_id, full_name")
      .eq("tenant_id", tenantId)
      .eq("active", true);

    // Nomi autisti dai membership (driver loggati come utenti)
    const { data: memberships } = await auth.admin
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", tenantId)
      .eq("role", "driver");

    const nameByUserId = new Map<string, string>(
      (memberships ?? []).map((m) => [m.user_id as string, m.full_name as string])
    );
    // driver_profiles potrebbero avere un user_id collegato
    for (const dp of driverProfiles ?? []) {
      const linkedUserId = (dp as { user_id?: string | null }).user_id ?? null;
      if (linkedUserId && !nameByUserId.has(linkedUserId)) {
        nameByUserId.set(linkedUserId, dp.full_name as string);
      }
    }

    const serviceById = new Map(
      (services ?? []).map((s) => [s.id as string, s])
    );

    type Stat = {
      driver_user_id: string;
      full_name: string;
      total: number;
      completed: number;
      pax: number;
      arrivals: number;
      departures: number;
    };

    const stats = new Map<string, Stat>();

    for (const asgn of assignments) {
      const driverId = asgn.driver_user_id as string;
      const svc = serviceById.get(asgn.service_id as string);
      if (!svc) continue; // fuori dal filtro data

      if (!stats.has(driverId)) {
        stats.set(driverId, {
          driver_user_id: driverId,
          full_name: nameByUserId.get(driverId) ?? `Autista (${driverId.slice(0, 8)})`,
          total: 0,
          completed: 0,
          pax: 0,
          arrivals: 0,
          departures: 0,
        });
      }

      const stat = stats.get(driverId)!;
      stat.total++;
      stat.pax += Number(svc.pax) || 0;
      if ((svc.status as string) === "completato") stat.completed++;
      if ((svc.direction as string) === "arrival") stat.arrivals++;
      else stat.departures++;
    }

    const kpi = Array.from(stats.values()).sort((a, b) => b.total - a.total);
    return NextResponse.json({ ok: true, kpi, from_date: fromDate });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
