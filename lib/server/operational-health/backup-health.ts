/**
 * Operational Health — Backup verificabile (Sprint 3, area "backup").
 *
 * Job Health (job-health-config.ts, jobKey "backup") sa gia' se il cron ha
 * COMPLETATO l'esecuzione. Questo modulo verifica invece se l'ULTIMO file
 * prodotto e' strutturalmente utilizzabile: file presente, leggibile, JSON
 * valido, struttura root valida, tabelle attese presenti, nessuna tabella
 * corrotta. Mai un restore, mai una scrittura, mai un database temporaneo.
 *
 * L'elenco TABLES qui sotto rispecchia deliberatamente (duplicato, non
 * importato) la costante TABLES di app/api/cron/backup/route.ts: quel file
 * e' un Next.js route handler (app router), che non puo' esportare altri
 * simboli oltre ai metodi HTTP/route config senza violare le convenzioni di
 * Next — e la scrittura del backup e' esplicitamente fuori perimetro per
 * questo sprint (NON modificare il backup writer). Se l'elenco tabelle del
 * writer cambia, aggiornare anche qui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { OperationalHealthAreaResult, OperationalHealthSignal } from "./types";

export const BACKUP_EXPECTED_TABLES = [
  "services",
  "hotels",
  "memberships",
  "agencies",
  "assignments",
  "vehicles",
  "pricing_rules",
  "price_lists",
  "agency_invoices",
  "tenants",
  "trip_groups",
  "driver_profiles",
] as const;

const BUCKET = "backups";
const FILENAME_RE = /^backup_(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Oltre questa dimensione, il file non viene scaricato per la verifica
 * strutturale (solo esistenza/dimensione da storage.list, gia' disponibili
 * senza download) — "senza download eccessivo" per requisito sprint.
 */
export const BACKUP_MAX_VERIFY_BYTES = 15 * 1024 * 1024;

type BackupFileMeta = { name: string; size_bytes: number };

export type BackupPayloadShape = {
  generated_at?: unknown;
  tables?: unknown;
  row_counts?: unknown;
  errors?: unknown;
  data?: unknown;
};

/**
 * Pura — verifica strutturale del payload gia' parsato (JSON.parse fatto dal
 * caller, cosi' un errore di parsing resta un caso a parte e distinto).
 * Non valuta MAI il numero di righe come anomalia (tabella vuota legittima
 * = non anomaly), solo forma/presenza.
 */
export function evaluateBackupPayload(
  payload: unknown,
  opts: { filename: string; detectedAt: string; expectedTables?: readonly string[] }
): OperationalHealthSignal[] {
  const expectedTables = opts.expectedTables ?? BACKUP_EXPECTED_TABLES;
  const signals: OperationalHealthSignal[] = [];

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return [
      {
        key: "backup:invalid_root",
        area: "backup",
        severity: "critical",
        title: "Backup con struttura non valida",
        message: `Il file ${opts.filename} non ha una struttura root valida (atteso un oggetto JSON).`,
        detectedAt: opts.detectedAt,
        entityId: opts.filename,
      },
    ];
  }

  const shape = payload as BackupPayloadShape;
  const data = shape.data;

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [
      {
        key: "backup:missing_data_section",
        area: "backup",
        severity: "critical",
        title: "Backup senza sezione dati",
        message: `Il file ${opts.filename} non contiene una sezione "data" valida.`,
        detectedAt: opts.detectedAt,
        entityId: opts.filename,
      },
    ];
  }

  const dataRecord = data as Record<string, unknown>;
  const missingTables: string[] = [];
  const corruptTables: string[] = [];

  for (const table of expectedTables) {
    if (!(table in dataRecord)) {
      missingTables.push(table);
      continue;
    }
    if (!Array.isArray(dataRecord[table])) {
      corruptTables.push(table);
    }
  }

  if (missingTables.length > 0) {
    signals.push({
      key: "backup:missing_tables",
      area: "backup",
      severity: "critical",
      title: "Tabelle attese mancanti nel backup",
      message: `${missingTables.length} tabelle attese mancano dal backup ${opts.filename}: ${missingTables.join(", ")}.`,
      detectedAt: opts.detectedAt,
      entityId: opts.filename,
      metadata: { missing_tables: missingTables },
    });
  }

  if (corruptTables.length > 0) {
    signals.push({
      key: "backup:corrupt_tables",
      area: "backup",
      severity: "critical",
      title: "Tabelle con struttura non valida nel backup",
      message: `${corruptTables.length} tabelle nel backup ${opts.filename} non hanno la struttura attesa (elenco righe): ${corruptTables.join(", ")}.`,
      detectedAt: opts.detectedAt,
      entityId: opts.filename,
      metadata: { corrupt_tables: corruptTables },
    });
  }

  if (typeof shape.generated_at !== "string" || shape.generated_at.length === 0) {
    signals.push({
      key: "backup:missing_metadata",
      area: "backup",
      severity: "warning",
      title: "Backup senza metadata di generazione",
      message: `Il file ${opts.filename} non riporta un timestamp "generated_at" — verifica non conclusiva.`,
      detectedAt: opts.detectedAt,
      entityId: opts.filename,
    });
  }

  const errors = Array.isArray(shape.errors) ? shape.errors : [];
  if (errors.length > 0 && missingTables.length === 0 && corruptTables.length === 0) {
    signals.push({
      key: "backup:export_errors_recorded",
      area: "backup",
      severity: "warning",
      title: "Errori di esportazione registrati nel backup",
      message: `Il backup ${opts.filename} riporta ${errors.length} errori di esportazione gia' registrati nel file.`,
      detectedAt: opts.detectedAt,
      entityId: opts.filename,
      metadata: { export_errors_count: errors.length },
    });
  }

  return signals;
}

function latestBackupFile(files: readonly BackupFileMeta[]): BackupFileMeta | null {
  const matched = files.filter((f) => FILENAME_RE.test(f.name));
  if (matched.length === 0) return null;
  return matched.slice().sort((a, b) => b.name.localeCompare(a.name))[0]!;
}

/**
 * I/O — elenca i backup (nessun download qui), scarica solo l'ultimo se
 * sotto la soglia di dimensione, e delega la verifica strutturale a
 * evaluateBackupPayload. Non effettua MAI un restore, non scrive dati.
 */
export async function readBackupOperationalHealth(
  admin: SupabaseClient,
  now: Date
): Promise<OperationalHealthAreaResult> {
  const detectedAt = now.toISOString();

  const { data: files, error: listError } = await admin.storage
    .from(BUCKET)
    .list("", { limit: 200, sortBy: { column: "name", order: "desc" } });

  if (listError) {
    return { area: "backup", available: false, error: "Elenco backup non disponibile.", signals: [] };
  }

  const latest = latestBackupFile(
    (files ?? []).map((f) => ({ name: f.name, size_bytes: f.metadata?.size ?? 0 }))
  );

  if (!latest) {
    return {
      area: "backup",
      available: true,
      signals: [
        {
          key: "backup:missing_file",
          area: "backup",
          severity: "critical",
          title: "Nessun backup trovato",
          message: "Nessun file di backup trovato nello storage.",
          detectedAt,
        },
      ],
    };
  }

  if (latest.size_bytes > BACKUP_MAX_VERIFY_BYTES) {
    return {
      area: "backup",
      available: true,
      signals: [
        {
          key: "backup:too_large_to_verify",
          area: "backup",
          severity: "warning",
          title: "Backup troppo grande per la verifica strutturale",
          message: `Il backup ${latest.name} (${Math.round(latest.size_bytes / (1024 * 1024))} MB) supera la soglia di verifica runtime: solo esistenza e dimensione controllate.`,
          detectedAt,
          entityId: latest.name,
          metadata: { size_bytes: latest.size_bytes },
        },
      ],
    };
  }

  const { data: blob, error: downloadError } = await admin.storage.from(BUCKET).download(latest.name);
  if (downloadError || !blob) {
    return {
      area: "backup",
      available: true,
      signals: [
        {
          key: "backup:unreadable_file",
          area: "backup",
          severity: "critical",
          title: "Backup illeggibile",
          message: `Il file di backup ${latest.name} non e' leggibile dallo storage.`,
          detectedAt,
          entityId: latest.name,
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    const text = await blob.text();
    parsed = JSON.parse(text);
  } catch {
    return {
      area: "backup",
      available: true,
      signals: [
        {
          key: "backup:invalid_json",
          area: "backup",
          severity: "critical",
          title: "Backup con JSON non valido",
          message: `Il file di backup ${latest.name} non contiene JSON valido.`,
          detectedAt,
          entityId: latest.name,
        },
      ],
    };
  }

  return {
    area: "backup",
    available: true,
    signals: evaluateBackupPayload(parsed, { filename: latest.name, detectedAt }),
  };
}
