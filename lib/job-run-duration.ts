/**
 * Durata di un run di `system_job_runs` per la UI (Centro Salute / impostazioni
 * sistema). Estratto da app/(app)/settings/system/page.tsx per testabilita'.
 *
 * Per job il cui lavoro reale avviene FUORI dalla richiesta che lo riporta
 * (es. "postgres-backup": pg_dump gira su GitHub Actions, il report a
 * /api/cron/postgres-backup-report arriva a lavoro gia' concluso) le colonne
 * `started_at`/`finished_at` vengono scritte quasi simultaneamente dalla route
 * di report (insert + update nella stessa richiesta): il loro delta misura solo
 * la latenza della POST (~0s), non l'esecuzione reale. Quando il chiamante
 * riporta anche `metadata.duration_ms` (la durata reale, misurata lato
 * mittente) va SEMPRE preferita al delta started_at/finished_at.
 *
 * Per i job il cui started_at/finished_at COINCIDONO davvero con l'esecuzione
 * (es. "backup" JSON, "whatsapp-reminders": start+lavoro+complete nella stessa
 * richiesta) `metadata.duration_ms` e' semplicemente assente e il comportamento
 * resta identico a prima (delta started_at/finished_at).
 */
export function formatJobRunDuration(
  startedAt: string,
  finishedAt: string | null,
  metadata?: Record<string, unknown> | null,
): string {
  if (!finishedAt) return "in corso";

  const metaDurationMs = metadata?.duration_ms;
  const ms =
    typeof metaDurationMs === "number" && Number.isFinite(metaDurationMs) && metaDurationMs >= 0
      ? metaDurationMs
      : new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
