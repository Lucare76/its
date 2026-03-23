import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildOperationalSummaryPreview } from "@/lib/server/operational-summary";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

export const runtime = "nodejs";

async function readOperationalSettings(admin: any, tenantId: string) {
  const { data } = await admin
    .from("tenant_operational_settings")
    .select("statement_agencies")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return {
    statement_agencies: (data?.statement_agencies as string[] | null) ?? STATEMENT_AGENCY_NAMES
  };
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { data, error } = await auth.admin
    .from("ops_report_jobs")
    .select("id, job_type, target_date, owner_name, status, created_at, payload")
    .eq("tenant_id", auth.membership.tenant_id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ ok: true, jobs: [] });
  }

  return NextResponse.json({ ok: true, jobs: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as { today?: string } | null;
  const today = body?.today ?? new Date().toISOString().slice(0, 10);

  const [{ data: services, error: servicesError }, settings] = await Promise.all([
    auth.admin.from("services").select("*").eq("tenant_id", auth.membership.tenant_id).limit(2000),
    readOperationalSettings(auth.admin, auth.membership.tenant_id)
  ]);

  if (servicesError) {
    return NextResponse.json({ error: servicesError.message }, { status: 500 });
  }

  const preview = buildOperationalSummaryPreview((services ?? []) as any[], today, settings.statement_agencies);
  const rows = [
    ...Object.entries(preview.arrivals_48h).flatMap(([owner, lines]) =>
      lines.length === 0
        ? []
        : [{ tenant_id: auth.membership.tenant_id, job_type: "arrivals_48h", target_date: preview.target_date_48h, owner_name: owner, status: "planned", payload: { count: lines.length, pax: lines.reduce((sum, line) => sum + line.pax, 0) }, created_by_user_id: auth.user.id }]
    ),
    ...Object.entries(preview.departures_48h).flatMap(([owner, lines]) =>
      lines.length === 0
        ? []
        : [{ tenant_id: auth.membership.tenant_id, job_type: "departures_48h", target_date: preview.target_date_48h, owner_name: owner, status: "planned", payload: { count: lines.length, pax: lines.reduce((sum, line) => sum + line.pax, 0) }, created_by_user_id: auth.user.id }]
    ),
    ...Object.entries(preview.bus_monday).flatMap(([owner, lines]) =>
      lines.length === 0
        ? []
        : [{ tenant_id: auth.membership.tenant_id, job_type: "bus_monday", target_date: preview.target_bus_monday_date, owner_name: owner, status: "planned", payload: { count: lines.length, pax: lines.reduce((sum, line) => sum + line.pax, 0) }, created_by_user_id: auth.user.id }]
    ),
    ...Object.entries(preview.statement_candidates).flatMap(([owner, lines]) =>
      lines.length === 0
        ? []
        : [{ tenant_id: auth.membership.tenant_id, job_type: "statement_agency", target_date: today, owner_name: owner, status: "planned", payload: { count: lines.length, total_cents: lines.reduce((sum, line) => sum + (line.total_amount_cents ?? 0), 0) }, created_by_user_id: auth.user.id }]
    )
  ];

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 });
  }

  const { error } = await auth.admin.from("ops_report_jobs").insert(rows);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
