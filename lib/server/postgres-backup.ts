/**
 * Disaster Recovery V3 — backup PostgreSQL logico completo (pg_dump -Fc).
 *
 * Questo modulo contiene SOLO funzioni pure e costanti: nessun accesso a rete,
 * nessuna esecuzione di processi, nessun accesso al filesystem. L'orchestrazione
 * (pg_dump / pg_restore --list / upload R2 / retention) vive in
 * `scripts/postgres-backup.mjs`, che importa da qui — cosi' naming, manifest,
 * hashing, retention, verifica strutturale e redazione dei segreti restano
 * interamente testabili in isolamento (`tests/unit/postgres-backup.test.ts`).
 *
 * Coesiste con — NON sostituisce — i layer esistenti:
 *  - Layer 2: snapshot JSON applicativo   (app/api/cron/backup/route.ts)
 *  - Layer 3: copia JSON offsite su R2    (lib/server/r2-backup.ts, prefix "production/")
 *  - Layer 4: QUESTO — pg_dump -Fc completo
 *  - Layer 5: copia del dump su R2        (prefix "production/postgres/")
 */

import { createHash } from "node:crypto";

/** Prefix R2 dedicato ai dump PostgreSQL. Isolato da "production/" (JSON, Layer 3):
 *  la retention di questo layer non puo' MAI toccare gli snapshot JSON. */
export const PG_BACKUP_R2_PREFIX = "production/postgres";

/** Retention rolling: 30 giorni. L'ultimo backup valido non viene mai eliminato,
 *  anche se piu' vecchio del cutoff (vedi selectExpiredBackupSets). */
export const PG_BACKUP_RETENTION_DAYS = 30;

/** Env richieste dallo script di backup. Nomi allineati a lib/server/r2-backup.ts
 *  (stesse credenziali R2) + la connection string Postgres (Session Pooler URI). */
export const PG_BACKUP_REQUIRED_ENV = [
  "SUPABASE_DB_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
] as const;

// ─── Scope dei dump ───────────────────────────────────────────────────────

/** Dump "full": schema `public` completo (DDL + dati + sequence + indici +
 *  constraint + FK + funzioni/RPC + trigger + viste + policy RLS). */
export const PG_BACKUP_FULL_SCOPE_ARGS = ["--schema=public"] as const;

/**
 * Dump "auth": SOLO le tabelle deliberatamente necessarie a ricreare gli
 * utenti e permettere il login su un progetto Supabase NUOVO.
 *
 * INCLUSE:
 *  - auth.users        (credenziali: encrypted_password bcrypt self-contained)
 *  - auth.identities    (obbligatoria per il login email/password in GoTrue moderno)
 *  - auth.mfa_factors / auth.mfa_amr_claims  (se un utente ha MFA)
 *
 * ESCLUSE apposta (vedi PG_BACKUP_AUTH_EXCLUDED_TABLES): schema_migrations e
 * instances darebbero PK conflict sul progetto nuovo; sessions/refresh_tokens/
 * flow_state/one_time_tokens sono legate al vecchio JWT secret e inutili;
 * audit_log_entries e' solo peso.
 *
 * SSO/SAML: ITS NON usa oggi SSO/SAML. Se verranno introdotti, aggiungere qui
 * auth.sso_providers / auth.sso_domains / auth.saml_providers / auth.saml_relay_states.
 */
export const PG_BACKUP_AUTH_TABLES = [
  "auth.users",
  "auth.identities",
  "auth.mfa_factors",
  "auth.mfa_amr_claims",
] as const;

/** Tabelle dello schema auth deliberatamente NON incluse nel dump (documentario, testato). */
export const PG_BACKUP_AUTH_EXCLUDED_TABLES = [
  "auth.schema_migrations",
  "auth.instances",
  "auth.sessions",
  "auth.refresh_tokens",
  "auth.audit_log_entries",
  "auth.flow_state",
  "auth.one_time_tokens",
] as const;

/** Argomenti pg_dump per il dump auth selettivo (data-only + lista tabelle esplicita). */
export function buildAuthDumpArgs(): string[] {
  return ["--data-only", ...PG_BACKUP_AUTH_TABLES.map((t) => `--table=${t}`)];
}

export type PgBackupArtifactKind = "full" | "auth" | "manifest";

// its_full_2026-09-06_02-30.dump           -> schema public
// its_full_2026-09-06_02-30.auth.dump      -> auth.users + auth.identities (+ mfa) data-only
// its_full_2026-09-06_02-30.manifest.json  -> metadati, hash, esito verifica (nessun segreto/PII)
const BASE_RE = /^its_full_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})$/;
const ARTIFACT_RE = /^its_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(\.auth)?\.dump$|^its_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\.manifest\.json$/;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Base name UTC del set di backup: its_full_YYYY-MM-DD_HH-mm (senza estensione). */
export function buildBackupBaseName(now: Date): string {
  const d = now;
  return `its_full_${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}_${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}`;
}

export function fullDumpFileName(base: string): string {
  return `${base}.dump`;
}
export function authDumpFileName(base: string): string {
  return `${base}.auth.dump`;
}
export function manifestFileName(base: string): string {
  return `${base}.manifest.json`;
}

/** Chiave R2 completa per un file del set (mai una barra iniziale, sempre sotto il prefix). */
export function backupR2Key(fileName: string): string {
  return `${PG_BACKUP_R2_PREFIX}/${fileName}`;
}

/** true se la chiave/nome appartiene a questo layer (prefix + pattern del nome file). */
export function isPgBackupObjectKey(key: string): boolean {
  const name = key.startsWith(`${PG_BACKUP_R2_PREFIX}/`) ? key.slice(PG_BACKUP_R2_PREFIX.length + 1) : null;
  if (name == null) return false;
  return ARTIFACT_RE.test(name);
}

/** Estrae il base name (its_full_DATE_HHMM) da una chiave/nome di artefatto. null se non riconosciuto. */
export function backupSetBaseFromKey(key: string): string | null {
  const name = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
  const m = name.match(/^(its_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2})(?:\.auth)?\.dump$|^(its_full_\d{4}-\d{2}-\d{2}_\d{2}-\d{2})\.manifest\.json$/);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** "YYYY-MM-DD" incorporata nel base name. null se non riconosciuto. */
export function backupDateFromBase(base: string): string | null {
  return base.match(BASE_RE)?.[1] ?? null;
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Compatibilita' versione client/server ────────────────────────────────

/** Estrae il major da una riga tipo "pg_dump (PostgreSQL) 17.2 (...)" oppure "15.8". */
export function parsePgMajorFromVersionLine(versionLine: string | null | undefined): number | null {
  const m = String(versionLine ?? "").match(/(\d+)(?:\.\d+)*/);
  return m ? Number(m[1]) : null;
}

/** Estrae il major da `SHOW server_version_num` (es. "150008" -> 15, "170002" -> 17). */
export function serverMajorFromVersionNum(versionNum: string | number | null | undefined): number | null {
  const n = Number(String(versionNum ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  // >= 10: <major><4-digit patch>. Supabase e' sempre >= 12.
  return Math.floor(n / 10000);
}

/**
 * Regola obbligatoria per un dump affidabile: il client (pg_dump) deve essere
 * major >= del server. Un client piu' recente dump un server piu' vecchio
 * senza problemi; il contrario NO.
 */
export function isClientVersionSufficient(pgDumpMajor: number | null, serverMajor: number | null): boolean {
  if (pgDumpMajor == null || serverMajor == null) return false;
  return pgDumpMajor >= serverMajor;
}

export function versionCompatMessage(pgDumpMajor: number | null, serverMajor: number | null): string {
  if (pgDumpMajor == null) return "pg_dump: versione non rilevabile.";
  if (serverMajor == null) return "server: versione non rilevabile (SHOW server_version_num).";
  return isClientVersionSufficient(pgDumpMajor, serverMajor)
    ? `pg_dump ${pgDumpMajor} >= server ${serverMajor}: OK.`
    : `pg_dump ${pgDumpMajor} < server ${serverMajor}: dump non affidabile. Installare postgresql-client >= ${serverMajor}.`;
}

// ─── Retention ─────────────────────────────────────────────────────────────

export type BackupSet = {
  base: string;
  date: string; // YYYY-MM-DD
  keys: string[]; // tutte le chiavi R2 del set (full/auth/manifest presenti)
};

/** Raggruppa una lista piatta di chiavi R2 in set di backup (base name comune). */
export function groupBackupSets(keys: string[]): BackupSet[] {
  const byBase = new Map<string, string[]>();
  for (const key of keys) {
    if (!isPgBackupObjectKey(key)) continue;
    const base = backupSetBaseFromKey(key);
    if (!base) continue;
    const arr = byBase.get(base) ?? [];
    arr.push(key);
    byBase.set(base, arr);
  }
  const sets: BackupSet[] = [];
  for (const [base, k] of byBase) {
    const date = backupDateFromBase(base);
    if (!date) continue;
    sets.push({ base, date, keys: k.slice().sort() });
  }
  // dal piu' recente al piu' vecchio (il base name e' ordinabile lessicograficamente)
  sets.sort((a, b) => (a.base < b.base ? 1 : a.base > b.base ? -1 : 0));
  return sets;
}

export type RetentionPlan = {
  keep: BackupSet[];
  expire: BackupSet[];
  /** Tutte le chiavi R2 da eliminare (piatte). MAI include il set piu' recente. */
  expiredKeys: string[];
  newestKeptBase: string | null;
};

/**
 * Retention: elimina i set piu' vecchi di `retentionDays` giorni, MA:
 *  - non elimina MAI il set piu' recente (anche se oltre il cutoff);
 *  - opera SOLO su chiavi sotto PG_BACKUP_R2_PREFIX (isPgBackupObjectKey);
 *  - se non c'e' nulla di eliminabile, expiredKeys e' vuoto.
 */
export function selectExpiredBackupSets(keys: string[], now: Date, retentionDays = PG_BACKUP_RETENTION_DAYS): RetentionPlan {
  const sets = groupBackupSets(keys);
  if (sets.length === 0) return { keep: [], expire: [], expiredKeys: [], newestKeptBase: null };

  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  const [newest, ...rest] = sets; // sets[0] = piu' recente
  const keep: BackupSet[] = [newest];
  const expire: BackupSet[] = [];
  for (const set of rest) {
    if (set.date < cutoffIso) expire.push(set);
    else keep.push(set);
  }
  return {
    keep,
    expire,
    expiredKeys: expire.flatMap((s) => s.keys),
    newestKeptBase: newest.base,
  };
}

// ─── Verifica strutturale — PUBLIC dump ───────────────────────────────────

/** Tabelle di controllo: la loro presenza nel TOC del dump public e' un sanity
 *  check minimo (non esaustivo) che il dump non sia vuoto/troncato. */
export const PG_BACKUP_CHECK_TABLES = [
  "tenants",
  "services",
  "assignments",
  "agencies",
  "hotels",
  "memberships",
  "booking_groups",
  "tenant_bus_allocations",
] as const;

/**
 * Esito della verifica strutturale del dump PUBLIC.
 *  - "failed":     problema strutturale reale (TOC vuoto, nessuno schema public,
 *                  tabelle di controllo assenti) -> il dump NON e' utilizzabile,
 *                  il backup e' FAILED.
 *  - "unverified": struttura ok ma manca dal TOC il `CREATE EXTENSION unaccent`.
 *                  NON e' un blocco provato: nessun indice / funzione / vista /
 *                  colonna generata di ITS dipende da `unaccent`. Unica ricorrenza
 *                  nel repo: migrazione 0189 — `CREATE EXTENSION` + un backfill
 *                  dati una-tantum (`INSERT ... SELECT public.unaccent(...)`), che
 *                  NON e' schema e non viene rieseguito al restore. Se la riga
 *                  manca dal TOC basta `CREATE EXTENSION unaccent` a mano sul
 *                  progetto fresco (contrib disponibile su Supabase). Il backup
 *                  resta valido e conservato, ma il job va in `warning`.
 *  - "passed":     tutto presente, unaccent incluso.
 */
export type PgBackupPublicVerification = {
  status: "passed" | "unverified" | "failed";
  pg_restore_list_entries: number;
  has_public_schema: boolean;
  checked_tables_present: string[];
  checked_tables_missing: string[];
  /** true se il TOC contiene `CREATE EXTENSION unaccent` (o un COMMENT su di essa). */
  unaccent_extension_present: boolean;
  notes: string[];
};

/**
 * Detection robusta dell'estensione `unaccent` nel TOC di `pg_restore --list`.
 * Le versioni di pg_dump variano la stringa esatta:
 *   "216; 3079 16816 EXTENSION - unaccent postgres"
 *   "216; 3079 16816 EXTENSION unaccent"
 *   "COMMENT ... EXTENSION unaccent"
 * Regola: una riga che contiene il token EXTENSION E il token unaccent
 * (word-boundary, case-insensitive). Non si fa affidamento sul separatore.
 */
function tocMentionsUnaccentExtension(lines: string[]): boolean {
  return lines.some((l) => /(^|[\s;-])EXTENSION([\s;-]|$)/i.test(l) && /(^|\W)unaccent(\W|$)/i.test(l));
}

/**
 * Interpreta l'output di `pg_restore --list <full.dump>` (custom format).
 *  - "failed":     TOC vuoto, nessuno schema public, o tabelle di controllo
 *                  assenti (dump troncato/vuoto -> inutilizzabile).
 *  - "unverified": struttura ok ma `CREATE EXTENSION unaccent` assente dal TOC
 *                  (non e' un blocco provato — vedi PgBackupPublicVerification).
 *  - "passed":     struttura ok E unaccent presente.
 */
export function verifyRestoreList(listOutput: string): PgBackupPublicVerification {
  const lines = String(listOutput ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(";"));

  const notes: string[] = [];
  const entryCount = lines.length;
  const hasPublicSchema = lines.some((l) => /\bSCHEMA - public\b/.test(l) || /\bpublic\b/.test(l));

  const present: string[] = [];
  const missing: string[] = [];
  for (const table of PG_BACKUP_CHECK_TABLES) {
    const re = new RegExp(`\\bTABLE(?:\\s+DATA)?\\s+public\\s+${table}\\b`);
    if (lines.some((l) => re.test(l))) present.push(table);
    else missing.push(table);
  }

  // Detection unaccent sull'output GREZZO: la riga EXTENSION non e' un commento
  // ";" ma alcune varianti (COMMENT ON EXTENSION) potrebbero esserlo — quindi
  // non filtriamo qui i commenti.
  const rawLines = String(listOutput ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const unaccentPresent = tocMentionsUnaccentExtension(rawLines);

  if (entryCount === 0) notes.push("TOC vuoto: dump non valido");
  if (!hasPublicSchema) notes.push("nessun riferimento allo schema public nel TOC");
  if (missing.length > 0) notes.push(`tabelle di controllo assenti dal TOC: ${missing.join(", ")}`);
  if (!unaccentPresent) {
    notes.push(
      "estensione 'unaccent' assente dal TOC: nessun indice/funzione/vista ITS ne dipende " +
        "(unica ricorrenza: backfill una-tantum nella migrazione 0189), quindi il backup NON e' bloccato " +
        "ma resta 'unverified' — al restore eseguire 'CREATE EXTENSION unaccent' a mano se serve",
    );
  }

  const structurallyBroken = entryCount === 0 || !hasPublicSchema || missing.length > 0;
  const status: "passed" | "unverified" | "failed" = structurallyBroken
    ? "failed"
    : unaccentPresent
      ? "passed"
      : "unverified";

  return {
    status,
    pg_restore_list_entries: entryCount,
    has_public_schema: hasPublicSchema,
    checked_tables_present: present,
    checked_tables_missing: missing,
    unaccent_extension_present: unaccentPresent,
    notes,
  };
}

// ─── Verifica strutturale — AUTH dump ────────────────────────────────────

export type PgBackupAuthVerification = {
  status: "passed" | "failed";
  pg_restore_list_entries: number;
  has_users: boolean;
  has_identities: boolean;
  /** Sottoinsieme di PG_BACKUP_AUTH_TABLES effettivamente presente nel TOC. */
  tables_present: string[];
  notes: string[];
};

/**
 * Interpreta l'output di `pg_restore --list <auth.dump>` (custom format).
 * PASSA se `auth.users` E `auth.identities` sono presenti nel TOC.
 * `auth.mfa_factors` / `auth.mfa_amr_claims` possono mancare (progetto senza
 * MFA) senza far fallire la verifica.
 */
export function verifyAuthRestoreList(listOutput: string): PgBackupAuthVerification {
  const lines = String(listOutput ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith(";"));

  const present: string[] = [];
  for (const qualified of PG_BACKUP_AUTH_TABLES) {
    const name = qualified.split(".")[1];
    const re = new RegExp(`\\bTABLE(?:\\s+DATA)?\\s+auth\\s+${name}\\b`);
    if (lines.some((l) => re.test(l))) present.push(qualified);
  }

  const hasUsers = present.includes("auth.users");
  const hasIdentities = present.includes("auth.identities");

  const notes: string[] = [];
  if (lines.length === 0) notes.push("TOC auth vuoto: dump non valido");
  if (!hasUsers) notes.push("auth.users assente dal TOC del dump auth");
  if (!hasIdentities) notes.push("auth.identities assente dal TOC del dump auth (login email/password non ripristinabile)");

  return {
    status: hasUsers && hasIdentities ? "passed" : "failed",
    pg_restore_list_entries: lines.length,
    has_users: hasUsers,
    has_identities: hasIdentities,
    tables_present: present,
    notes,
  };
}

// ─── Manifest ─────────────────────────────────────────────────────────────

export type PgBackupArtifactInfo = {
  filename: string;
  kind: PgBackupArtifactKind;
  size_bytes: number;
  sha256: string;
  r2_key: string;
  r2_verified: boolean;
};

export type PgBackupVerification = {
  /**
   * - "failed":     public O auth === "failed" (backup non affidabile);
   * - "unverified": nessuno dei due "failed" ma public === "unverified"
   *                 (unaccent assente dal TOC) -> backup conservato, job "warning";
   * - "passed":     public === "passed" E auth === "passed".
   */
  status: "passed" | "unverified" | "failed";
  public: PgBackupPublicVerification;
  auth: PgBackupAuthVerification;
};

export type PgBackupManifest = {
  schema_version: 2;
  created_at: string; // ISO
  base_name: string;
  backup_date: string; // YYYY-MM-DD
  postgres_server_version: string | null;
  postgres_server_major: number | null;
  pg_dump_version: string | null;
  pg_dump_major: number | null;
  pg_restore_version: string | null;
  format: "custom"; // pg_dump -Fc
  connection: "session-pooler"; // MAI la stringa reale
  dump_scope: {
    full: string; // es. "--schema=public"
    auth: string; // es. "--data-only --table=auth.users --table=auth.identities ..."
    auth_tables_included: string[];
    auth_tables_excluded: string[];
  };
  artifacts: PgBackupArtifactInfo[];
  verification: PgBackupVerification;
  totals: {
    artifact_count: number;
    total_size_bytes: number;
  };
  duration_ms: number;
  retention_days: number;
  runner: string; // es. "github-actions" — mai host/utente
};

export type BuildManifestInput = {
  now: Date;
  baseName: string;
  postgresServerVersion: string | null;
  postgresServerMajor: number | null;
  pgDumpVersion: string | null;
  pgDumpMajor: number | null;
  pgRestoreVersion: string | null;
  fullScope: string;
  authScope: string;
  artifacts: PgBackupArtifactInfo[];
  publicVerification: PgBackupPublicVerification;
  authVerification: PgBackupAuthVerification;
  durationMs: number;
  runner: string;
  retentionDays?: number;
};

export function buildPgBackupManifest(input: BuildManifestInput): PgBackupManifest {
  const totalSize = input.artifacts.reduce((s, a) => s + (Number.isFinite(a.size_bytes) ? a.size_bytes : 0), 0);
  const pub = input.publicVerification.status;
  const auth = input.authVerification.status;
  const overall: "passed" | "unverified" | "failed" =
    pub === "failed" || auth === "failed" ? "failed" : pub === "unverified" ? "unverified" : "passed";
  return {
    schema_version: 2,
    created_at: input.now.toISOString(),
    base_name: input.baseName,
    backup_date: backupDateFromBase(input.baseName) ?? input.now.toISOString().slice(0, 10),
    postgres_server_version: input.postgresServerVersion,
    postgres_server_major: input.postgresServerMajor,
    pg_dump_version: input.pgDumpVersion,
    pg_dump_major: input.pgDumpMajor,
    pg_restore_version: input.pgRestoreVersion,
    format: "custom",
    connection: "session-pooler",
    dump_scope: {
      full: input.fullScope,
      auth: input.authScope,
      auth_tables_included: [...PG_BACKUP_AUTH_TABLES],
      auth_tables_excluded: [...PG_BACKUP_AUTH_EXCLUDED_TABLES],
    },
    artifacts: input.artifacts,
    verification: { status: overall, public: input.publicVerification, auth: input.authVerification },
    totals: { artifact_count: input.artifacts.length, total_size_bytes: totalSize },
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    retention_days: input.retentionDays ?? PG_BACKUP_RETENTION_DAYS,
    runner: input.runner,
  };
}

// ─── Redazione segreti ────────────────────────────────────────────────────

/**
 * Rimuove da un testo (tipicamente un messaggio d'errore) ogni occorrenza
 * letterale dei valori sensibili passati, e le password embedded in una
 * connection string postgres://user:PASS@host. Non si affida al solo
 * comportamento noto dei tool: difesa in profondita'.
 */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = String(text ?? "");
  // password dentro una URL postgres://user:password@host
  out = out.replace(/(postgres(?:ql)?:\/\/[^:@\s/]+:)[^@\s/]+(@)/gi, "$1[redacted]$2");
  for (const s of secrets) {
    const v = (s ?? "").trim();
    if (v.length >= 4) out = out.split(v).join("[redacted]");
  }
  return out.length > 2000 ? `${out.slice(0, 1997)}...` : out;
}

/** Maschera una connection string per il log: postgresql://po***:***@aws-0-***.pooler.supabase.com:5432/postgres */
export function maskConnectionString(url: string | undefined | null): string {
  const raw = (url ?? "").trim();
  if (!raw) return "(non impostata)";
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^([a-z0-9]{2})[a-z0-9.-]*/i, "$1***");
    const user = (u.username || "?").replace(/^([a-z0-9]{2})[a-z0-9._-]*/i, "$1***");
    return `${u.protocol}//${user}:***@${host}:${u.port || "5432"}${u.pathname || ""}`;
  } catch {
    return "(connection string non parsabile)";
  }
}

/** Elenca le env mancanti tra quelle richieste (nessun valore mai restituito). */
export function missingBackupEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return PG_BACKUP_REQUIRED_ENV.filter((k) => !((env[k] ?? "").trim().length > 0));
}
