import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildOperationalSummaryPreview } from "@/lib/server/operational-summary";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";
import { sendOperationalReportEmail, type ReportJobType } from "@/lib/server/report-job-email";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

type ReportJobRow = {
  id: string;
  job_type: string;
  target_date: string;
  owner_name: string | null;
  status: string;
  payload: Record<string, unknown> | null;
};

function buildPreviewText(jobType: string, ownerName: string | null, lines: Array<{ date: string; time: string; customer_name: string; pax: number; hotel_or_destination: string | null; direction: "arrival" | "departure" }>) {
  const owner = ownerName ?? "Owner non definito";
  const header = `${jobType} | ${owner} | ${lines.length} servizi | ${lines.reduce((sum, line) => sum + line.pax, 0)} pax`;
  const body = lines
    .sort((left, right) => `${left.date}T${left.time}`.localeCompare(`${right.date}T${right.time}`))
    .map((line) => `${line.date} ${line.time} | ${line.direction === "arrival" ? "Arrivo" : "Partenza"} | ${line.customer_name} | ${line.hotel_or_destination ?? "N/D"} | ${line.pax} pax`);
  return [header, ...body].join("\n");
}

async function readOperationalSettings(admin: any, tenantId: string) {
  const { data } = await admin
    .from("tenant_operational_settings")
    .select("statement_agencies, report_processing_limit")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return {
    statement_agencies: (data?.statement_agencies as string[] | null) ?? STATEMENT_AGENCY_NAMES,
    report_processing_limit: typeof data?.report_processing_limit === "number" ? data.report_processing_limit : 25
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

export async function PATCH(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as { today?: string; limit?: number } | null;
  const today = body?.today ?? new Date().toISOString().slice(0, 10);
  const requestedLimit = Math.min(50, Math.max(1, body?.limit ?? 50));

  const [{ data: jobs, error: jobsError }, { data: services, error: servicesError }, settings] = await Promise.all([
    auth.admin
      .from("ops_report_jobs")
      .select("id, job_type, target_date, owner_name, status, payload")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("status", "planned")
      .order("created_at", { ascending: true })
      .limit(requestedLimit),
    auth.admin.from("services").select("*").eq("tenant_id", auth.membership.tenant_id).limit(2000),
    readOperationalSettings(auth.admin, auth.membership.tenant_id)
  ]);

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }
  if (servicesError) {
    return NextResponse.json({ error: servicesError.message }, { status: 500 });
  }

  const limit = Math.min(requestedLimit, settings.report_processing_limit);
  const preview = buildOperationalSummaryPreview((services ?? []) as any[], today, settings.statement_agencies);
  const updates = await Promise.all((((jobs ?? []) as ReportJobRow[]).slice(0, limit)).map(async (job) => {
    const lines =
      job.job_type === "arrivals_48h"
        ? preview.arrivals_48h[job.owner_name ?? ""]
        : job.job_type === "departures_48h"
          ? preview.departures_48h[job.owner_name ?? ""]
          : job.job_type === "bus_monday"
            ? preview.bus_monday[job.owner_name ?? ""]
            : preview.statement_candidates[job.owner_name ?? ""];

    const previewText = buildPreviewText(job.job_type, job.owner_name, lines ?? []);
    const generatedAt = new Date().toISOString();
    const basePayload = {
      ...(typeof job.payload === "object" && job.payload ? job.payload : {}),
      generated_at: generatedAt,
      processed_by: auth.user.id,
      preview_text: previewText,
      line_count: lines?.length ?? 0,
      delivery_mode: "email"
    };

    if (!lines || lines.length === 0) {
      auditLog({
        event: "ops_report_job_failed",
        level: "warn",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        role: auth.membership.role,
        outcome: "empty_batch",
        details: {
          job_id: job.id,
          job_type: job.job_type,
          owner_name: job.owner_name,
          target_date: job.target_date
        }
      });
      return {
        id: job.id,
        status: "failed",
        payload: {
          ...basePayload,
          send_error: "Nessuna riga operativa disponibile al momento del processamento."
        }
      };
    }

    const delivery = await sendOperationalReportEmail({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      jobType: job.job_type as ReportJobType,
      targetDate: job.target_date,
      ownerName: job.owner_name,
      lines
    });

    if (delivery.status === "sent") {
      auditLog({
        event: "ops_report_job_sent",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        role: auth.membership.role,
        outcome: "sent",
        details: {
          job_id: job.id,
          job_type: job.job_type,
          owner_name: job.owner_name,
          target_date: job.target_date,
          recipient: delivery.recipient,
          provider_message_id: delivery.providerMessageId,
          line_count: lines.length
        }
      });
      return {
        id: job.id,
        status: "sent",
        payload: {
          ...basePayload,
          sent_at: generatedAt,
          sent_to: delivery.recipient,
          provider_message_id: delivery.providerMessageId,
          send_error: null
        }
      };
    }

    auditLog({
      event: "ops_report_job_failed",
      level: "error",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      outcome: "failed",
      details: {
        job_id: job.id,
        job_type: job.job_type,
        owner_name: job.owner_name,
        target_date: job.target_date,
        recipient: delivery.recipient,
        error: delivery.error
      }
    });

    const nextPayload = {
      ...basePayload,
      sent_to: delivery.recipient,
      provider_message_id: null,
      send_error: delivery.error
    };

    return {
      id: job.id,
      status: "failed",
      payload: nextPayload
    };
  }));

  if (updates.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 });
  }

  for (const update of updates) {
    const { error } = await auth.admin
      .from("ops_report_jobs")
      .update({ status: update.status, payload: update.payload })
      .eq("id", update.id)
      .eq("tenant_id", auth.membership.tenant_id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    processed: updates.length,
    sent: updates.filter((item) => item.status === "sent").length,
    failed: updates.filter((item) => item.status === "failed").length
  });
}
