import { type SupabaseClient } from "@supabase/supabase-js";

export type JobRunStatus = "running" | "success" | "warning" | "failed";

export type JobRunCounts = {
  processedCount?: number;
  successCount?: number;
  failedCount?: number;
  warningCount?: number;
};

export type StartJobRunInput = {
  admin: SupabaseClient;
  tenantId?: string | null;
  jobKey: string;
  jobName: string;
  source: string;
  metadata?: Record<string, unknown> | null;
};

export type CompleteJobRunInput = JobRunCounts & {
  admin: SupabaseClient;
  runId?: string | null;
  status: Exclude<JobRunStatus, "running">;
  errorMessage?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type JobRunSummary = {
  job_key: string;
  job_name: string;
  source: string;
  latest_run: SystemJobRunRow | null;
  latest_success: SystemJobRunRow | null;
  latest_failure: SystemJobRunRow | null;
  recent_failed_count: number;
};

export type SystemJobRunRow = {
  id: string;
  tenant_id: string | null;
  job_key: string;
  job_name: string;
  source: string;
  started_at: string;
  finished_at: string | null;
  status: JobRunStatus;
  processed_count: number;
  success_count: number;
  failed_count: number;
  warning_count: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

const SENSITIVE_KEY_PATTERN = /(token|secret|password|pass|authorization|cookie|session|refresh|access[_-]?key|api[_-]?key)/i;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 40;

function clampCount(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function summarizeJobError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "Errore sconosciuto");
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function sanitizeJobMetadata(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeJobMetadata(item, depth + 1));
  if (typeof value !== "object") return String(value);
  if (depth >= 4) return "[truncated]";

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeJobMetadata(item, depth + 1);
  }
  return out;
}

function sanitizedMetadataObject(metadata: Record<string, unknown> | null | undefined) {
  return (sanitizeJobMetadata(metadata ?? {}) ?? {}) as Record<string, unknown>;
}

export async function startJobRun(input: StartJobRunInput): Promise<string | null> {
  try {
    const { data, error } = await input.admin
      .from("system_job_runs")
      .insert({
        tenant_id: input.tenantId ?? null,
        job_key: input.jobKey,
        job_name: input.jobName,
        source: input.source,
        status: "running",
        metadata: sanitizedMetadataObject(input.metadata)
      })
      .select("id")
      .single();

    if (error) {
      console.error("Job health start failed", { jobKey: input.jobKey, message: error.message });
      return null;
    }
    return typeof data?.id === "string" ? data.id : null;
  } catch (error) {
    console.error("Job health start crashed", { jobKey: input.jobKey, message: summarizeJobError(error) });
    return null;
  }
}

export async function completeJobRun(input: CompleteJobRunInput): Promise<void> {
  if (!input.runId) return;
  try {
    const { error } = await input.admin
      .from("system_job_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: input.status,
        processed_count: clampCount(input.processedCount),
        success_count: clampCount(input.successCount),
        failed_count: clampCount(input.failedCount),
        warning_count: clampCount(input.warningCount),
        error_message: input.errorMessage ? summarizeJobError(input.errorMessage) : null,
        metadata: sanitizedMetadataObject(input.metadata)
      })
      .eq("id", input.runId);

    if (error) {
      console.error("Job health complete failed", { runId: input.runId, status: input.status, message: error.message });
    }
  } catch (error) {
    console.error("Job health complete crashed", { runId: input.runId, status: input.status, message: summarizeJobError(error) });
  }
}

export async function withJobHealth<T>(
  input: StartJobRunInput,
  fn: () => Promise<{
    result: T;
    status?: Exclude<JobRunStatus, "running">;
    counts?: JobRunCounts;
    metadata?: Record<string, unknown> | null;
    errorMessage?: string | null;
  }>
): Promise<T> {
  const runId = await startJobRun(input);
  try {
    const outcome = await fn();
    await completeJobRun({
      admin: input.admin,
      runId,
      status: outcome.status ?? "success",
      ...(outcome.counts ?? {}),
      errorMessage: outcome.errorMessage ?? null,
      metadata: outcome.metadata ?? null
    });
    return outcome.result;
  } catch (error) {
    await completeJobRun({
      admin: input.admin,
      runId,
      status: "failed",
      errorMessage: summarizeJobError(error),
      metadata: { thrown: true }
    });
    throw error;
  }
}

/**
 * Storico ordinato (piu' recente prima) per il Centro Salute ITS (Sprint 2)
 * — richiesto dall'evaluator (job-health-evaluator.ts) per calcolare i
 * fallimenti consecutivi REALI a partire dal run piu' recente, cosa che
 * `readSystemJobHealthSummary` non espone (restituisce solo aggregati:
 * latest_run/latest_success/latest_failure/recent_failed_count).
 *
 * Query indipendente e duplicata deliberatamente rispetto a
 * `readSystemJobHealthSummary`: quella funzione ha test Sprint 1 che
 * fissano la sua esatta catena di chiamate sul client Supabase — non va
 * toccata per aggiungere questa funzionalita'.
 */
export async function readRecentJobRuns(
  admin: SupabaseClient,
  tenantId: string,
  jobKeys: string[],
  limit = 500
): Promise<Record<string, SystemJobRunRow[]>> {
  const byKey: Record<string, SystemJobRunRow[]> = Object.fromEntries(jobKeys.map((key) => [key, []]));

  const { data, error } = await admin
    .from("system_job_runs")
    .select("id, tenant_id, job_key, job_name, source, started_at, finished_at, status, processed_count, success_count, failed_count, warning_count, error_message, metadata, created_at")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .in("job_key", jobKeys)
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Job health run history read failed", { message: error.message });
    return byKey;
  }

  for (const row of (data ?? []) as SystemJobRunRow[]) {
    if (byKey[row.job_key]) byKey[row.job_key]!.push(row);
  }
  return byKey;
}

export async function readSystemJobHealthSummary(
  admin: SupabaseClient,
  tenantId: string,
  jobKeys: string[],
  recentSinceIso: string
): Promise<JobRunSummary[]> {
  const { data, error } = await admin
    .from("system_job_runs")
    .select("id, tenant_id, job_key, job_name, source, started_at, finished_at, status, processed_count, success_count, failed_count, warning_count, error_message, metadata, created_at")
    .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
    .in("job_key", jobKeys)
    .order("started_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error("Job health summary read failed", { message: error.message });
    return [];
  }

  const rows = (data ?? []) as SystemJobRunRow[];
  return jobKeys.map((jobKey) => {
    const keyRows = rows.filter((row) => row.job_key === jobKey);
    return {
      job_key: jobKey,
      job_name: keyRows[0]?.job_name ?? jobKey,
      source: keyRows[0]?.source ?? "",
      latest_run: keyRows[0] ?? null,
      latest_success: keyRows.find((row) => row.status === "success" || row.status === "warning") ?? null,
      latest_failure: keyRows.find((row) => row.status === "failed") ?? null,
      recent_failed_count: keyRows.filter((row) => row.status === "failed" && row.started_at >= recentSinceIso).length
    };
  });
}
