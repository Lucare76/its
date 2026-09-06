/**
 * Configurazione centrale dei job monitorati dal Centro Salute ITS
 * (Sprint 2). Solo dati statici server-side — nessun motore scheduler,
 * nessun CRUD, nessuna UI di modifica soglie in questo sprint. Interpreta
 * soltanto i dati gia' raccolti in `system_job_runs` (Sprint 1).
 *
 * Per abilitare/disabilitare un job in futuro (es. whatsapp-reminders
 * quando tornera' operativo) basta cambiare `enabled` qui — nessuna
 * modifica alla logica centrale (lib/server/job-health-evaluator.ts).
 */

export type JobHealthSeverity = "warning" | "critical";

/**
 * Modalita' di scheduling del job — determina se ha senso applicare un
 * concetto di "finestra temporale attesa" (staleness):
 * - "scheduled": gira a cadenza prevedibile (es. cron notturno). Ha senso
 *   valutare "nessun successo entro la finestra prevista".
 * - "event-driven": gira SOLO come conseguenza di un altro flusso operativo
 *   (es. poll-emails, oggi innescato da flussi Medmar/emissione biglietti,
 *   non da un cron a intervalli fissi). NESSUNA aspettativa temporale: non
 *   deve mai risultare stale/in ritardo solo perche' non e' girato da ore o
 *   giorni — valuta normalmente solo i run che avvengono davvero.
 * - "disabled": non in uso operativamente, mai un'anomalia.
 */
export type JobHealthSchedulingMode = "scheduled" | "event-driven" | "disabled";

export type JobHealthRuleConfig = {
  jobKey: string;
  jobName: string;
  /** Se false: il job non contribuisce mai ad anomalie/stato generale/alert (vedi job-health-evaluator.ts). Sempre coerente con schedulingMode !== "disabled". */
  enabled: boolean;
  schedulingMode: JobHealthSchedulingMode;
  expectedCadence: "daily" | "every-15-minutes" | "none";
  /** Etichetta italiana per la UI, es. "Ogni giorno alle 02:00" oppure "Event-driven, nessuna cadenza fissa". */
  cadenceLabel: string;
  /**
   * Oltre quanti minuti dall'ultimo successo il job e' considerato "stale"
   * (nessun successo entro la finestra prevista). Applicabile SOLO se
   * schedulingMode === "scheduled" — per i job "event-driven" questo campo
   * resta assente (undefined), non un valore fittizio come 0: l'evaluator
   * salta del tutto la valutazione di staleness quando manca.
   */
  staleAfterMinutes?: number;
  /** Oltre quanti minuti un run 'running' e' considerato bloccato. Si applica sempre, indipendentemente dallo schedulingMode. */
  maxRunningMinutes: number;
  /** Da quante esecuzioni fallite consecutive in poi lo stato diventa critical. Si applica sempre. */
  criticalConsecutiveFailures: number;
  /** Severita' quando il job e' abilitato, la finestra attesa e' superata, ma non esiste ANCORA nessun run (vedi firstExpectedAt). Rilevante solo se firstExpectedAt e' impostato. */
  missingRunSeverity: JobHealthSeverity;
  /** Severita' quando il job e' stale (aveva gia' girato prima, ma l'ultimo successo e' troppo vecchio). Rilevante solo se staleAfterMinutes e' impostato. */
  staleSeverity?: JobHealthSeverity;
  /**
   * ISO opzionale: da quando ci si aspetta che il job abbia GIA' prodotto
   * almeno un run. Senza questo campo un job mai eseguito resta sempre
   * "unknown" (nessuna finestra nota da confrontare) — mai un falso
   * warning/critical inventato. Non impostato per i job reali di questo
   * sprint (hanno gia' storico); usato per testare il ramo "finestra
   * superata + nessun run". Non ha senso per job "event-driven" (nessuna
   * finestra attesa esiste) e infatti non e' mai impostato per loro.
   */
  firstExpectedAt?: string;
};

export const JOB_HEALTH_CONFIG: Record<string, JobHealthRuleConfig> = {
  backup: {
    jobKey: "backup",
    jobName: "Backup automatico",
    enabled: true,
    schedulingMode: "scheduled",
    expectedCadence: "daily",
    cadenceLabel: "Ogni giorno alle 02:00",
    // 24h di cadenza + margine per orari cron/hosting variabili.
    staleAfterMinutes: 26 * 60,
    // maxDuration Vercel della route e' 300s: 15' e' gia' ampiamente oltre un run normale.
    maxRunningMinutes: 15,
    criticalConsecutiveFailures: 3,
    missingRunSeverity: "warning",
    staleSeverity: "critical",
  },
  "poll-emails": {
    jobKey: "poll-emails",
    jobName: "Polling email",
    enabled: true,
    // Event-driven nella realta' operativa: NON gira a cadenza fissa, parte
    // solo come conseguenza di un altro flusso (Medmar / emissione
    // biglietti). Nessuna finestra temporale attesa: staleAfterMinutes resta
    // deliberatamente assente (mai un valore fittizio come 0) e l'evaluator
    // salta del tutto la valutazione di staleness per questo job — vedi
    // job-health-evaluator.ts. Non deve MAI risultare "atteso ma non
    // rilevato" solo perche' non e' girato da ore o giorni.
    schedulingMode: "event-driven",
    expectedCadence: "none",
    cadenceLabel: "Event-driven — eseguito da flussi Medmar/emissione biglietti, nessuna cadenza fissa",
    maxRunningMinutes: 10,
    criticalConsecutiveFailures: 3,
    missingRunSeverity: "warning",
  },
  "postgres-backup": {
    jobKey: "postgres-backup",
    jobName: "Backup PostgreSQL completo (DR V3)",
    // Layer 4/5 del Disaster Recovery: pg_dump -Fc completo + copia su
    // Cloudflare R2 (production/postgres/). Gira su GitHub Actions
    // (.github/workflows/postgres-backup.yml), NON su Vercel. L'esito viene
    // riportato a POST /api/cron/postgres-backup-report che scrive qui.
    // Job DISTINTO da "backup" (snapshot JSON): un JSON verde non deve mai
    // mascherare un pg_dump fallito.
    enabled: true,
    schedulingMode: "scheduled",
    expectedCadence: "daily",
    cadenceLabel: "Ogni giorno alle 02:30 UTC (GitHub Actions)",
    // 24h di cadenza + margine ampio per code dei runner GitHub / manutenzione.
    staleAfterMinutes: 30 * 60,
    // timeout workflow 30' + margine per il reporting.
    maxRunningMinutes: 45,
    // Il DR completo e' critico: 2 esecuzioni KO consecutive -> critical.
    criticalConsecutiveFailures: 2,
    missingRunSeverity: "warning",
    staleSeverity: "critical",
  },
  "whatsapp-reminders": {
    jobKey: "whatsapp-reminders",
    jobName: "Promemoria WhatsApp",
    // NON in uso operativamente: nessun cron in vercel.json lo schedula.
    // Presente tecnicamente (codice + job_key gia' esistenti) ma disattivo
    // per interpretazione health — riabilitabile cambiando solo questo flag.
    enabled: false,
    schedulingMode: "disabled",
    expectedCadence: "none",
    cadenceLabel: "Non in uso",
    maxRunningMinutes: 30,
    criticalConsecutiveFailures: 3,
    missingRunSeverity: "warning",
    staleSeverity: "warning",
  },
};

export const JOB_HEALTH_KEYS = Object.keys(JOB_HEALTH_CONFIG);

export function getJobHealthConfig(jobKey: string): JobHealthRuleConfig | null {
  return JOB_HEALTH_CONFIG[jobKey] ?? null;
}
