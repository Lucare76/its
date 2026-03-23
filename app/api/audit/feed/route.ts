import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type MembershipRow = { user_id: string; full_name: string; role: string };
type OpsAuditRow = {
  id: string;
  event: string;
  level: string;
  user_id: string | null;
  role: string | null;
  service_id: string | null;
  outcome: string | null;
  duplicate: boolean;
  parser_key: string | null;
  parsing_quality: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};
type PricingAuditRow = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_user_id: string | null;
  created_at: string;
};
type ExportAuditRow = {
  id: string;
  service_type: string;
  date_from: string;
  date_to: string;
  exported_count: number;
  created_at: string;
};
type ReportJobRow = {
  id: string;
  job_type: string;
  owner_name: string | null;
  status: string;
  target_date: string;
  generated_at: string | null;
  processed_by: string | null;
  created_at: string;
};
type StatusEventRow = {
  id: string;
  service_id: string;
  status: string;
  by_user_id: string | null;
  at: string;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(limitRaw, 300)) : 80;

    const [opsAuditResult, pricingAuditResult, exportAuditResult, reportJobsResult, statusEventsResult, membershipsResult] = await Promise.all([
      auth.admin
        .from("ops_audit_events")
        .select("id, event, level, user_id, role, service_id, outcome, duplicate, parser_key, parsing_quality, details, created_at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(limit),
      auth.admin
        .from("pricing_audits")
        .select("id, entity_type, entity_id, action, actor_user_id, created_at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(limit),
      auth.admin
        .from("export_audits")
        .select("id, service_type, date_from, date_to, exported_count, created_at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(limit),
      auth.admin
        .from("ops_report_jobs")
        .select("id, job_type, owner_name, status, target_date, generated_at, processed_by, created_at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(limit),
      auth.admin
        .from("status_events")
        .select("id, service_id, status, by_user_id, at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("at", { ascending: false })
        .limit(limit),
      auth.admin
        .from("memberships")
        .select("user_id, full_name, role")
        .eq("tenant_id", auth.membership.tenant_id)
    ]);

    const memberships = (membershipsResult.data ?? []) as MembershipRow[];
    const namesByUserId = new Map(memberships.map((item: MembershipRow) => [item.user_id, item.full_name]));

    const timeline = [
      ...((opsAuditResult.data ?? []) as OpsAuditRow[]).map((item: OpsAuditRow) => ({
        id: `ops-${item.id}`,
        at: item.created_at,
        category: "ops_audit",
        title: item.event,
        detail: item.outcome ?? item.level,
        actor: item.user_id ? namesByUserId.get(item.user_id) ?? item.user_id : item.role ?? "system",
        meta: {
          level: item.level,
          duplicate: item.duplicate,
          parser_key: item.parser_key,
          parsing_quality: item.parsing_quality,
          service_id: item.service_id,
          details: item.details
        }
      })),
      ...((pricingAuditResult.data ?? []) as PricingAuditRow[]).map((item: PricingAuditRow) => ({
        id: `pricing-${item.id}`,
        at: item.created_at,
        category: "pricing_audit",
        title: `${item.entity_type} ${item.action}`,
        detail: item.entity_id,
        actor: item.actor_user_id ? namesByUserId.get(item.actor_user_id) ?? item.actor_user_id : "system",
        meta: {}
      })),
      ...((exportAuditResult.data ?? []) as ExportAuditRow[]).map((item: ExportAuditRow) => ({
        id: `export-${item.id}`,
        at: item.created_at,
        category: "export_audit",
        title: item.service_type,
        detail: `${item.date_from} -> ${item.date_to}`,
        actor: "system",
        meta: { exported_count: item.exported_count }
      })),
      ...((reportJobsResult.data ?? []) as ReportJobRow[]).map((item: ReportJobRow) => ({
        id: `job-${item.id}`,
        at: item.created_at,
        category: "report_job",
        title: item.job_type,
        detail: item.target_date,
        actor: item.processed_by ? namesByUserId.get(item.processed_by) ?? item.processed_by : item.owner_name ?? "system",
        meta: { status: item.status, generated_at: item.generated_at }
      })),
      ...((statusEventsResult.data ?? []) as StatusEventRow[]).map((item: StatusEventRow) => ({
        id: `status-${item.id}`,
        at: item.at,
        category: "status_event",
        title: item.status,
        detail: item.service_id,
        actor: item.by_user_id ? namesByUserId.get(item.by_user_id) ?? item.by_user_id : "system",
        meta: {}
      }))
    ]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, limit);

    return NextResponse.json({
      ok: true,
      summary: {
        ops_audits: opsAuditResult.data?.length ?? 0,
        pricing_audits: pricingAuditResult.data?.length ?? 0,
        export_audits: exportAuditResult.data?.length ?? 0,
        report_jobs: reportJobsResult.data?.length ?? 0,
        status_events: statusEventsResult.data?.length ?? 0
      },
      timeline
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
