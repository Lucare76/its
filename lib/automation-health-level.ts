/**
 * Severita' della sezione "Salute automazioni" (Centro Salute ITS,
 * app/(app)/settings/system/page.tsx) — calcolata SOLO dagli stati dei job
 * (system_job_runs -> lib/server/job-health-evaluator.ts), mai dall'Operational
 * Health (lib/server/operational-health.ts, sezione "Salute operativa" separata
 * nella stessa pagina).
 *
 * Bug corretto qui (2026-09-13): la pagina usava `status.overall_health`, gia'
 * combinato con l'Operational Health da `combineOverallHealth()` — un warning
 * puramente operativo (es. "backup 28 MB supera la soglia di verifica runtime")
 * faceva comparire "Richiede attenzione" anche con tutte le automazioni sane.
 * Le due sezioni devono restare indipendenti: questa funzione prende in input
 * SOLO l'elenco dei job (nessun dato operational), quindi non puo' per
 * costruzione essere influenzata da segnali operativi.
 */
export type AutomationJobHealthStatus = "healthy" | "info" | "warning" | "critical" | "disabled" | "unknown";
export type AutomationOverallLevel = "healthy" | "attention" | "critical";

export function computeAutomationHealthLevel(
  jobs: readonly { health: AutomationJobHealthStatus }[],
): AutomationOverallLevel {
  if (jobs.some((j) => j.health === "critical")) return "critical";
  if (jobs.some((j) => j.health === "warning")) return "attention";
  return "healthy";
}
