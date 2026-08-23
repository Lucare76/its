/**
 * Operational Health — orchestratore centrale (Sprint 3).
 *
 * Compone le 4 aree (backup, medmar, email, operations) con failure
 * isolation: se una singola area fallisce (eccezione o errore Supabase), le
 * altre 3 restano disponibili — vedi requisito sprint "il fallimento di un
 * reader non abbatte tutto il Centro Salute". Ogni reader di area gestisce
 * gia' da solo i propri errori Supabase (ritornando available:false); questo
 * modulo aggiunge un livello ulteriore con try/catch per coprire anche
 * eccezioni non catturate (es. throw imprevisto).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readBackupOperationalHealth } from "./operational-health/backup-health";
import { readMedmarOperationalHealth } from "./operational-health/medmar-health";
import { readEmailImportOperationalHealth } from "./operational-health/email-import-health";
import { readOperationsOperationalHealth } from "./operational-health/operations-health";
import { aggregateOperationalHealth, type OperationalHealthArea, type OperationalHealthAreaResult, type OperationalHealthReport } from "./operational-health/types";

export { combineOverallHealth } from "./operational-health/types";
export type {
  OperationalHealthArea,
  OperationalHealthAreaResult,
  OperationalHealthReport,
  OperationalHealthSeverity,
  OperationalHealthSignal,
  OperationalHealthSignalAction,
  OperationalHealthSummaryCounts,
  OverallHealthStatus,
} from "./operational-health/types";

const AREA_FALLBACK_MESSAGE: Record<OperationalHealthArea, string> = {
  backup: "Verifica backup temporaneamente non disponibile.",
  medmar: "Salute delivery Medmar temporaneamente non disponibile.",
  email: "Salute import email temporaneamente non disponibile.",
  operations: "Salute assegnazioni servizi temporaneamente non disponibile.",
};

async function settleArea(
  area: OperationalHealthArea,
  task: Promise<OperationalHealthAreaResult>
): Promise<OperationalHealthAreaResult> {
  try {
    return await task;
  } catch (error) {
    console.error(`Operational health area '${area}' failed`, error instanceof Error ? error.message : error);
    return { area, available: false, error: AREA_FALLBACK_MESSAGE[area], signals: [] };
  }
}

/**
 * Legge e aggrega le 4 aree per un tenant. Read-only: nessuna mutazione,
 * nessun nuovo cron, nessuna nuova tabella (read model runtime su dati gia'
 * esistenti).
 */
export async function readOperationalHealth(
  admin: SupabaseClient,
  tenantId: string,
  now: Date = new Date()
): Promise<OperationalHealthReport> {
  const [backup, medmar, email, operations] = await Promise.all([
    settleArea("backup", readBackupOperationalHealth(admin, now)),
    settleArea("medmar", readMedmarOperationalHealth(admin, tenantId, now)),
    settleArea("email", readEmailImportOperationalHealth(admin, tenantId, now)),
    settleArea("operations", readOperationsOperationalHealth(admin, tenantId, now)),
  ]);

  return aggregateOperationalHealth([backup, medmar, email, operations], now.toISOString());
}
