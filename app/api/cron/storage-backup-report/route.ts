/**
 * POST /api/cron/storage-backup-report
 *
 * Disaster Recovery V4 — Layer 8 (osservabilita'), stesso pattern di
 * /api/cron/postgres-backup-report (DR V3).
 *
 * Riceve dal workflow GitHub Actions (.github/workflows/storage-backup.yml,
 * via scripts/storage-backup.mjs -> healthPing) l'esito del backup dei bucket
 * Supabase Storage (vehicle-documents, vehicle-damage-photos, service-photos)
 * e lo registra in `system_job_runs` con job_key "storage-backup".
 *
 * Additivo: job DISTINTO da "backup" (JSON) e "postgres-backup" (DR V3) — un
 * loro verde non maschera mai un file Storage non backuppato.
 *
 * NON tocca dati applicativi: scrive solo una riga di audit in
 * system_job_runs. Auth: header `Authorization: Bearer <DR_HEALTH_REPORT_SECRET>`
 * (stesso secret di DR V3 — nessun nuovo secret introdotto).
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

const bucketResultSchema = z.object({
  bucket: z.string().max(80),
  tier: z.enum(["A", "B"]),
  status: z.enum(["success", "warning", "failed"]),
  file_count: z.number().int().nonnegative(),
  uploaded_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  total_bytes: z.number().nonnegative(),
  error: z.string().max(300).optional(),
});

const reportSchema = z.object({
  status: z.enum(["success", "warning", "failed"]),
  run_id: z.string().max(120),
  dry_run: z.boolean().optional(),
  duration_ms: z.number().nonnegative().optional(),
  total_uploaded: z.number().int().nonnegative().optional(),
  total_skipped: z.number().int().nonnegative().optional(),
  total_failed: z.number().int().nonnegative().optional(),
  total_bytes: z.number().nonnegative().optional(),
  manifest_r2_key: z.string().max(300).nullable().optional(),
  buckets: z.array(bucketResultSchema).max(20).optional(),
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
  const jobStatus = body.status;

  const metadata: Record<string, unknown> = {
    run_id: body.run_id,
    dry_run: body.dry_run ?? false,
    duration_ms: body.duration_ms ?? null,
    total_uploaded: body.total_uploaded ?? null,
    total_skipped: body.total_skipped ?? null,
    total_failed: body.total_failed ?? null,
    total_bytes: body.total_bytes ?? null,
    manifest_r2_key: body.manifest_r2_key ?? null,
    buckets: body.buckets ?? [],
  };

  const failedTierABucket = (body.buckets ?? []).find((b) => b.tier === "A" && b.status === "failed");
  const firstBucketError = (body.buckets ?? []).find((b) => b.error)?.error;

  const runId = await startJobRun({
    admin,
    jobKey: "storage-backup",
    jobName: "Backup file Storage (DR V4)",
    source: "github-actions/storage-backup",
    metadata,
  });

  await completeJobRun({
    admin,
    runId,
    status: jobStatus,
    processedCount: (body.total_uploaded ?? 0) + (body.total_skipped ?? 0) + (body.total_failed ?? 0),
    successCount: (body.total_uploaded ?? 0) + (body.total_skipped ?? 0),
    failedCount: body.total_failed ?? 0,
    warningCount: jobStatus === "warning" ? 1 : 0,
    errorMessage:
      jobStatus === "failed"
        ? body.error ?? (failedTierABucket ? `Bucket Tier A non backuppato: ${failedTierABucket.bucket}` : "Backup Storage fallito.")
        : jobStatus === "warning"
          ? firstBucketError ?? null
          : null,
    metadata,
  });

  return NextResponse.json({ ok: true, recorded: jobStatus, run_id: runId });
}
