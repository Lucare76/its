/**
 * Disaster Recovery V3 — Restore Drill (pg_restore di its_full_*.dump verso un
 * progetto Supabase/Postgres di TEST, isolato dalla produzione).
 *
 * Questo modulo contiene SOLO funzioni pure: nessun accesso a rete, nessuna
 * esecuzione di processi, nessun accesso al filesystem — stesso pattern di
 * `lib/server/postgres-backup.ts`. L'orchestrazione (download R2 read-only,
 * pg_restore, verifiche via psql) vive in `scripts/postgres-restore-drill.mjs`.
 *
 * NON e' collegato a `scripts/restore-backup-snapshot.mjs`: quello ripristina
 * lo snapshot JSON applicativo (Layer 2/3) via Supabase client (upsert riga
 * per riga); questo ripristina il dump `pg_dump -Fc` (Layer 4/5) via
 * `pg_restore` binario. Backup diversi, meccanismi diversi, guardie separate
 * (ma con lo stesso principio: mai un target che sia — o assomigli a — produzione).
 */

import { PG_BACKUP_AUTH_TABLES } from "./postgres-backup";

/** Valore esatto richiesto in RESTORE_TARGET_CONFIRM per autorizzare una scrittura reale. */
export const RESTORE_DRILL_CONFIRM_VALUE = "I_UNDERSTAND_THIS_IS_TEST_ONLY";

/** Project-ref di produzione noti: se compaiono nel target del drill, abort immediato. */
export const RESTORE_DRILL_KNOWN_PROD_REFS = ["lnjgwxqblapmxabwiyrg"] as const;

/**
 * Estrae il project-ref dallo username del Session Pooler Supabase
 * (`postgres.<project-ref>`). null se l'URI non e' parsabile o non ha quella forma
 * (es. connessione diretta `postgres@db.<ref>.supabase.co`, fuori scope qui).
 */
export function parseProjectRefFromPoolerUsername(dsn: string | null | undefined): string | null {
  const raw = (dsn ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const m = u.username.match(/^postgres\.([a-z0-9]+)$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export type RestoreTargetGuardInput = {
  /** RESTORE_TARGET_DB_URL: Session Pooler URI del progetto di TEST. */
  targetDsn: string | null | undefined;
  /** SUPABASE_DB_URL: Session Pooler URI di PRODUZIONE — usata SOLO per il confronto, mai per connettersi. */
  prodDsn: string | null | undefined;
  /** valore letto da RESTORE_TARGET_CONFIRM. */
  confirmEnvValue: string | null | undefined;
  /** true per qualunque esecuzione che scrive davvero (tutto tranne --dry-run). */
  requireConfirm: boolean;
};

export type RestoreTargetGuardResult = {
  safe: boolean;
  reasons: string[];
};

/**
 * Guardia OBBLIGATORIA, eseguita PRIMA di qualunque altra operazione (prima del
 * download R2, prima di ogni tool check). Fail-closed: qualunque condizione
 * ambigua (DSN mancante, non parsabile, confronto impossibile) -> unsafe.
 *
 * NOTA sull'hostname del pooler: l'host Session Pooler (`aws-0-<region>.pooler.
 * supabase.com`) e' CONDIVISO da tutti i progetti Supabase nella stessa regione
 * — NON e' un identificatore di progetto, quindi confrontare gli hostname
 * darebbe falsi positivi (un progetto di test nella stessa regione della
 * produzione verrebbe erroneamente bloccato). L'identificatore di progetto e'
 * lo username `postgres.<project-ref>`: e' quello che confrontiamo, insieme al
 * confronto letterale con l'elenco `RESTORE_DRILL_KNOWN_PROD_REFS`.
 */
export function assertRestoreTargetIsSafe(input: RestoreTargetGuardInput): RestoreTargetGuardResult {
  const reasons: string[] = [];
  const target = (input.targetDsn ?? "").trim();
  const prod = (input.prodDsn ?? "").trim();

  if (!target) {
    return { safe: false, reasons: ["RESTORE_TARGET_DB_URL mancante: questo script non ha un target di test su cui operare."] };
  }
  if (!/^postgres(?:ql)?:\/\//i.test(target)) {
    return { safe: false, reasons: ["RESTORE_TARGET_DB_URL non e' una connection string postgres:// valida."] };
  }

  for (const ref of RESTORE_DRILL_KNOWN_PROD_REFS) {
    if (target.includes(ref)) reasons.push(`RESTORE_TARGET_DB_URL contiene un project-ref di produzione noto (${ref}).`);
  }

  if (prod) {
    if (target === prod) {
      reasons.push("RESTORE_TARGET_DB_URL e' identica a SUPABASE_DB_URL (produzione).");
    }
    const targetRef = parseProjectRefFromPoolerUsername(target);
    const prodRef = parseProjectRefFromPoolerUsername(prod);
    if (targetRef && prodRef && targetRef === prodRef) {
      reasons.push(`RESTORE_TARGET_DB_URL usa lo stesso project-ref di produzione (${targetRef}).`);
    }
    if (!targetRef) {
      reasons.push("RESTORE_TARGET_DB_URL non ha la forma Session Pooler attesa (postgres.<project-ref>@...): impossibile confermare l'isolamento dalla produzione, abort per sicurezza.");
    }
  }

  if (input.requireConfirm && input.confirmEnvValue !== RESTORE_DRILL_CONFIRM_VALUE) {
    reasons.push(`RESTORE_TARGET_CONFIRM deve essere esattamente "${RESTORE_DRILL_CONFIRM_VALUE}" per eseguire scritture reali (assente/errato).`);
  }

  return { safe: reasons.length === 0, reasons };
}

// ─── Riordino restore AUTH (dipendenze FK) ─────────────────────────────────

/**
 * `pg_restore --list` su un archivio custom-format elenca le voci `TABLE DATA`
 * nell'ordine in cui pg_dump le ha scoperte nel catalogo — TIPICAMENTE
 * alfabetico per nome tabella, NON per dipendenza FK. Per il dump auth questo
 * e' un problema reale: "identities" precede "users" alfabeticamente, ma
 * `auth.identities.user_id` referenzia `auth.users.id` — caricare identities
 * prima di users viola la FK.
 *
 * Questa funzione riordina le sole righe `TABLE DATA auth <tabella>` secondo
 * `PG_BACKUP_AUTH_TABLES` (users prima di identities/mfa_*), lasciando ogni
 * altra riga (commenti `;`, intestazioni) nella posizione originale. Il file
 * risultante va passato a `pg_restore --use-list=<file>`.
 */
export function reorderAuthRestoreList(
  listOutput: string,
  orderedTables: readonly string[] = PG_BACKUP_AUTH_TABLES,
): string {
  const lines = String(listOutput ?? "").split(/\r?\n/);
  const tableDataRe = /\bTABLE DATA\s+auth\s+(\w+)\b/;

  const header: string[] = [];
  const dataLines: { line: string; priority: number }[] = [];

  for (const line of lines) {
    const m = tableDataRe.exec(line);
    if (!m) {
      header.push(line);
      continue;
    }
    const qualified = `auth.${m[1]}`;
    const idx = orderedTables.indexOf(qualified);
    dataLines.push({ line, priority: idx === -1 ? orderedTables.length : idx });
  }

  dataLines.sort((a, b) => a.priority - b.priority);
  return [...header, ...dataLines.map((d) => d.line)].join("\n");
}

// ─── Filtro restore PUBLIC (schema gia' esistente sul progetto nuovo) ──────

/**
 * Ogni progetto Supabase nuovo ha gia' lo schema `public` (creato al
 * provisioning, vuoto). Il dump full contiene comunque una voce
 * `SCHEMA - public` nel TOC: se la si restora, `pg_restore` fallisce con
 * "schema public already exists". Le istruzioni del drill vietano `--clean`
 * / `--create` "alla cieca" — la soluzione chirurgica e' rimuovere SOLO quella
 * riga dalla `--use-list` e lasciare invariato l'ordine di tutte le altre
 * (tabelle, funzioni, indici, dati, trigger, policy): l'ordine del TOC di un
 * dump `--format=custom` e' gia' organizzato per sezione (pre-data / data /
 * post-data) da pg_dump stesso, quindi rimuovere una riga non altera la
 * sicurezza delle dipendenze delle altre.
 *
 * Se il TOC non contiene affatto `SCHEMA - public` (es. per come pg_dump ha
 * costruito l'archivio), la funzione e' un no-op innocuo.
 */
export function filterOutPublicSchemaCreation(listOutput: string): string {
  const lines = String(listOutput ?? "").split(/\r?\n/);
  const isPublicSchemaCreate = (l: string) => /\bSCHEMA\s+-\s+public\b/.test(l) && !/\bCOMMENT\b/i.test(l);
  return lines.filter((l) => !isPublicSchemaCreate(l)).join("\n");
}
