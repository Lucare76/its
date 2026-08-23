/**
 * Health snapshot condiviso per MCP (Sprint 5) — NON un tool, nessuna
 * registrazione nel registry. Compone Job Health + Operational Health
 * ESATTAMENTE come app/api/admin/system-status/route.ts (stessa
 * combineOverallHealth, stessi helper job-health-evaluator.ts /
 * job-health.ts / job-health-config.ts, stesso readOperationalHealth):
 * its.get_health_status, its.get_operational_brief e
 * its.get_operational_alerts leggono tutti da qui, cosi' MCP e
 * /settings/system restano garantiti sulla stessa source of truth (vedi
 * spec sprint: "se danno una risposta diversa allo stesso problema, e' un
 * bug").
 *
 * Nessuna regola Health viene reimplementata qui: solo orchestrazione delle
 * chiamate gia' esistenti. Failure isolation: se la composizione fallisce
 * (es. system_job_runs temporaneamente non raggiungibile), ritorna
 * {available:false} invece di propagare — readOperationalHealth ha gia' la
 * propria failure isolation per-area, questo e' un livello ulteriore per
 * l'intera snapshot.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readRecentJobRuns } from "@/lib/server/job-health";
import { JOB_HEALTH_CONFIG, JOB_HEALTH_KEYS } from "@/lib/server/job-health-config";
import {
  evaluateJobHealth,
  computeOverallHealth,
  summarizeJobHealthCounts,
  type JobHealthEvaluation,
  type JobHealthSummaryCounts,
} from "@/lib/server/job-health-evaluator";
import {
  readOperationalHealth,
  combineOverallHealth,
  type OperationalHealthReport,
  type OverallHealthStatus,
} from "@/lib/server/operational-health";

export type ItsHealthSnapshot =
  | {
      available: true;
      generatedAt: string;
      overall: OverallHealthStatus;
      jobHealth: { summary: JobHealthSummaryCounts; evaluations: JobHealthEvaluation[] };
      operationalHealth: OperationalHealthReport;
    }
  | { available: false };

export async function computeItsHealthSnapshot(
  admin: SupabaseClient,
  tenantId: string,
  now: Date = new Date()
): Promise<ItsHealthSnapshot> {
  try {
    const [recentRunsByKey, operationalHealth] = await Promise.all([
      readRecentJobRuns(admin, tenantId, JOB_HEALTH_KEYS),
      readOperationalHealth(admin, tenantId, now),
    ]);

    const evaluations = JOB_HEALTH_KEYS.map((jobKey) =>
      evaluateJobHealth({ config: JOB_HEALTH_CONFIG[jobKey]!, runs: recentRunsByKey[jobKey] ?? [], now })
    );

    const overall = combineOverallHealth(computeOverallHealth(evaluations), operationalHealth.summary);

    return {
      available: true,
      generatedAt: now.toISOString(),
      overall,
      jobHealth: { summary: summarizeJobHealthCounts(evaluations), evaluations },
      operationalHealth,
    };
  } catch {
    return { available: false };
  }
}
