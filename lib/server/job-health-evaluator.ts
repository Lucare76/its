/**
 * Health evaluator del Centro Salute ITS (Sprint 2) — trasforma
 * EXECUTION STATUS (running/success/warning/failed, gia' registrato da
 * Sprint 1 in system_job_runs) in HEALTH STATUS (healthy/info/warning/
 * critical/disabled/unknown), secondo le regole specifiche di ogni job.
 *
 * Principio fondamentale: execution status != health status. Un run
 * `success` con `warning_count > 0` puo' restare `healthy` se il warning e'
 * una condizione operativa normale (es. email senza PDF) — vedi
 * classifyPollEmailsRun. La UI NON decide la health: legge solo il
 * risultato di questo modulo.
 *
 * Puro: nessun accesso DB qui (prende `runs` gia' caricati e `now`
 * iniettato), cosi' resta interamente testabile con date fisse.
 */
import type { SystemJobRunRow } from "./job-health";
import type { JobHealthRuleConfig } from "./job-health-config";

export type JobHealthStatus = "healthy" | "info" | "warning" | "critical" | "disabled" | "unknown";

export type JobHealthEvaluation = {
  jobKey: string;
  jobName: string;
  enabled: boolean;
  healthStatus: JobHealthStatus;
  /** Motivo in italiano comprensibile, mai un errore tecnico grezzo (quello va in technicalDetail). */
  reason: string;
  /** Errore tecnico originale, solo come dettaglio secondario opzionale. */
  technicalDetail: string | null;
  lastRun: SystemJobRunRow | null;
  lastSuccess: SystemJobRunRow | null;
  lastFailure: SystemJobRunRow | null;
  consecutiveFailures: number;
  /** Run nella finestra recente (7gg) con un warning_count>0 o status 'warning' — solo osservabilita', non decide la health da sola. */
  recentWarningCount: number;
  stale: boolean;
  stuck: boolean;
  /** Note informative benigne da mostrare in UI come dettaglio, mai come anomalia (es. "1 email senza PDF"). */
  notes: string[];
};

const RECENT_WINDOW_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;

function baseEvaluation(config: JobHealthRuleConfig): JobHealthEvaluation {
  return {
    jobKey: config.jobKey,
    jobName: config.jobName,
    enabled: config.enabled,
    healthStatus: "unknown",
    reason: "",
    technicalDetail: null,
    lastRun: null,
    lastSuccess: null,
    lastFailure: null,
    consecutiveFailures: 0,
    recentWarningCount: 0,
    stale: false,
    stuck: false,
    notes: [],
  };
}

function metaNumber(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metaArrayLength(metadata: Record<string, unknown> | null | undefined, key: string): number {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function metaObject(metadata: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const value = metadata?.[key];
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Regole Backup (vedi spec sprint, esteso in Disaster Recovery V2 per la
 * copia offsite Cloudflare R2 — lib/server/r2-backup.ts): warning se success
 * ma con tabelle in errore, purge Supabase fallito, copia offsite fallita/non
 * configurata, o purge offsite fallito; altrimenti healthy con note
 * informative (tabelle esportate, righe totali, backup vecchi eliminati,
 * esito offsite). Assente `offsite_backup` in metadata (run precedenti alla
 * V2) -> nessun impatto, comportamento identico a prima. Il numero assoluto
 * di righe NON e' mai valutato come anomalia in questo sprint.
 */
function classifyBackupRun(run: SystemJobRunRow): { status: "healthy" | "warning"; reason: string; notes: string[] } {
  const tableErrors = metaArrayLength(run.metadata, "table_errors");
  const purgeErrors = metaArrayLength(run.metadata, "purge_errors");
  const offsiteBackup = metaObject(run.metadata, "offsite_backup");
  const offsiteStatus = typeof offsiteBackup?.status === "string" ? offsiteBackup.status : null;
  const offsiteProblem = offsiteStatus === "failed" || offsiteStatus === "skipped";
  const offsitePurgeErrors = metaArrayLength(run.metadata, "offsite_purge_errors");

  if (run.status === "warning" || tableErrors > 0 || purgeErrors > 0 || offsiteProblem || offsitePurgeErrors > 0) {
    const parts: string[] = [];
    if (tableErrors > 0) parts.push(`${tableErrors} tabelle con errori`);
    if (purgeErrors > 0) parts.push("pulizia backup vecchi non riuscita");
    if (offsiteStatus === "failed") parts.push("copia offsite (R2) non riuscita");
    if (offsiteStatus === "skipped") parts.push("copia offsite (R2) non configurata");
    if (offsitePurgeErrors > 0) parts.push("pulizia offsite (R2) non riuscita");
    return { status: "warning", reason: parts.length > 0 ? parts.join(", ") : "Backup completato con avvisi.", notes: [] };
  }

  const notes: string[] = [];
  const tablesExported = metaNumber(run.metadata, "tables_exported");
  const rowsTotal = metaNumber(run.metadata, "rows_total");
  const purgedCount = metaNumber(run.metadata, "purged_count");
  if (tablesExported != null) notes.push(`${tablesExported} tabelle esportate`);
  if (rowsTotal != null) notes.push(`${rowsTotal.toLocaleString("it-IT")} righe`);
  if (purgedCount != null && purgedCount > 0) notes.push(`${purgedCount} vecchio backup eliminato`);
  if (offsiteStatus === "success") notes.push("copia offsite (R2) verificata");
  return { status: "healthy", reason: "Backup completato correttamente.", notes };
}

/**
 * Regole Polling email: skipped_no_pdf, drafts_created=0, mailbox vuota,
 * duplicati gestiti NON sono mai anomaly — solo note informative. I dati
 * oggi disponibili non permettono di distinguere in modo affidabile un
 * "warning reale" (lock persistente, parsing fallito) da un run success:
 * quel segnale, quando esistera' esplicitamente nei dati, andra' aggiunto
 * qui — non viene inventato in questo sprint.
 */
function classifyPollEmailsRun(run: SystemJobRunRow): { status: "healthy" | "warning"; reason: string; notes: string[] } {
  const notes: string[] = [];
  const emailsProcessed = metaNumber(run.metadata, "emails_processed");
  const skippedNoPdf = metaNumber(run.metadata, "skipped_no_pdf");
  const draftsCreated = metaNumber(run.metadata, "drafts_created");
  const duplicateWarnings = metaNumber(run.metadata, "duplicate_warnings");

  if (emailsProcessed != null) notes.push(`${emailsProcessed} email controllate`);
  if (skippedNoPdf != null && skippedNoPdf > 0) notes.push(`${skippedNoPdf} email senza PDF`);
  if (draftsCreated != null) notes.push(`${draftsCreated} bozze create`);
  if (duplicateWarnings != null && duplicateWarnings > 0) notes.push(`${duplicateWarnings} duplicati gestiti`);

  return { status: "healthy", reason: "Polling email completato correttamente.", notes };
}

/** Fallback generico per job senza regole dedicate: un execution status 'warning' diventa health 'info' (non concerning, ma non del tutto silenzioso) finche' non viene definita una regola specifica. */
function classifyGenericRun(run: SystemJobRunRow): { status: "healthy" | "info"; reason: string; notes: string[] } {
  if (run.status === "warning") {
    return { status: "info", reason: "Esecuzione completata con avvisi da verificare.", notes: [] };
  }
  return { status: "healthy", reason: "Esecuzione completata correttamente.", notes: [] };
}

function classifyJobSpecificRun(jobKey: string, run: SystemJobRunRow): { status: "healthy" | "info" | "warning"; reason: string; notes: string[] } {
  if (jobKey === "backup") return classifyBackupRun(run);
  if (jobKey === "poll-emails") return classifyPollEmailsRun(run);
  return classifyGenericRun(run);
}

export type EvaluateJobHealthInput = {
  config: JobHealthRuleConfig;
  /** Run ordinati per started_at DESC (il piu' recente prima) — richiesto per calcolare i fallimenti consecutivi reali. */
  runs: readonly SystemJobRunRow[];
  now: Date;
  recentWindowMs?: number;
};

export function evaluateJobHealth(input: EvaluateJobHealthInput): JobHealthEvaluation {
  const { config, runs, now } = input;
  const recentWindowMs = input.recentWindowMs ?? RECENT_WINDOW_MS_DEFAULT;

  if (!config.enabled) {
    return {
      ...baseEvaluation(config),
      healthStatus: "disabled",
      reason: "Job non in uso operativamente.",
    };
  }

  const lastRun = runs[0] ?? null;
  const lastSuccess = runs.find((r) => r.status === "success" || r.status === "warning") ?? null;
  const lastFailure = runs.find((r) => r.status === "failed") ?? null;

  let consecutiveFailures = 0;
  for (const r of runs) {
    if (r.status === "failed") consecutiveFailures++;
    else break;
  }

  const recentSinceIso = new Date(now.getTime() - recentWindowMs).toISOString();
  const recentWarningCount = runs.filter((r) => r.started_at >= recentSinceIso && (r.status === "warning" || r.warning_count > 0)).length;

  const common = {
    ...baseEvaluation(config),
    lastRun,
    lastSuccess,
    lastFailure,
    consecutiveFailures,
    recentWarningCount,
  };

  // --- Job bloccato in 'running' oltre il timeout: prevale su tutto il resto (osservabilita' pura, nessuna azione). ---
  if (lastRun && lastRun.status === "running") {
    const runningMinutes = (now.getTime() - new Date(lastRun.started_at).getTime()) / 60_000;
    if (runningMinutes > config.maxRunningMinutes) {
      return {
        ...common,
        healthStatus: "critical",
        reason: `Job fermo in esecuzione da oltre ${config.maxRunningMinutes} minuti.`,
        stuck: true,
      };
    }
    return {
      ...common,
      healthStatus: "info",
      reason: "Esecuzione in corso.",
      stuck: false,
    };
  }

  // --- Mai eseguito. ---
  if (!lastRun) {
    if (config.firstExpectedAt && now.getTime() > new Date(config.firstExpectedAt).getTime()) {
      return {
        ...common,
        healthStatus: config.missingRunSeverity,
        reason: "Esecuzione attesa ma non rilevata.",
      };
    }
    return {
      ...common,
      healthStatus: "unknown",
      reason: "Nessuna esecuzione ancora registrata.",
    };
  }

  // --- Fallimenti consecutivi oltre soglia critica. ---
  if (consecutiveFailures >= config.criticalConsecutiveFailures) {
    return {
      ...common,
      healthStatus: "critical",
      reason: `${consecutiveFailures} esecuzioni consecutive fallite.`,
      technicalDetail: lastFailure?.error_message ?? null,
    };
  }

  // --- Ultima esecuzione fallita, ma non ancora oltre soglia critica. ---
  if (lastRun.status === "failed") {
    return {
      ...common,
      healthStatus: "warning",
      reason: consecutiveFailures > 1 ? `${consecutiveFailures} esecuzioni consecutive fallite.` : "Ultima esecuzione fallita.",
      technicalDetail: lastRun.error_message ?? null,
    };
  }

  // --- Ultimo run non fallito ne' running: valuta staleness (nessun successo entro la finestra prevista). ---
  // Applicabile SOLO per job "scheduled" con staleAfterMinutes impostato: un
  // job "event-driven" (es. poll-emails, che parte solo come conseguenza di
  // un altro flusso operativo, non a cadenza fissa) non ha alcuna finestra
  // temporale attesa — mai stale solo perche' non gira da ore/giorni.
  if (config.schedulingMode === "scheduled" && config.staleAfterMinutes != null && config.staleSeverity != null) {
    const lastSuccessAtIso = lastSuccess ? (lastSuccess.finished_at ?? lastSuccess.started_at) : null;
    const staleMs = config.staleAfterMinutes * 60_000;
    const stale = lastSuccessAtIso == null || now.getTime() - new Date(lastSuccessAtIso).getTime() > staleMs;
    if (stale) {
      return {
        ...common,
        healthStatus: config.staleSeverity,
        reason: "Ultimo successo troppo vecchio.",
        stale: true,
      };
    }
  }

  // --- Classificazione specifica del job sull'ultimo run. ---
  const classified = classifyJobSpecificRun(config.jobKey, lastRun);
  return {
    ...common,
    healthStatus: classified.status,
    reason: classified.reason,
    notes: classified.notes,
    technicalDetail: lastRun.status === "warning" ? lastRun.error_message ?? null : null,
  };
}

export type OverallHealthStatus = "healthy" | "attention" | "critical";

/**
 * Stato sintetico ITS: critical se almeno un job enabled e' critical;
 * attention se almeno un warning (e nessun critical); altrimenti healthy.
 * I job disabled sono sempre ignorati nel calcolo.
 */
export function computeOverallHealth(evaluations: readonly JobHealthEvaluation[]): OverallHealthStatus {
  const relevant = evaluations.filter((e) => e.enabled);
  if (relevant.some((e) => e.healthStatus === "critical")) return "critical";
  if (relevant.some((e) => e.healthStatus === "warning")) return "attention";
  return "healthy";
}

export type JobHealthSummaryCounts = Record<JobHealthStatus, number>;

export function summarizeJobHealthCounts(evaluations: readonly JobHealthEvaluation[]): JobHealthSummaryCounts {
  const counts: JobHealthSummaryCounts = { healthy: 0, info: 0, warning: 0, critical: 0, disabled: 0, unknown: 0 };
  for (const e of evaluations) counts[e.healthStatus] += 1;
  return counts;
}
