/**
 * Disaster Recovery V2 — copia off-provider del backup su Cloudflare R2.
 *
 * Indipendente dal backup primario (Supabase Storage, app/api/cron/backup/route.ts):
 * un fallimento qui non deve MAI invalidare o cancellare il backup primario, ne'
 * innescare un restore. Solo upload + verifica HeadObject + retention applicativa.
 *
 * Configurato esclusivamente da env server-side (mai NEXT_PUBLIC_*):
 * R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT.
 * Nessun valore hardcoded, nessuna credenziale mai loggata (vedi summarizeR2Error).
 */
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const REQUIRED_ENV_KEYS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME",
  "R2_ENDPOINT",
] as const;

/**
 * Prefisso applicato alle chiavi R2 (es. "production/backup_2026-09-05.json").
 * Il nome file resta identico a quello Supabase (backup_YYYY-MM-DD.json);
 * il prefisso serve solo a tenere il bucket organizzato se in futuro
 * verranno caricati backup di altri ambienti nello stesso bucket R2.
 */
export const R2_BACKUP_PREFIX = "production";

export const R2_RETENTION_DAYS = 90;

const FILENAME_RE = /^backup_(\d{4}-\d{2}-\d{2})\.json$/;

function trimEnv(value: string | undefined): string {
  return (value ?? "").trim().replace(/^["']|["']$/g, "");
}

export type R2ConfigStatus =
  | { configured: true; bucket: string }
  | { configured: false; missing: string[] };

export function getR2ConfigStatus(): R2ConfigStatus {
  const missing = REQUIRED_ENV_KEYS.filter((key) => trimEnv(process.env[key]).length === 0);
  if (missing.length > 0) return { configured: false, missing };
  return { configured: true, bucket: trimEnv(process.env.R2_BUCKET_NAME) };
}

function getClient(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: trimEnv(process.env.R2_ENDPOINT),
    credentials: {
      accessKeyId: trimEnv(process.env.R2_ACCESS_KEY_ID),
      secretAccessKey: trimEnv(process.env.R2_SECRET_ACCESS_KEY),
    },
  });
}

/**
 * Non stampa mai credenziali: tronca il messaggio e ridacta ogni occorrenza
 * letterale dei valori delle env sensibili, nel caso l'SDK li includa
 * (difesa aggiuntiva, non ci si affida solo al comportamento noto dell'SDK).
 */
export function summarizeR2Error(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "Errore sconosciuto");
  const secrets = [trimEnv(process.env.R2_ACCESS_KEY_ID), trimEnv(process.env.R2_SECRET_ACCESS_KEY)].filter(
    (s) => s.length > 0
  );
  let message = raw;
  for (const secret of secrets) {
    message = message.split(secret).join("[redacted]");
  }
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function buildOffsiteKey(filename: string): string {
  return `${R2_BACKUP_PREFIX}/${filename}`;
}

export type R2UploadResult =
  | { status: "success"; bucket: string; key: string; size_bytes: number; verified: true }
  | { status: "failed"; bucket: string; key: string; verified: false; error: string }
  | { status: "skipped"; verified: false; error: string };

/**
 * Upload del backup su R2 + verifica post-upload via HeadObject (mai un
 * download completo per la verifica quotidiana). Non lancia mai eccezioni:
 * ogni esito (successo, PutObject fallito, HeadObject fallito, env mancanti)
 * torna come valore, cosi' il chiamante puo' sempre completare il job
 * riportando lo stato offsite senza interrompere il flusso del backup primario.
 */
export async function uploadOffsiteBackup(filename: string, bytes: Buffer): Promise<R2UploadResult> {
  const config = getR2ConfigStatus();
  if (!config.configured) {
    return { status: "skipped", verified: false, error: `Variabili R2 mancanti: ${config.missing.join(", ")}` };
  }

  const key = buildOffsiteKey(filename);
  const client = getClient();

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/json",
      })
    );
  } catch (error) {
    return { status: "failed", bucket: config.bucket, key, verified: false, error: summarizeR2Error(error) };
  }

  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    const contentLength = typeof head.ContentLength === "number" ? head.ContentLength : null;
    if (contentLength == null) {
      return {
        status: "failed",
        bucket: config.bucket,
        key,
        verified: false,
        error: "Verifica HeadObject fallita: ContentLength assente nella risposta R2.",
      };
    }
    if (contentLength !== bytes.length) {
      return {
        status: "failed",
        bucket: config.bucket,
        key,
        verified: false,
        error: `Verifica HeadObject fallita: dimensione attesa ${bytes.length}, rilevata ${contentLength}.`,
      };
    }
    return { status: "success", bucket: config.bucket, key, size_bytes: contentLength, verified: true };
  } catch (error) {
    return {
      status: "failed",
      bucket: config.bucket,
      key,
      verified: false,
      error: `Verifica HeadObject fallita: ${summarizeR2Error(error)}`,
    };
  }
}

export type R2PurgeResult = { deleted: string[]; errors: string[] };

/**
 * Retention applicativa R2 (90 giorni): elenca solo il prefisso usato dai
 * backup, cancella esclusivamente gli oggetti il cui nome file (data
 * embedded, stesso pattern backup_YYYY-MM-DD.json del primario) e' precedente
 * al cutoff. Non tocca MAI oggetti recenti. Se l'elenco o la cancellazione
 * falliscono, il backup appena creato resta valido: qui si riporta solo
 * l'errore, senza alcuna azione sul backup Supabase.
 */
export async function purgeOldOffsiteBackups(now: Date = new Date()): Promise<R2PurgeResult> {
  const config = getR2ConfigStatus();
  if (!config.configured) return { deleted: [], errors: [] };

  const client = getClient();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - R2_RETENTION_DAYS);
  const cutoffIso = cutoff.toISOString().slice(0, 10);
  const prefix = `${R2_BACKUP_PREFIX}/`;

  let keys: string[] = [];
  try {
    const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }));
    keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
  } catch (error) {
    return { deleted: [], errors: [`Elenco oggetti R2 fallito: ${summarizeR2Error(error)}`] };
  }

  const old = keys.filter((key) => {
    const name = key.startsWith(prefix) ? key.slice(prefix.length) : key;
    const match = name.match(FILENAME_RE);
    return match !== null && match[1] < cutoffIso;
  });

  if (old.length === 0) return { deleted: [], errors: [] };

  try {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: config.bucket,
        Delete: { Objects: old.map((Key) => ({ Key })) },
      })
    );
    return { deleted: old, errors: [] };
  } catch (error) {
    return { deleted: [], errors: [`Cancellazione oggetti R2 fallita: ${summarizeR2Error(error)}`] };
  }
}
