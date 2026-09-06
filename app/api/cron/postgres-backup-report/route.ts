/**
 * POST /api/cron/postgres-backup-report
 *
 * Disaster Recovery V3 — Layer 8 (osservabilita').
 *
 * Riceve dal workflow GitHub Actions (.github/workflows/postgres-backup.yml,
 * via scripts/postgres-backup.mjs -> healthPing) l'esito del backup PostgreSQL
 * completo e lo registra in `system_job_runs` con job_key "postgres-backup",
 * cosi' il Centro Salute ITS (/api/admin/system-status) e la card "Stato
 * sistema" di Controllo Giornata lo valutano come qualunque altro job.
 *
 * Il job "postgres-backup" e' DISTINTO da "backup" (snapshot JSON): un JSON
 * verde non maschera mai un pg_dump fallito — computeOverallHealth va in
 * "critical" se questo job e' critical.
 *
 * NON tocca il database applicativo: scrive solo una riga di audit in
 * system_job_runs. Nessun dato di produzione modificato.
 *
 * Auth: header `Authorization: Bearer <DR_HEALTH_REPORT_SECRET>`.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { startJobRun, completeJobRun } from "@/lib/server/job-health";

export const runtime = "nodejs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const reportSchema = z.object({
  status: z.enum(["success", "failed"]),
  base_name: z.string().max(120).optional(),
  created_at: z.string().max(40).optional(),
  total_size_bytes: z.number().nonnegative().optional(),
  artifact_count: z.number().int().nonnegative().optional(),
  verification: z.enum(["passed", "unverified", "failed"]).optional(),
  public_verification: z.enum(["passed", "unverified", "failed"]).optional(),
  auth_verification: z.enum(["passed", "failed"]).optional(),
  duration_ms: z.number().nonnegative().optional(),
  postgres_server_version: z.string().max(40).nullable().optional(),
  pg_dump_version: z.string().max(200).nullable().optional(),
  retention_days: z.number().int().positive().optional(),
  error: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  const secret = process.env.DR_HEALTH_REPORT_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "Server configuration error" }, { status: 500 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const parsed = reportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." },
      { status: 400 },
    );
  }

  const admin = adminClient();
  if (!admin) {
    return NextResponse.json({ ok: false, error: "Supabase env mancante" }, { status: 500 });
  }

  const body = parsed.data;
  const metadata: Record<string, unknown> = {
    base_name: body.base_name ?? null,
    reported_created_at: body.created_at ?? null,
    total_size_bytes: body.total_size_bytes ?? null,
    artifact_count: body.artifact_count ?? null,
    verification: body.verification ?? null,
    public_verification: body.public_verification ?? null,
    auth_verification: body.auth_verification ?? null,
    postgres_server_version: body.postgres_server_version ?? null,
    pg_dump_version: body.pg_dump_version ?? null,
    retention_days: body.retention_days ?? null,
    duration_ms: body.duration_ms ?? null,
  };

  // Un backup "success" ma con verifica strutturale (overall, PUBLIC o AUTH)
  // non "passed" e' comunque un warning: il dump esiste ma non abbiamo la
  // conferma che sia completo/ripristinabile.
  const verificationDegraded =
    (body.verification && body.verification !== "passed") ||
    (body.public_verification && body.public_verification !== "passed") ||
    (body.auth_verification && body.auth_verification !== "passed");
  const jobStatus: "success" | "warning" | "failed" =
    body.status === "failed" ? "failed" : verificationDegraded ? "warning" : "success";

  const runId = await startJobRun({
    admin,
    jobKey: "postgres-backup",
    jobName: "Backup PostgreSQL completo (DR V3)",
    source: "github-actions/postgres-backup",
    metadata,
  });

  await completeJobRun({
    admin,
    runId,
    status: jobStatus,
    processedCount: body.artifact_count ?? 0,
    successCount: jobStatus === "failed" ? 0 : body.artifact_count ?? 0,
    failedCount: jobStatus === "failed" ? 1 : 0,
    warningCount: jobStatus === "warning" ? 1 : 0,
    errorMessage: body.status === "failed" ? body.error ?? "Backup PostgreSQL fallito." : null,
    metadata,
  });

  return NextResponse.json({ ok: true, recorded: jobStatus, run_id: runId });
}
