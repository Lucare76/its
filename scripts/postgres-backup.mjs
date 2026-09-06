#!/usr/bin/env node
/**
 * ITS Disaster Recovery V3 — PostgreSQL full logical backup (Layer 4 + Layer 5).
 *
 * Eseguito da .github/workflows/postgres-backup.yml (GitHub Actions):
 *   pnpm exec tsx scripts/postgres-backup.mjs
 *
 * NON gira su Vercel: pg_dump non e' disponibile nel runtime serverless, la
 * durata e' limitata e la connection string non deve stare nell'ambiente
 * dell'app. GitHub Actions separa il backup completo dalla produzione (stesso
 * pattern gia' usato per supabase db push).
 *
 * NON esegue MAI un restore. NON scrive MAI nel database: solo pg_dump / psql
 * (lettura) + upload su Cloudflare R2. Fail-fast su qualunque errore.
 *
 * FLAG:
 *   --dry-run     valida tool/env/versione server/connettivita' R2 e stampa il
 *                 piano, senza eseguire pg_dump ne' caricare nulla su R2.
 *   --keep-local  non cancella i file temporanei (debug locale).
 *
 * ENV richieste (mai stampate):
 *   SUPABASE_DB_URL  Session Pooler URI Supabase, porta 5432
 *                    (postgresql://postgres.<ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres)
 *                    -> Dashboard Supabase / Project Settings / Database /
 *                       Connection string / Session pooler.
 *                    NON usare la Direct connection (db.<ref>.supabase.co:5432):
 *                    e' IPv6-only e i runner GitHub-hosted non hanno IPv6.
 *                    NON usare il Transaction Pooler (porta 6543): non supporta pg_dump.
 *   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_ENDPOINT
 * ENV opzionali (health ping, Layer 8):
 *   DR_HEALTH_REPORT_URL      es. https://<app>/api/cron/postgres-backup-report
 *   DR_HEALTH_REPORT_SECRET   bearer per quell'endpoint
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

// Import dinamico del modulo .ts: stesso pattern gia' in CI per
// scripts/verify-test-sunday-synthetic.mjs (un import statico di un .ts da un
// entry .mjs non viene trasformato da tsx).
const {
  PG_BACKUP_R2_PREFIX,
  PG_BACKUP_RETENTION_DAYS,
  PG_BACKUP_FULL_SCOPE_ARGS,
  PG_BACKUP_AUTH_TABLES,
  PG_BACKUP_AUTH_EXCLUDED_TABLES,
  buildAuthDumpArgs,
  buildBackupBaseName,
  fullDumpFileName,
  authDumpFileName,
  manifestFileName,
  backupR2Key,
  sha256Hex,
  buildPgBackupManifest,
  verifyRestoreList,
  verifyAuthRestoreList,
  selectExpiredBackupSets,
  redactSecrets,
  maskConnectionString,
  missingBackupEnv,
  parsePgMajorFromVersionLine,
  serverMajorFromVersionNum,
  isClientVersionSufficient,
  versionCompatMessage,
} = await import("../lib/server/postgres-backup.ts");

const FULL_SCOPE = [...PG_BACKUP_FULL_SCOPE_ARGS];
const AUTH_SCOPE = buildAuthDumpArgs();
const COMMON_DUMP_ARGS = ["--format=custom", "--no-owner", "--no-privileges", "--quote-all-identifiers", "--verbose"];

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KEEP_LOCAL = args.includes("--keep-local");

const SECRETS = () => [
  process.env.SUPABASE_DB_URL,
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY,
  process.env.DR_HEALTH_REPORT_SECRET,
];

function log(msg) {
  console.log(redactSecrets(String(msg), SECRETS()));
}
function fail(msg) {
  console.error("\n🔴 " + redactSecrets(String(msg), SECRETS()));
  console.error("   Backup PostgreSQL NON riuscito. Nessun file e' un backup valido.\n");
  process.exitCode = 1;
  throw new Error("__handled__");
}

function run(cmd, argv, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", captureStdout ? "pipe" : "inherit", "pipe"] });
    let out = "";
    let err = "";
    if (captureStdout) child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`spawn ${cmd} fallito: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} uscito con codice ${code}. stderr: ${redactSecrets(err.slice(-1500), SECRETS())}`));
    });
  });
}

async function toolVersion(cmd) {
  try {
    const { stdout } = await run(cmd, ["--version"], { captureStdout: true });
    return stdout.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function r2Client() {
  return new S3Client({
    region: "auto",
    endpoint: (process.env.R2_ENDPOINT ?? "").trim(),
    credentials: {
      accessKeyId: (process.env.R2_ACCESS_KEY_ID ?? "").trim(),
      secretAccessKey: (process.env.R2_SECRET_ACCESS_KEY ?? "").trim(),
    },
  });
}

async function r2ListPrefix(client, bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PG_BACKUP_R2_PREFIX}/`, ContinuationToken }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

async function uploadAndVerify(client, bucket, key, body, contentType) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  const len = typeof head.ContentLength === "number" ? head.ContentLength : null;
  if (len == null) throw new Error(`HeadObject ${key}: ContentLength assente`);
  if (len !== body.length) throw new Error(`HeadObject ${key}: dimensione attesa ${body.length}, rilevata ${len}`);
  return len;
}

/**
 * Legge `SHOW server_version_num` dal database via psql (SOLA LETTURA, nessuna
 * scrittura). La connection string e' passata come ARGV (spawn senza shell):
 * non compare mai in un comando espanso ne' nei log (redazione su stderr).
 */
async function readServerVersionNum(connStr) {
  const { stdout } = await run("psql", [connStr, "-tAX", "-c", "SHOW server_version_num"], { captureStdout: true });
  const trimmed = stdout.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`SHOW server_version_num ha restituito un valore inatteso: "${trimmed.slice(0, 40)}"`);
  return trimmed;
}

async function healthPing(payload) {
  const url = (process.env.DR_HEALTH_REPORT_URL ?? "").trim();
  const secret = (process.env.DR_HEALTH_REPORT_SECRET ?? "").trim();
  if (!url || !secret) {
    log("ℹ️  Health ping non configurato (DR_HEALTH_REPORT_URL / DR_HEALTH_REPORT_SECRET assenti) — salto.");
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
      body: JSON.stringify(payload),
    });
    log(`ℹ️  Health ping -> HTTP ${res.status}`);
  } catch (e) {
    log(`⚠️  Health ping fallito (non blocca il backup): ${redactSecrets(String(e?.message ?? e), SECRETS())}`);
  }
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const runner = process.env.GITHUB_ACTIONS ? "github-actions" : "manual";
  const base = buildBackupBaseName(now);

  console.log("🗄️  ITS DISASTER RECOVERY V3 — PostgreSQL full backup");
  console.log(`   Modalita': ${DRY_RUN ? "DRY-RUN (nessun pg_dump, nessun upload)" : "ESECUZIONE REALE"}`);
  console.log(`   Runner:    ${runner}`);

  // 0. env
  const missing = missingBackupEnv();
  if (missing.length) fail(`env mancanti: ${missing.join(", ")}`);
  const connStr = process.env.SUPABASE_DB_URL;
  log(`   DB:        ${maskConnectionString(connStr)} (atteso: Session Pooler URI, porta 5432)`);
  const bucket = process.env.R2_BUCKET_NAME.trim();

  // 1. pg_dump / pg_restore / psql disponibili + versione
  const pgDumpVersion = await toolVersion("pg_dump");
  const pgRestoreVersion = await toolVersion("pg_restore");
  const psqlVersion = await toolVersion("psql");
  if (!pgDumpVersion) fail("pg_dump non trovato nel PATH.");
  if (!pgRestoreVersion) fail("pg_restore non trovato nel PATH.");
  if (!psqlVersion) fail("psql non trovato nel PATH (serve per la verifica versione server).");
  log(`   pg_dump:    ${pgDumpVersion}`);
  log(`   pg_restore: ${pgRestoreVersion}`);
  const pgDumpMajor = parsePgMajorFromVersionLine(pgDumpVersion);

  const fullName = fullDumpFileName(base);
  const authName = authDumpFileName(base);
  const manifestName = manifestFileName(base);

  console.log("\n─── PIANO ─────────────────────────────────────────────────");
  console.log(`  ${fullName}       <- pg_dump ${FULL_SCOPE.join(" ")} ${COMMON_DUMP_ARGS.filter((a) => a !== "--verbose").join(" ")}`);
  console.log(`  ${authName}  <- pg_dump ${AUTH_SCOPE.join(" ")}`);
  console.log(`     auth incluse: ${PG_BACKUP_AUTH_TABLES.join(", ")}`);
  console.log(`     auth escluse: ${PG_BACKUP_AUTH_EXCLUDED_TABLES.join(", ")}`);
  console.log(`  ${manifestName}`);
  console.log(`  R2 prefix: ${PG_BACKUP_R2_PREFIX}/   bucket: ${bucket}`);
  console.log(`  Retention: ${PG_BACKUP_RETENTION_DAYS} giorni rolling (mai l'ultimo set)`);
  console.log("───────────────────────────────────────────────────────────\n");

  const client = r2Client();

  if (DRY_RUN) {
    // 2. verifica compatibilita' versione (anche in dry-run: e' sola lettura)
    try {
      const serverNum = await readServerVersionNum(connStr);
      const serverMajor = serverMajorFromVersionNum(serverNum);
      log(`   server:     PostgreSQL major ${serverMajor} (server_version_num ${serverNum})`);
      log(`   compat:     ${versionCompatMessage(pgDumpMajor, serverMajor)}`);
      if (!isClientVersionSufficient(pgDumpMajor, serverMajor)) {
        fail(versionCompatMessage(pgDumpMajor, serverMajor));
      }
    } catch (e) {
      fail(`DRY-RUN: verifica versione server fallita (connessione DB): ${e.message}`);
    }
    try {
      const keys = await r2ListPrefix(client, bucket);
      log(`✅ DRY-RUN: R2 raggiungibile, ${keys.length} oggetti sotto ${PG_BACKUP_R2_PREFIX}/`);
      const plan = selectExpiredBackupSets(keys, now);
      log(`   Retention simulata: ${plan.expire.length} set da eliminare, ${plan.keep.length} mantenuti, ultimo = ${plan.newestKeptBase ?? "(nessuno)"}`);
    } catch (e) {
      fail(`DRY-RUN: R2 non raggiungibile: ${e.message}`);
    }
    log("\n✅ DRY-RUN completato: nessun pg_dump eseguito, nessun upload. Rilancia senza --dry-run per il backup reale.\n");
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "its-pgbackup-"));
  const fullPath = join(workDir, fullName);
  const authPath = join(workDir, authName);
  let uploadedOk = false;

  try {
    // 2. verifica OBBLIGATORIA compatibilita' versione client/server PRIMA del dump
    log("→ verifica versione client/server ...");
    const serverNum = await readServerVersionNum(connStr);
    const serverMajor = serverMajorFromVersionNum(serverNum);
    const serverVersionHuman = `PostgreSQL ${serverMajor} (server_version_num ${serverNum})`;
    log(`   ${serverVersionHuman} · ${versionCompatMessage(pgDumpMajor, serverMajor)}`);
    if (!isClientVersionSufficient(pgDumpMajor, serverMajor)) {
      fail(versionCompatMessage(pgDumpMajor, serverMajor));
    }

    // 3. pg_dump (public)
    log(`→ pg_dump ${FULL_SCOPE.join(" ")} ...`);
    await run("pg_dump", [...COMMON_DUMP_ARGS, ...FULL_SCOPE, "--file", fullPath, connStr]);
    // 3b. pg_dump (auth, selettivo, data-only)
    log(`→ pg_dump ${AUTH_SCOPE.join(" ")} ...`);
    await run("pg_dump", [...COMMON_DUMP_ARGS, ...AUTH_SCOPE, "--file", authPath, connStr]);

    // 4-6. exit code (gia' verificato da run()), file esiste, dimensione > 0
    const artifactsToCheck = [
      { path: fullPath, name: fullName, kind: "full", size: 0 },
      { path: authPath, name: authName, kind: "auth", size: 0 },
    ];
    for (const a of artifactsToCheck) {
      let st;
      try {
        st = await stat(a.path);
      } catch {
        fail(`file ${a.name} non creato da pg_dump.`);
      }
      if (!st.isFile() || st.size <= 0) fail(`file ${a.name} vuoto (${st.size} byte).`);
      a.size = st.size;
    }

    // 7. verifica strutturale DISTINTA: PUBLIC dump + AUTH dump. Entrambe devono passare.
    log("→ pg_restore --list (verifica strutturale PUBLIC) ...");
    const { stdout: fullListOut } = await run("pg_restore", ["--list", fullPath], { captureStdout: true });
    const publicVerification = verifyRestoreList(fullListOut);
    log(`   PUBLIC: ${publicVerification.pg_restore_list_entries} voci · schema public: ${publicVerification.has_public_schema} · unaccent: ${publicVerification.unaccent_extension_present} · tabelle mancanti: ${publicVerification.checked_tables_missing.join(", ") || "nessuna"}`);

    log("→ pg_restore --list (verifica strutturale AUTH) ...");
    const { stdout: authListOut } = await run("pg_restore", ["--list", authPath], { captureStdout: true });
    const authVerification = verifyAuthRestoreList(authListOut);
    log(`   AUTH:   ${authVerification.pg_restore_list_entries} voci · auth.users: ${authVerification.has_users} · auth.identities: ${authVerification.has_identities} · tabelle presenti: ${authVerification.tables_present.join(", ") || "nessuna"}`);

    if (publicVerification.status === "failed") {
      fail(`verifica PUBLIC FALLITA: ${publicVerification.notes.join("; ")}`);
    }
    if (publicVerification.status === "unverified") {
      // unaccent assente dal TOC: nessun oggetto ITS ne dipende -> il backup NON
      // e' bloccato, ma resta 'unverified' (il job va in warning, non critical).
      log(`⚠️  verifica PUBLIC NON verificata (backup comunque conservato): ${publicVerification.notes.join("; ")}`);
    }
    if (authVerification.status !== "passed") {
      fail(`verifica AUTH FALLITA: ${authVerification.notes.join("; ")}`);
    }

    // 8. SHA-256 di ogni artefatto
    const buffers = {};
    const artifactInfos = [];
    for (const a of artifactsToCheck) {
      const buf = await readFile(a.path);
      buffers[a.name] = buf;
      artifactInfos.push({
        filename: a.name,
        kind: a.kind,
        size_bytes: buf.length,
        sha256: sha256Hex(buf),
        r2_key: backupR2Key(a.name),
        r2_verified: false,
      });
    }

    // 9-10. upload su R2 + verifica HeadObject
    log("→ upload R2 + verifica HeadObject ...");
    for (const info of artifactInfos) {
      const verifiedLen = await uploadAndVerify(client, bucket, info.r2_key, buffers[info.filename], "application/octet-stream");
      info.r2_verified = verifiedLen === info.size_bytes;
      if (!info.r2_verified) fail(`upload R2 non verificato per ${info.filename}`);
      log(`   ✓ ${info.r2_key}  (${info.size_bytes} byte, sha256 ${info.sha256.slice(0, 12)}…)`);
    }

    // 6/11. manifest
    const serverVersionFromToc = (() => {
      const m = fullListOut.match(/Dumped from database version ([0-9.]+)/i);
      return m ? m[1] : null;
    })();
    const manifest = buildPgBackupManifest({
      now,
      baseName: base,
      postgresServerVersion: serverVersionFromToc ?? serverVersionHuman,
      postgresServerMajor: serverMajor,
      pgDumpVersion,
      pgDumpMajor,
      pgRestoreVersion,
      fullScope: FULL_SCOPE.join(" "),
      authScope: AUTH_SCOPE.join(" "),
      artifacts: artifactInfos,
      publicVerification,
      authVerification,
      durationMs: Date.now() - startedAt,
      runner,
      retentionDays: PG_BACKUP_RETENTION_DAYS,
    });
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
    const manifestKey = backupR2Key(manifestName);
    const manifestLen = await uploadAndVerify(client, bucket, manifestKey, manifestBuf, "application/json");
    log(`   ✓ ${manifestKey}  (${manifestLen} byte)`);
    uploadedOk = true;

    // 7-retention. purge SOLO sotto production/postgres/, mai l'ultimo set
    log("→ retention ...");
    const allKeys = await r2ListPrefix(client, bucket);
    const plan = selectExpiredBackupSets(allKeys, now);
    if (plan.expiredKeys.length > 0) {
      const safe = plan.expiredKeys.filter(
        (k) => k.startsWith(`${PG_BACKUP_R2_PREFIX}/`) && !k.includes(base),
      );
      if (safe.length !== plan.expiredKeys.length) fail("retention: rilevata chiave fuori scope, interrotta per sicurezza.");
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: safe.map((Key) => ({ Key })) } }));
      log(`   eliminati ${safe.length} oggetti (${plan.expire.length} set oltre ${PG_BACKUP_RETENTION_DAYS}gg). Ultimo set mantenuto: ${plan.newestKeptBase}`);
    } else {
      log(`   nessun set da eliminare. Ultimo set: ${plan.newestKeptBase}`);
    }

    // 11. riepilogo
    console.log("\n─── RIEPILOGO ─────────────────────────────────────────────");
    console.log(`  base:        ${base}`);
    console.log(`  artefatti:   ${manifest.totals.artifact_count}  ·  ${manifest.totals.total_size_bytes} byte totali`);
    console.log(`  verifica:    overall=${manifest.verification.status}  public=${publicVerification.status}  auth=${authVerification.status}`);
    console.log(`  durata:      ${manifest.duration_ms} ms`);
    console.log(`  R2:          ${bucket}/${PG_BACKUP_R2_PREFIX}/`);
    console.log("───────────────────────────────────────────────────────────");

    await healthPing({
      status: "success",
      base_name: base,
      created_at: manifest.created_at,
      total_size_bytes: manifest.totals.total_size_bytes,
      artifact_count: manifest.totals.artifact_count,
      verification: manifest.verification.status,
      public_verification: publicVerification.status,
      auth_verification: authVerification.status,
      duration_ms: manifest.duration_ms,
      postgres_server_version: manifest.postgres_server_version,
      pg_dump_version: pgDumpVersion,
      retention_days: PG_BACKUP_RETENTION_DAYS,
    });

    if (manifest.verification.status === "passed") {
      console.log("\n🟢 BACKUP POSTGRES V3: OK\n");
    } else {
      console.log(`\n🟡 BACKUP POSTGRES V3: OK (verifica ${manifest.verification.status} — dump caricato e conservato)\n`);
    }
  } catch (e) {
    if (e?.message !== "__handled__") {
      console.error("\n🔴 " + redactSecrets(String(e?.message ?? e), SECRETS()));
    }
    await healthPing({
      status: "failed",
      base_name: base,
      error: redactSecrets(String(e?.message ?? e), SECRETS()).slice(0, 500),
      duration_ms: Date.now() - startedAt,
    }).catch(() => {});
    process.exitCode = 1;
  } finally {
    // 12. pulizia locale SOLO dopo upload/verifica (o su fallimento: comunque
    // non lasciamo il dump sul runner). In caso di upload riuscito ma errore
    // successivo, i file su R2 restano — corretto.
    if (!KEEP_LOCAL) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      log(`ℹ️  file temporanei rimossi (${uploadedOk ? "post upload+verifica" : "backup non completato"}).`);
    } else {
      log(`ℹ️  --keep-local: file temporanei mantenuti in ${workDir}`);
    }
  }
}

main().catch((e) => {
  if (e?.message !== "__handled__") console.error("\n🔴 Errore non gestito:", redactSecrets(String(e?.message ?? e), SECRETS()));
  process.exitCode = 1;
});
