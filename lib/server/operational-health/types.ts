/**
 * Tipi condivisi per gli Operational Health Signals (Sprint 3).
 *
 * Distinzione dal Job Health (lib/server/job-health-evaluator.ts):
 * - Job Health risponde "il processo automatico ha funzionato?" (execution
 *   status di system_job_runs -> health status per job).
 * - Operational Health risponde "il risultato operativo prodotto e' sano?"
 *   (es. backup creato ma file non valido, biglietto emesso ma consegna
 *   fallita, servizio imminente senza autista). Read-only, calcolato a
 *   runtime sopra dati gia' esistenti — nessuna nuova tabella in questo
 *   sprint.
 */

export type OperationalHealthArea = "backup" | "medmar" | "email" | "operations";

export type OperationalHealthSeverity = "info" | "warning" | "critical";

export type OperationalHealthSignal = {
  /** Stabile per una stessa condizione (es. "backup:missing_table:services") — usabile come React key. */
  key: string;
  area: OperationalHealthArea;
  severity: OperationalHealthSeverity;
  title: string;
  /** Messaggio operatore, mai un errore tecnico grezzo/dato sensibile — vedi privacy nei singoli reader. */
  message: string;
  detectedAt: string;
  /** Identificatore sintetico (numero pratica, id delivery attempt, ecc.) — mai email/telefono/token. */
  entityId?: string;
  metadata?: Record<string, unknown>;
};

export type OperationalHealthAreaResult = {
  area: OperationalHealthArea;
  /** false se il reader e' fallito (failure isolation): l'area resta "non disponibile", non fa fallire le altre. */
  available: boolean;
  /** Solo quando available=false — messaggio sintetico, mai lo stack/errore Supabase grezzo. */
  error?: string;
  signals: OperationalHealthSignal[];
};

export type OperationalHealthSummaryCounts = { info: number; warning: number; critical: number };

export type OperationalHealthReport = {
  generated_at: string;
  summary: OperationalHealthSummaryCounts;
  areas: OperationalHealthAreaResult[];
  /** Tutti i segnali di tutte le aree, ordinati critical -> warning -> info. */
  signals: OperationalHealthSignal[];
};

const SEVERITY_RANK: Record<OperationalHealthSeverity, number> = { critical: 0, warning: 1, info: 2 };

export type OverallHealthStatus = "healthy" | "attention" | "critical";

/**
 * Pura — combina lo stato generale Job Health (system_job_runs, Sprint 2:
 * "il processo automatico ha funzionato?") con l'Operational Health di
 * questo sprint ("il risultato prodotto e' sano?"). Un critical in una
 * qualsiasi delle due dimensioni basta a portare lo stato generale ITS a
 * critical, anche se l'altra dimensione e' interamente sana — vedi spec
 * sprint: "Job Health tutto sano + 1 servizio critical -> stato generale
 * ITS = critical".
 */
export function combineOverallHealth(
  jobOverall: OverallHealthStatus,
  operationalSummary: OperationalHealthSummaryCounts
): OverallHealthStatus {
  if (jobOverall === "critical" || operationalSummary.critical > 0) return "critical";
  if (jobOverall === "attention" || operationalSummary.warning > 0) return "attention";
  return "healthy";
}

/**
 * Pura: combina i risultati delle 4 aree gia' letti (nessun accesso DB qui),
 * stesso pattern di job-health-evaluator.ts — testabile con dati fissi.
 */
export function aggregateOperationalHealth(
  areas: readonly OperationalHealthAreaResult[],
  generatedAt: string
): OperationalHealthReport {
  const signals = areas
    .flatMap((a) => a.signals)
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.detectedAt.localeCompare(b.detectedAt));

  const summary: OperationalHealthSummaryCounts = { info: 0, warning: 0, critical: 0 };
  for (const s of signals) summary[s.severity] += 1;

  return {
    generated_at: generatedAt,
    summary,
    areas: areas.slice(),
    signals,
  };
}
