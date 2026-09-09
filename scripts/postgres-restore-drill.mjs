#!/usr/bin/env node
/**
 * ITS Disaster Recovery V3 — RESTORE DRILL (pg_restore verso un progetto Supabase DI TEST).
 *
 * Scarica (sola lettura) l'ultimo set its_full_<ts>.* da Cloudflare R2,
 * verifica gli hash contro il manifest, verifica strutturalmente i dump con
 * `pg_restore --list`, e — solo se esplicitamente confermato — ripristina
 * PUBLIC e AUTH su un target di TEST separato dalla produzione.
 *
 * NON E' UN RESTORE DI PRODUZIONE. Questo script non si connette MAI a
 * SUPABASE_DB_URL (produzione): quella env viene letta SOLO per confrontarla
 * col target e rifiutarsi di partire se coincidono o si assomigliano.
 *
 * USO:
 *   # 1) dry-run (default) — scarica, verifica hash e struttura, stampa il piano.
 *   #    Nessuna scrittura, RESTORE_TARGET_CONFIRM non richiesta.
 *   RESTORE_TARGET_DB_URL=postgresql://postgres.<test-ref>:<pwd>@aws-0-<region>.pooler.supabase.com:5432/postgres \
 *   SUPABASE_DB_URL=<produzione, solo per il confronto> \
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET_NAME=... R2_ENDPOINT=... \
 *   node scripts/postgres-restore-drill.mjs --dry-run
 *
 *   # 2) restore reale sul target di test
 *   RESTORE_TARGET_CONFIRM=I_UNDERSTAND_THIS_IS_TEST_ONLY \
 *   ...stesse env... \
 *   node scripts/postgres-restore-drill.mjs --confirm-restore
 *
 * FLAG:
 *   --dry-run          (default) scarica + verifica hash/struttura, nessuna scrittura.
 *   --confirm-restore  esegue davvero il restore (richiede RESTORE_TARGET_CONFIRM).
 *   --base <name>       usa questo set (es. its_full_2026-09-09_13-39) invece del piu' recente.
 *   --keep-local        non cancella i file scaricati al termine (debug).
 *
 * ENV richieste:
 *   RESTORE_TARGET_DB_URL   Session Pooler URI del progetto Supabase DI TEST (porta 5432).
 *   RESTORE_TARGET_CONFIRM  deve valere esattamente I_UNDERSTAND_THIS_IS_TEST_ONLY
 *                           (richiesta solo per --confirm-restore, MAI in dry-run).
 *   SUPABASE_DB_URL         Session Pooler URI di PRODUZIONE — SOLO per il confronto
 *                           di sicurezza. Questo script non apre MAI una connessione
 *                           verso questa URI.
 *   R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET_NAME R2_ENDPOINT
 *                           stesse credenziali del backup, usate qui SOLO in lettura
 *                           (GetObject / ListObjectsV2 — mai Put/Delete).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const {
  PG_BACKUP_R2_PREFIX,
  PG_BACKUP_AUTH_TABLES,
  PG_BACKUP_CHECK_TABLES,
  backupR2Key,
  sha256Hex,
  verifyRestoreList,
  verifyAuthRestoreList,
  redactSecrets,
  maskConnectionString,
  parsePgMajorFromVersionLine,
  pgClientToolsConsistent,
  pgClientToolsMessage,
  splitPgConnString,
  buildPgChildEnv,
} = await import("../lib/server/postgres-backup.ts");

const { assertRestoreTargetIsSafe, reorderAuthRestoreList, filterOutPublicSchemaCreation } = await import(
  "../lib/server/postgres-restore-drill.ts"
);

// Tabelle di smoke-test applicative richieste dal drill, oltre a PG_BACKUP_CHECK_TABLES.
const SMOKE_TABLES = [
  ...new Set([...PG_BACKUP_CHECK_TABLES, "agency_bookings", "driver_profiles", "vehicles", "tenant_bus_lines"]),
];

const args = process.argv.slice(2);
const CONFIRM_RESTORE = args.includes("--confirm-restore");
const DRY_RUN = !CONFIRM_RESTORE; // dry-run e' il default assoluto: serve un flag esplicito per scrivere.
const KEEP_LOCAL = args.includes("--keep-local");
const baseArgIdx = args.indexOf("--base");
const REQUESTED_BASE = baseArgIdx !== -1 ? args[baseArgIdx + 1] : null;

const EXTRA_SECRETS = [];
const SECRETS = () => [
  process.env.RESTORE_TARGET_DB_URL,
  process.env.SUPABASE_DB_URL,
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY,
  ...EXTRA_SECRETS,
];

function log(msg) {
  console.log(redactSecrets(String(msg), SECRETS()));
}
function fail(msg) {
  console.error("\n🔴 STOP — " + redactSecrets(String(msg), SECRETS()));
  process.exitCode = 1;
  throw new Error("__handled__");
}

function run(cmd, argv, { captureStdout = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ["ignore", captureStdout ? "pipe" : "inherit", "pipe"], env });
    let out = "";
    let err = "";
    if (captureStdout) child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => reject(new Error(`spawn ${cmd} fallito: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new Error(`${cmd} uscito con codice ${code} (fail-fast). stderr: ${redactSecrets(err.slice(-2000), SECRETS())}`));
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function r2GetObject(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return streamToBuffer(res.Body);
}

/** Elenca i base-name (its_full_YYYY-MM-DD_HH-mm) disponibili sotto il prefix, piu' recente prima. */
async function r2ListBases(client, bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: `${PG_BACKUP_R2_PREFIX}/`, ContinuationToken }),
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  const bases = new Set();
  for (const k of keys) {
    const m = k.match(/its_full_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})(?:\.auth)?\.dump$|its_full_(\d{4}-\d{2}-\d{2}_\d{2}-\d{2})\.manifest\.json$/);
    if (m) bases.add(`its_full_${m[1] ?? m[2]}`);
  }
  return [...bases].sort().reverse();
}

function timer() {
  const marks = {};
  return {
    mark(name) {
      marks[name] = Date.now();
    },
    ms(from, to) {
      return marks[to] - marks[from];
    },
    marks,
  };
}

async function main() {
  const t = timer();
  t.mark("script_start");

  console.log("🧪 ITS DISASTER RECOVERY V3 — RESTORE DRILL");
  console.log(`   Modalita': ${DRY_RUN ? "DRY-RUN (nessuna scrittura)" : "RESTORE REALE su target di TEST"}`);

  // 0. GUARDIA — prima di qualunque altra cosa, prima di toccare R2.
  const targetDsnRaw = process.env.RESTORE_TARGET_DB_URL;
  const prodDsnRaw = process.env.SUPABASE_DB_URL;
  const guard = assertRestoreTargetIsSafe({
    targetDsn: targetDsnRaw,
    prodDsn: prodDsnRaw,
    confirmEnvValue: process.env.RESTORE_TARGET_CONFIRM,
    requireConfirm: !DRY_RUN,
  });
  if (!guard.safe) {
    fail(`target di restore non sicuro:\n   - ${guard.reasons.join("\n   - ")}`);
  }
  log(`   Target:  ${maskConnectionString(targetDsnRaw)}  (guardia anti-produzione superata)`);
  if (prodDsnRaw) log(`   Prod:    ${maskConnectionString(prodDsnRaw)}  (solo per confronto — MAI connesso)`);

  const { dsn: targetDsn, password: targetPassword } = splitPgConnString(targetDsnRaw);
  if (targetPassword) EXTRA_SECRETS.push(targetPassword);
  const targetChildEnv = buildPgChildEnv(process.env, targetPassword, { PGCONNECT_TIMEOUT: "15" });

  // 1. tool check — stessa regola del backup: pg_dump/pg_restore/psql devono essere major 17 e coerenti.
  const pgRestoreVersion = await toolVersion("pg_restore");
  const psqlVersion = await toolVersion("psql");
  const pgDumpVersion = await toolVersion("pg_dump");
  if (!pgRestoreVersion) fail("pg_restore non trovato nel PATH.");
  if (!psqlVersion) fail("psql non trovato nel PATH.");
  if (!pgDumpVersion) fail("pg_dump non trovato nel PATH (richiesto solo per il check di coerenza major, non viene eseguito).");
  const majors = {
    pg_dump: parsePgMajorFromVersionLine(pgDumpVersion),
    pg_restore: parsePgMajorFromVersionLine(pgRestoreVersion),
    psql: parsePgMajorFromVersionLine(psqlVersion),
  };
  if (!pgClientToolsConsistent(majors.pg_dump, majors.pg_restore, majors.psql)) {
    fail(pgClientToolsMessage(majors));
  }
  if (majors.pg_restore !== 17) {
    fail(`pg_restore major ${majors.pg_restore}: il drill richiede PostgreSQL client 17 (come il backup).`);
  }
  log(`   pg_restore: ${pgRestoreVersion}  ·  psql: ${psqlVersion}  (major 17 ✓)`);

  const bucket = (process.env.R2_BUCKET_NAME ?? "").trim();
  if (!bucket) fail("R2_BUCKET_NAME mancante.");
  const client = r2Client();

  // 2. individua il set (base name) da usare
  t.mark("r2_discovery_start");
  const bases = await r2ListBases(client, bucket);
  if (bases.length === 0) fail(`nessun set its_full_* trovato sotto ${PG_BACKUP_R2_PREFIX}/ nel bucket ${bucket}.`);
  const base = REQUESTED_BASE ?? bases[0];
  if (!bases.includes(base)) fail(`set richiesto "${base}" non trovato su R2. Disponibili: ${bases.join(", ")}`);
  log(`   Set backup: ${base}  (${REQUESTED_BASE ? "richiesto" : "piu' recente disponibile"} · ${bases.length} set totali su R2)`);

  const fullName = `${base}.dump`;
  const authName = `${base}.auth.dump`;
  const manifestName = `${base}.manifest.json`;

  const workDir = await mkdtemp(join(tmpdir(), "its-restore-drill-"));
  const fullPath = join(workDir, fullName);
  const authPath = join(workDir, authName);

  try {
    // 3. FASE 4 — download read-only da R2
    log("→ download R2 (sola lettura) ...");
    t.mark("download_start");
    const [fullBuf, authBuf, manifestBuf] = await Promise.all([
      r2GetObject(client, bucket, backupR2Key(fullName)),
      r2GetObject(client, bucket, backupR2Key(authName)),
      r2GetObject(client, bucket, backupR2Key(manifestName)),
    ]);
    await writeFile(fullPath, fullBuf);
    await writeFile(authPath, authBuf);
    t.mark("download_end");
    log(`   ✓ scaricati ${fullName} (${fullBuf.length} byte), ${authName} (${authBuf.length} byte), ${manifestName} (${manifestBuf.length} byte) in ${t.ms("download_start", "download_end")}ms`);

    let manifest;
    try {
      manifest = JSON.parse(manifestBuf.toString("utf-8"));
    } catch (e) {
      fail(`manifest ${manifestName} non e' JSON valido: ${e.message}`);
    }
    log(`   Manifest: backup del ${manifest.created_at} · pg_dump ${manifest.pg_dump_version} · server ${manifest.postgres_server_version}`);

    // 4. hash validation contro il manifest — STOP su qualunque mismatch
    log("→ verifica SHA-256 contro il manifest ...");
    const artifactByName = new Map((manifest.artifacts ?? []).map((a) => [a.filename, a]));
    const hashChecks = [
      { name: fullName, buf: fullBuf },
      { name: authName, buf: authBuf },
    ];
    for (const { name, buf } of hashChecks) {
      const expected = artifactByName.get(name);
      if (!expected) fail(`${name} non e' elencato negli artifacts del manifest.`);
      const actual = sha256Hex(buf);
      const sizeOk = buf.length === expected.size_bytes;
      const hashOk = actual.toLowerCase() === String(expected.sha256 ?? "").toLowerCase();
      log(`   ${hashOk && sizeOk ? "✓" : "✗"} ${name}: size ${buf.length}/${expected.size_bytes}  sha256 ${actual.slice(0, 12)}…/${String(expected.sha256).slice(0, 12)}…`);
      if (!sizeOk || !hashOk) fail(`${name}: hash o dimensione NON corrispondono al manifest. Il file potrebbe essere corrotto o alterato — restore interrotto.`);
    }
    t.mark("hash_verify_end");

    // 5. verifica strutturale — pg_restore --list PRIMA di tentare qualunque restore
    log("→ pg_restore --list (verifica strutturale) ...");
    const { stdout: fullListOut } = await run("pg_restore", ["--list", fullPath], { captureStdout: true });
    const publicVerification = verifyRestoreList(fullListOut);
    log(`   PUBLIC: ${publicVerification.pg_restore_list_entries} voci · status=${publicVerification.status}`);
    if (publicVerification.status === "failed") fail(`dump PUBLIC strutturalmente non valido: ${publicVerification.notes.join("; ")}`);

    const { stdout: authListOut } = await run("pg_restore", ["--list", authPath], { captureStdout: true });
    const authVerification = verifyAuthRestoreList(authListOut);
    log(`   AUTH:   ${authVerification.pg_restore_list_entries} voci · status=${authVerification.status} · tabelle: ${authVerification.tables_present.join(", ")}`);
    if (authVerification.status !== "passed") fail(`dump AUTH strutturalmente non valido: ${authVerification.notes.join("; ")}`);
    t.mark("structural_verify_end");

    const publicListFiltered = filterOutPublicSchemaCreation(fullListOut);
    const authListReordered = reorderAuthRestoreList(authListOut, PG_BACKUP_AUTH_TABLES);
    const publicListPath = join(workDir, "public.list");
    const authListPath = join(workDir, "auth.list");
    await writeFile(publicListPath, publicListFiltered, "utf-8");
    await writeFile(authListPath, authListReordered, "utf-8");

    console.log("\n─── PIANO RESTORE DRILL ─────────────────────────────────────");
    console.log(`  Set:              ${base}`);
    console.log(`  Target:           ${maskConnectionString(targetDsnRaw)}`);
    console.log(`  1) restore PUBLIC: pg_restore --use-list=public.list (schema 'public' gia' esistente escluso, --clean/--create MAI usati)`);
    console.log(`  2) restore AUTH:   pg_restore --use-list=auth.list (ordine: ${PG_BACKUP_AUTH_TABLES.join(" -> ")})`);
    console.log(`  3) verifiche post-restore: conteggi tabelle chiave, orfani FK, smoke query`);
    console.log("───────────────────────────────────────────────────────────\n");

    if (DRY_RUN) {
      log("✅ DRY-RUN completato: download + hash + verifica strutturale OK. Nessuna scrittura eseguita.");
      log("   Rilancia con --confirm-restore (e RESTORE_TARGET_CONFIRM impostata) per il restore reale sul target di test.");
      return;
    }

    // 6. FASE 5A — restore PUBLIC (mai --clean/--create; use-list esclude solo la riga SCHEMA public)
    log("→ pg_restore PUBLIC sul target di test ...");
    t.mark("restore_public_start");
    await run(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", `--use-list=${publicListPath}`, "--dbname", targetDsn, fullPath],
      { env: targetChildEnv },
    );
    t.mark("restore_public_end");
    log(`   ✓ restore PUBLIC completato in ${t.ms("restore_public_start", "restore_public_end")}ms`);

    // 7. FASE 5B — restore AUTH selettivo, ordine users -> identities -> mfa_*
    log("→ pg_restore AUTH sul target di test (ordine dipendenze FK) ...");
    t.mark("restore_auth_start");
    await run(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", `--use-list=${authListPath}`, "--dbname", targetDsn, authPath],
      { env: targetChildEnv },
    );
    t.mark("restore_auth_end");
    log(`   ✓ restore AUTH completato in ${t.ms("restore_auth_start", "restore_auth_end")}ms`);

    // 8. FASE 6 — verifiche post-restore (read-only via psql)
    log("→ verifiche post-restore ...");
    t.mark("verify_start");
    const report = { tableCounts: [], fkOrphans: [], sequenceIssues: [], smokeQueries: [] };

    async function psqlScalar(sql) {
      const { stdout } = await run("psql", [targetDsn, "-tAX", "-c", sql], { captureStdout: true, env: targetChildEnv });
      return stdout.trim();
    }

    for (const table of SMOKE_TABLES) {
      try {
        const count = await psqlScalar(`SELECT COUNT(*) FROM public.${table}`);
        report.tableCounts.push({ table, count: Number(count), ok: true });
      } catch (e) {
        report.tableCounts.push({ table, count: null, ok: false, error: e.message });
      }
    }
    for (const t2 of ["auth.users", "auth.identities"]) {
      try {
        const count = await psqlScalar(`SELECT COUNT(*) FROM ${t2}`);
        report.tableCounts.push({ table: t2, count: Number(count), ok: true });
      } catch (e) {
        report.tableCounts.push({ table: t2, count: null, ok: false, error: e.message });
      }
    }

    const fkPairs = [
      ["assignments", "service_id", "services", "id"],
      ["services", "tenant_id", "tenants", "id"],
      ["tenant_bus_allocations", "service_id", "services", "id"],
      ["booking_group_stops", "booking_group_id", "booking_groups", "id"],
      ["auth.identities", "user_id", "auth.users", "id"],
    ];
    for (const [childTable, childCol, parentTable, parentCol] of fkPairs) {
      const childRef = childTable.includes(".") ? childTable : `public.${childTable}`;
      const parentRef = parentTable.includes(".") ? parentTable : `public.${parentTable}`;
      try {
        const orphans = await psqlScalar(
          `SELECT COUNT(*) FROM ${childRef} c WHERE c.${childCol} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${parentRef} p WHERE p.${parentCol} = c.${childCol})`,
        );
        report.fkOrphans.push({ check: `${childTable}.${childCol} -> ${parentTable}.${parentCol}`, orphans: Number(orphans), ok: Number(orphans) === 0 });
      } catch (e) {
        report.fkOrphans.push({ check: `${childTable}.${childCol} -> ${parentTable}.${parentCol}`, orphans: null, ok: false, error: e.message });
      }
    }

    try {
      const seqOut = await psqlScalar(
        "SELECT COALESCE(string_agg(c.relname || ':' || CASE WHEN pg_sequence_last_value(c.oid) IS NULL THEN 'UNUSED' ELSE 'OK' END, ', '), 'nessuna sequence trovata') FROM pg_class c WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace",
      );
      report.sequenceIssues.push({ note: seqOut });
    } catch (e) {
      report.sequenceIssues.push({ note: `controllo sequence non eseguibile: ${e.message}` });
    }

    for (const table of ["services", "booking_groups", "tenant_bus_allocations", "hotels", "agencies", "driver_profiles", "vehicles"]) {
      try {
        const oneRow = await psqlScalar(`SELECT 1 FROM public.${table} LIMIT 1`);
        report.smokeQueries.push({ table, queryable: true, hasRows: oneRow === "1" });
      } catch (e) {
        report.smokeQueries.push({ table, queryable: false, error: e.message });
      }
    }
    t.mark("verify_end");

    console.log("\n─── VERIFICHE POST-RESTORE ──────────────────────────────────");
    for (const c of report.tableCounts) console.log(`  ${c.ok ? "✅" : "❌"} ${c.table.padEnd(28)} righe=${c.ok ? c.count : "ERRORE: " + c.error}`);
    console.log("  FK (orfani attesi = 0):");
    for (const f of report.fkOrphans) console.log(`    ${f.ok ? "✅" : "❌"} ${f.check.padEnd(48)} orfani=${f.ok ? f.orphans : "ERRORE: " + f.error}`);
    console.log(`  Sequence: ${report.sequenceIssues.map((s) => s.note).join("; ")}`);
    console.log("  Smoke query:");
    for (const s of report.smokeQueries) console.log(`    ${s.queryable ? "✅" : "❌"} ${s.table.padEnd(20)} ${s.queryable ? "interrogabile" + (s.hasRows ? "" : " (0 righe)") : "ERRORE: " + s.error}`);
    console.log("───────────────────────────────────────────────────────────\n");

    // 9. FASE 7 — RPO/RTO
    const backupCreatedAt = new Date(manifest.created_at);
    const rpoMs = t.marks.script_start - backupCreatedAt.getTime();
    const rtoMs = Date.now() - t.marks.script_start;
    console.log("─── RPO / RTO ───────────────────────────────────────────────");
    console.log(`  Backup usato:        ${base}  (creato ${manifest.created_at})`);
    console.log(`  Drill iniziato:      ${new Date(t.marks.script_start).toISOString()}`);
    console.log(`  Download:            ${t.ms("download_start", "download_end")}ms`);
    console.log(`  Verifica hash+TOC:   ${t.ms("download_end", "structural_verify_end")}ms`);
    console.log(`  Restore PUBLIC:      ${t.ms("restore_public_start", "restore_public_end")}ms`);
    console.log(`  Restore AUTH:        ${t.ms("restore_auth_start", "restore_auth_end")}ms`);
    console.log(`  Verifiche:           ${t.ms("verify_start", "verify_end")}ms`);
    console.log(`  RPO osservato (eta' del backup usato rispetto all'avvio del drill): ${(rpoMs / 1000 / 60).toFixed(1)} minuti`);
    console.log(`  RTO misurato (avvio drill -> fine verifiche):                        ${(rtoMs / 1000).toFixed(1)} secondi`);
    console.log("───────────────────────────────────────────────────────────\n");

    const tableCountsOk = report.tableCounts.every((c) => c.ok);
    const fkOk = report.fkOrphans.every((f) => f.ok);
    const smokeOk = report.smokeQueries.every((s) => s.queryable);
    const overallPass = tableCountsOk && fkOk && smokeOk;

    console.log("─── REPORT FINALE ───────────────────────────────────────────");
    console.log(`  Backup utilizzato:      ${base}`);
    console.log(`  Target test:            ${maskConnectionString(targetDsnRaw)}`);
    console.log(`  Produzione modificata:  NO (mai connesso a SUPABASE_DB_URL)`);
    console.log(`  Hash validation:        PASS`);
    console.log(`  Restore public:         PASS`);
    console.log(`  Restore auth:           PASS`);
    console.log(`  Integrity checks:       ${tableCountsOk && fkOk ? "PASS" : "FAIL"}`);
    console.log(`  Smoke test applicativi: ${smokeOk ? "PASS" : "FAIL"}`);
    console.log(`  RPO osservato:          ${(rpoMs / 1000 / 60).toFixed(1)} min`);
    console.log(`  RTO misurato:           ${(rtoMs / 1000).toFixed(1)} s`);
    console.log(`  Verdict:                ${overallPass ? "🟢 DR RESTORE VERIFIED" : "🔴 DR RESTORE NOT VERIFIED"}`);
    console.log("───────────────────────────────────────────────────────────\n");

    if (!overallPass) process.exitCode = 1;
  } finally {
    if (!KEEP_LOCAL) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    } else {
      log(`ℹ️  --keep-local: file mantenuti in ${workDir}`);
    }
  }
}

main().catch((e) => {
  if (e?.message !== "__handled__") console.error("\n🔴 Restore drill error:", redactSecrets(String(e?.message ?? e), SECRETS()));
  process.exitCode = 1;
});
