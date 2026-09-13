/**
 * Disaster Recovery V4 — copia off-provider dei bucket Supabase Storage
 * importanti su Cloudflare R2 (Layer 6/7, additivo — NON sostituisce DR V2
 * JSON o DR V3 PostgreSQL).
 *
 * Questo modulo contiene SOLO funzioni pure e costanti: nessun accesso a
 * rete, nessuna chiamata a Supabase/R2. L'orchestrazione (list Supabase,
 * download, upload R2, HeadObject, retention, report) vive in
 * `scripts/storage-backup.mjs`, che importa da qui — stesso pattern di
 * `lib/server/postgres-backup.ts`.
 *
 * Bucket coperti (decisione DR V4, 2026-09-13):
 *   - vehicle-documents      (Tier A — obbligatorio, non rigenerabile)
 *   - vehicle-damage-photos  (Tier B — consigliato, non rigenerabile)
 *   - service-photos         (Tier B — consigliato, VERSIONATO: alcuni oggetti
 *                              vengono caricati con upsert:true lato app, quindi
 *                              un mirror 1:1 perderebbe lo storico. Ogni upload
 *                              nuovo/modificato va in una cartella storica per
 *                              run, MAI sovrascrivendo una versione precedente.)
 * Esclusi deliberatamente:
 *   - bus-qr-codes  (Tier C, rigenerabile in codice dai dati di prenotazione)
 *   - backups       (già protetto da DR V2 — Supabase Storage + R2 "production/")
 */

// ─── Configurazione bucket ──────────────────────────────────────────────────

export type StorageTier = "A" | "B";

export type StorageBucketDrConfig = {
  bucket: string;
  tier: StorageTier;
  /** Giorni di retention R2 per questo bucket (vedi selectExpiredHistoryVersions per i versionati). */
  retentionDays: number;
  /**
   * true = NON e' un mirror 1:1: ogni upload nuovo/modificato genera una
   * nuova chiave storica (production/storage/<bucket>/history/<run_id>/<path>),
   * mai una sovrascrittura. Necessario per bucket dove l'app stessa fa
   * upsert:true (la versione precedente lato Supabase sparisce, quindi
   * l'unica copia storica possibile e' quella offsite).
   */
  versioned: boolean;
};

/** Ordine stabile: Tier A prima (usato anche per determinare severita' run). */
export const STORAGE_BACKUP_BUCKETS: readonly StorageBucketDrConfig[] = [
  { bucket: "vehicle-documents", tier: "A", retentionDays: 365, versioned: false },
  { bucket: "vehicle-damage-photos", tier: "B", retentionDays: 180, versioned: false },
  { bucket: "service-photos", tier: "B", retentionDays: 180, versioned: true },
];

export const STORAGE_BACKUP_R2_PREFIX = "production/storage";
export const STORAGE_BACKUP_MANIFEST_PREFIX = "production/storage/manifests";

export const STORAGE_BACKUP_REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
] as const;

export function missingStorageBackupEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return STORAGE_BACKUP_REQUIRED_ENV.filter((key) => !(env[key] ?? "").trim());
}

export function getStorageBucketDrConfig(bucket: string): StorageBucketDrConfig | null {
  return STORAGE_BACKUP_BUCKETS.find((b) => b.bucket === bucket) ?? null;
}

// ─── Path / chiavi R2 ───────────────────────────────────────────────────────

/**
 * Valida un path sorgente Supabase Storage prima di usarlo per costruire una
 * chiave R2. Rifiuta (ritorna null) invece di "correggere silenziosamente":
 * un path fuori norma qui indica dati inattesi dalla listing API, meglio
 * saltare l'oggetto e riportarlo come errore che scrivere una chiave sbagliata.
 * Blocca: path vuoto, path assoluto, segmenti ".."/".", backslash (mai atteso
 * da Supabase Storage, tipico di un path-traversal costruito a mano).
 */
export function sanitizeSourcePath(path: string): string | null {
  if (typeof path !== "string") return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  if (trimmed.includes("\\")) return null;
  const segments = trimmed.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return trimmed;
}

/** production/storage/<bucket>/<sourcePath> — mirror 1:1 (bucket non versionati). */
export function buildMirrorR2Key(bucket: string, sourcePath: string): string {
  return `${STORAGE_BACKUP_R2_PREFIX}/${bucket}/${sourcePath}`;
}

/** production/storage/<bucket>/history/<runId>/<sourcePath> — copia storica (bucket versionati). */
export function buildHistoryR2Key(bucket: string, runId: string, sourcePath: string): string {
  return `${STORAGE_BACKUP_R2_PREFIX}/${bucket}/history/${runId}/${sourcePath}`;
}

/** production/storage/manifests/<runId>.json */
export function buildManifestR2Key(runId: string): string {
  return `${STORAGE_BACKUP_MANIFEST_PREFIX}/${runId}.json`;
}

/**
 * Ricava run_id + source_path originale da una chiave storica R2 — usato
 * dalla retention, che scansiona TUTTE le versioni di TUTTI i run insieme
 * (quindi non conosce il run_id in anticipo, a differenza di buildHistoryR2Key
 * che lo riceve per costruire una chiave in avanti). Ritorna null se la
 * chiave non rispetta il formato atteso — difensivo, mai un crash su una
 * chiave inattesa trovata a runtime nel bucket R2.
 */
export function parseHistoryKey(bucket: string, key: string): { runId: string; originalPath: string } | null {
  const prefix = `${STORAGE_BACKUP_R2_PREFIX}/${bucket}/history/`;
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) return null;
  const runId = rest.slice(0, slashIdx);
  const originalPath = rest.slice(slashIdx + 1);
  if (!originalPath) return null;
  return { runId, originalPath };
}

// ─── Discovery ricorsiva (Supabase Storage list() è a un livello per volta) ─

export type StorageListEntry = {
  name: string;
  /** null = cartella (Supabase la elenca come entry senza id/metadata). */
  id: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  metadata?: { size?: number; eTag?: string; mimetype?: string } | null;
};

export type StorageObjectInfo = {
  /** Path completo relativo alla radice del bucket. */
  path: string;
  size: number;
  updatedAt: string | null;
  etag: string | null;
};

/** Pagina di listing iniettabile: (path-cartella, offset) -> entries. Reale = chiamata Supabase; test = fixture in-memory. */
export type ListPageFn = (folderPath: string, offset: number) => Promise<StorageListEntry[]>;

/**
 * Cammina ricorsivamente l'albero di un bucket Storage a partire dalla radice,
 * paginando ogni livello (Supabase limita le entries per chiamata). Pura
 * rispetto alla rete: riceve `listPage` iniettato, quindi testabile con una
 * fixture senza mockare l'intero client Supabase.
 */
export async function walkStorageObjects(listPage: ListPageFn, pageSize = 1000): Promise<StorageObjectInfo[]> {
  const results: StorageObjectInfo[] = [];

  async function walk(folderPath: string): Promise<void> {
    let offset = 0;
    for (;;) {
      const page = await listPage(folderPath, offset);
      for (const entry of page) {
        const childPath = folderPath ? `${folderPath}/${entry.name}` : entry.name;
        if (entry.id === null) {
          // Cartella: Supabase non annida le sotto-cartelle nella stessa risposta.
          await walk(childPath);
        } else {
          results.push({
            path: childPath,
            size: typeof entry.metadata?.size === "number" ? entry.metadata.size : 0,
            updatedAt: entry.updated_at ?? null,
            etag: entry.metadata?.eTag ?? null,
          });
        }
      }
      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }

  await walk("");
  return results;
}

// ─── Backup incrementale ────────────────────────────────────────────────────

/** Stato dell'ultimo run riuscito per un path, letto dal manifest precedente. */
export type PriorObjectState = { size: number; updatedAt: string | null; etag: string | null };
export type PriorBackupState = Record<string, PriorObjectState>;

export type IncrementalAction = "upload" | "skip";
export type IncrementalDecision = {
  path: string;
  action: IncrementalAction;
  reason:
    | "new"
    | "etag_changed"
    | "updated_at_changed"
    | "size_changed"
    | "unchanged"
    | "no_reliable_signal_fallback_upload";
};

/**
 * Decide quali oggetti caricare in questo run. Segnali in ordine di
 * affidabilità: eTag > updated_at > size. Se NESSUno dei tre è disponibile per
 * un oggetto (mai osservato con Supabase Storage in pratica, ma possibile in
 * teoria) il fallback è SEMPRE upload — mai skip per incertezza (FASE 4:
 * "se non esiste un modo affidabile, usa fallback sicuro e documentato").
 */
export function planIncrementalBackup(
  objects: readonly StorageObjectInfo[],
  prior: PriorBackupState,
): IncrementalDecision[] {
  return objects.map((obj) => {
    const prev = prior[obj.path];
    if (!prev) return { path: obj.path, action: "upload", reason: "new" };

    if (obj.etag != null && prev.etag != null) {
      return obj.etag !== prev.etag
        ? { path: obj.path, action: "upload", reason: "etag_changed" }
        : { path: obj.path, action: "skip", reason: "unchanged" };
    }
    if (obj.updatedAt != null && prev.updatedAt != null) {
      return obj.updatedAt !== prev.updatedAt
        ? { path: obj.path, action: "upload", reason: "updated_at_changed" }
        : { path: obj.path, action: "skip", reason: "unchanged" };
    }
    if (obj.size !== prev.size) {
      return { path: obj.path, action: "upload", reason: "size_changed" };
    }
    // Nessun segnale affidabile disponibile per confermare "invariato" — fallback sicuro.
    if (obj.etag == null && obj.updatedAt == null) {
      return { path: obj.path, action: "upload", reason: "no_reliable_signal_fallback_upload" };
    }
    return { path: obj.path, action: "skip", reason: "unchanged" };
  });
}

/**
 * Riepilogo dry-run per un bucket: cosa VERREBBE caricato, senza I/O di
 * alcun tipo — la firma stessa (nessun client Supabase/R2 iniettato) è la
 * prova che questo calcolo non può avere effetti collaterali. Usata da
 * scripts/storage-backup.mjs quando `--dry-run` è attivo, al posto del vero
 * ciclo di download/upload.
 */
export type DryRunBucketSummary = {
  file_count: number;
  would_upload_count: number;
  would_skip_count: number;
  total_bytes: number;
};

export function planDryRunBucketSummary(
  objects: readonly StorageObjectInfo[],
  prior: PriorBackupState,
): DryRunBucketSummary {
  const plan = planIncrementalBackup(objects, prior);
  const planByPath = new Map(plan.map((p) => [p.path, p]));
  let wouldUpload = 0;
  let wouldSkip = 0;
  let totalBytes = 0;
  for (const obj of objects) {
    totalBytes += obj.size;
    if (planByPath.get(obj.path)?.action === "upload") wouldUpload += 1;
    else wouldSkip += 1;
  }
  return { file_count: objects.length, would_upload_count: wouldUpload, would_skip_count: wouldSkip, total_bytes: totalBytes };
}

// ─── Verifica upload ────────────────────────────────────────────────────────

/** Un upload è "verified" solo se l'oggetto esiste su R2 (HeadObject riuscito) E la size coincide. */
export function verifyUpload(expectedSize: number, headContentLength: number | null | undefined): boolean {
  return typeof headContentLength === "number" && headContentLength === expectedSize;
}

// ─── Manifest ───────────────────────────────────────────────────────────────

export type StorageBackupObjectStatus = "uploaded" | "skipped" | "failed";

export type StorageBackupObjectEntry = {
  source_path: string;
  r2_key: string;
  size: number;
  /** eTag Supabase Storage dell'oggetto sorgente, quando disponibile — usato anche come segnale di diff incrementale del prossimo run. */
  checksum: string | null;
  /** updated_at Supabase Storage dell'oggetto sorgente — secondo segnale di diff incrementale (fallback se manca l'eTag). */
  updated_at: string | null;
  status: StorageBackupObjectStatus;
};

/** Costruisce lo stato "prior" per planIncrementalBackup a partire dagli oggetti di un manifest precedente (letto da production/storage/manifests/latest.json). */
export function priorStateFromManifestObjects(
  objects: readonly Pick<StorageBackupObjectEntry, "source_path" | "size" | "checksum" | "updated_at" | "status">[],
): PriorBackupState {
  const state: PriorBackupState = {};
  for (const o of objects) {
    if (o.status === "failed") continue; // un oggetto fallito non e' uno stato "noto buono" da confrontare
    state[o.source_path] = { size: o.size, updatedAt: o.updated_at, etag: o.checksum };
  }
  return state;
}

export type StorageBucketRunStatus = "success" | "warning" | "failed";

export type StorageBackupBucketResult = {
  bucket: string;
  tier: StorageTier;
  /** "failed" SOLO se il bucket non è stato enumerabile affatto (list() fallita) — "non backuppato". */
  status: StorageBucketRunStatus;
  file_count: number;
  uploaded_count: number;
  skipped_count: number;
  failed_count: number;
  total_bytes: number;
  errors: string[];
  objects: StorageBackupObjectEntry[];
};

export type StorageBackupManifest = {
  run_id: string;
  timestamp: string;
  dry_run: boolean;
  buckets: StorageBackupBucketResult[];
  totals: {
    file_count: number;
    uploaded_count: number;
    skipped_count: number;
    failed_count: number;
    total_bytes: number;
  };
};

export function buildStorageBackupManifest(input: {
  runId: string;
  now: Date;
  dryRun: boolean;
  buckets: readonly StorageBackupBucketResult[];
}): StorageBackupManifest {
  const totals = input.buckets.reduce(
    (acc, b) => ({
      file_count: acc.file_count + b.file_count,
      uploaded_count: acc.uploaded_count + b.uploaded_count,
      skipped_count: acc.skipped_count + b.skipped_count,
      failed_count: acc.failed_count + b.failed_count,
      total_bytes: acc.total_bytes + b.total_bytes,
    }),
    { file_count: 0, uploaded_count: 0, skipped_count: 0, failed_count: 0, total_bytes: 0 },
  );

  return {
    run_id: input.runId,
    timestamp: input.now.toISOString(),
    dry_run: input.dryRun,
    buckets: input.buckets.slice(),
    totals,
  };
}

/**
 * Severità dell'intero run, decisa dai risultati per-bucket:
 *  - "failed":  almeno un bucket Tier A non è stato enumerabile ("non
 *               backuppato") — es. errore credenziali/lettura Supabase.
 *               Mappato a `critical` lato health (criticalConsecutiveFailures
 *               = 1 per questo job, vedi job-health-config.ts).
 *  - "warning": nessun Tier A "failed", ma almeno un bucket (A o B) ha
 *               file falliti/parziali, o un bucket Tier B è "failed" del
 *               tutto ("bucket opzionale fallito").
 *  - "success": tutti i bucket "success".
 */
export function classifyStorageBackupRunStatus(
  buckets: readonly Pick<StorageBackupBucketResult, "tier" | "status">[],
): StorageBucketRunStatus {
  if (buckets.some((b) => b.tier === "A" && b.status === "failed")) return "failed";
  if (buckets.some((b) => b.status !== "success")) return "warning";
  return "success";
}

// ─── Retention (solo bucket versionati — un bucket mirror 1:1 non accumula
//     versioni da potare: la stessa chiave viene semplicemente sovrascritta) ─

export type HistoryVersionObject = {
  r2Key: string;
  originalPath: string;
  lastModified: Date;
};

/**
 * Tra le versioni storiche di un bucket versionato, seleziona quelle scadute
 * (piu' vecchie di retentionDays) SENZA MAI marcare come scaduta la versione
 * più recente per un dato originalPath — anche se più vecchia della
 * retention (stesso principio di selectExpiredBackupSets in postgres-backup.ts:
 * l'ultimo set utile non viene mai eliminato).
 */
export function selectExpiredHistoryVersions(
  versions: readonly HistoryVersionObject[],
  now: Date,
  retentionDays: number,
): { keep: HistoryVersionObject[]; expire: HistoryVersionObject[] } {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const byPath = new Map<string, HistoryVersionObject[]>();
  for (const v of versions) {
    const list = byPath.get(v.originalPath) ?? [];
    list.push(v);
    byPath.set(v.originalPath, list);
  }

  const keep: HistoryVersionObject[] = [];
  const expire: HistoryVersionObject[] = [];
  for (const list of byPath.values()) {
    const sorted = [...list].sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    const [newest, ...rest] = sorted;
    if (newest) keep.push(newest);
    for (const v of rest) {
      if (v.lastModified.getTime() < cutoff.getTime()) expire.push(v);
      else keep.push(v);
    }
  }
  return { keep, expire };
}

// ─── Redazione segreti (log) ────────────────────────────────────────────────

/** Redazione minimale per i log dello script — mai stampare secret/URL firmati/contenuto file. */
export function redactStorageSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = String(text ?? "");
  for (const s of secrets) {
    const v = (s ?? "").trim();
    if (v.length >= 4) out = out.split(v).join("[redacted]");
  }
  return out;
}
