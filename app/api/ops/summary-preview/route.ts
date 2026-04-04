import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildOperationalSummaryPreview } from "@/lib/server/operational-summary";
import type { SummaryPreviewPayload } from "@/lib/server/operational-summary";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const today = request.nextUrl.searchParams.get("today") ?? new Date().toISOString().slice(0, 10);
    const { data, error } = await auth.admin
      .from("services")
      .select("*")
      .eq("tenant_id", auth.membership.tenant_id)
      .order("date", { ascending: true })
      .limit(1000);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const [exportAuditsResult, operationalSettingsResult, reportJobsResult] = await Promise.all([
      auth.admin
        .from("export_audits")
        .select("id, date_from, date_to, service_type, exported_count, created_at")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(12),
      auth.admin
        .from("tenant_operational_settings")
        .select("statement_agencies")
        .eq("tenant_id", auth.membership.tenant_id)
        .maybeSingle(),
      auth.admin
        .from("ops_report_jobs")
        .select("id, job_type, target_date, owner_name, status, created_at, payload")
        .eq("tenant_id", auth.membership.tenant_id)
        .order("created_at", { ascending: false })
        .limit(20)
    ]);

    const exportAudits = exportAuditsResult.data ?? [];
    const operationalSettings = operationalSettingsResult.error ? null : operationalSettingsResult.data;
    const reportJobs = reportJobsResult.error ? [] : reportJobsResult.data ?? [];
    const statementAgencies = (operationalSettings?.statement_agencies as string[] | null) ?? STATEMENT_AGENCY_NAMES;

    const payload: SummaryPreviewPayload = {
      ...buildOperationalSummaryPreview((data ?? []) as any[], today, statementAgencies),
      export_history: (exportAudits ?? []) as any[],
      report_jobs: (reportJobs ?? []) as any[]
    };

    return NextResponse.json({ ok: true, payload });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
