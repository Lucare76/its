#!/usr/bin/env node
/**
 * ITS Disaster Recovery V4 — copia off-provider dei bucket Supabase Storage
 * importanti (vehicle-documents, vehicle-damage-photos, service-photos) su
 * Cloudflare R2. Additivo: NON tocca DR V2 (JSON), DR V3 (PostgreSQL), ne'
 * modifica/cancella MAI nulla lato Supabase (solo list + download, sola
 * lettura sui bucket sorgente).
 *
 * Eseguito da .github/workflows/storage-backup.yml (GitHub Actions):
 *   pnpm exec tsx scripts/storage-backup.mjs [--dry-run]
 *
 * FLAG:
 *   --dry-run   elenca bucket/file target e calcola cosa verrebbe caricato,
 *               SENZA scaricare/caricare nulla, senza toccare R2, senza
 *               scrivere manifest, senza inviare health report.
 *
 * ENV richieste (mai stampate):
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT
 * ENV opzionali (health ping, Layer 8, stesso pattern di DR V3):
 *   DR_HEALTH_REPORT_URL   es. https://<app>/api/cron/storage-backup-report
 *   DR_HEALTH_REPORT_SECRET
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";

// Import dinamico del modulo .ts — stesso pattern di scripts/postgres-backup.mjs.
const {
  STORAGE_BACKUP_BUCKETS,
  STORAGE_BACKUP_MANIFEST_PREFIX,
  missingStorageBackupEnv,
  sanitizeSourcePath,
  buildMirrorR2Key,
  buildHistoryR2Key,
  buildManifestR2Key,
  parseHistoryKey,
  walkStorageObjects,
  planIncrementalBackup,
  planDryRunBucketSummary,
  priorStateFromManifestObjects,
  verifyUpload,
  buildStorageBackupManifest,
  classifyStorageBackupRunStatus,
  selectExpiredHistoryVersions,
  redactStorageSecrets,
} = await import("../lib/server/storage-backup.ts");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

const EXTRA_SECRETS = [];
const SECRETS = () => [
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY,
  process.env.DR_HEALTH_REPORT_SECRET,
  ...EXTRA_SECRETS,
];

function log(msg) {
  console.log(redactStorageSecrets(String(msg), SECRETS()));
}
function fail(msg) {
  console.error("\n🔴 " + redactStorageSecrets(String(msg), SECRETS()));
  process.exitCode = 1;
  throw new Error("__handled__");
}

function adminClient() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim().replace(/^["']|["']$/g, "");
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim().replace(/^["']|["']$/g, "");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// Stessa costruzione client di scripts/postgres-backup.mjs (DR V3, verificata
// funzionante) — SOLO trim, nessuno strip di virgolette (vedi commit
// "fix: repair legacy backup offsite export" per il perche').
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
    log(`⚠️  Health ping fallito (non blocca il backup): ${redactStorageSecrets(String(e?.message ?? e), SECRETS())}`);
  }
}

/** Elenca una singola "pagina" di una cartella Supabase Storage — iniettato in walkStorageObjects. */
function makeListPage(admin, bucket) {
  return async (folderPath, offset) => {
    const { data, error } = await admin.storage
      .from(bucket)
      .list(folderPath, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    return data ?? [];
  };
}

async function downloadObject(admin, bucket, path) {
  const { data: blob, error } = await admin.storage.from(bucket).download(path);
  if (error || !blob) throw new Error(error?.message ?? "download vuoto");
  const arrayBuffer = await blob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function uploadAndVerify(r2, r2Bucket, key, buffer, contentType, metadata) {
  await r2.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      Metadata: metadata,
    }),
  );
  const head = await r2.send(new HeadObjectCommand({ Bucket: r2Bucket, Key: key }));
  return verifyUpload(buffer.length, head.ContentLength);
}

/** Legge production/storage/manifests/latest.json — assente/illeggibile -> {} (fallback sicuro: tutto "new"). */
async function readLatestManifest(r2, r2Bucket) {
  try {
    const res = await r2.send(new GetObjectCommand({ Bucket: r2Bucket, Key: `${STORAGE_BACKUP_MANIFEST_PREFIX}/latest.json` }));
    const text = await res.Body.transformToString("utf-8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function r2ListAllUnderPrefix(r2, r2Bucket, prefix) {
  const objects = [];
  let ContinuationToken;
  do {
    const res = await r2.send(new ListObjectsV2Command({ Bucket: r2Bucket, Prefix: prefix, ContinuationToken }));
    for (const o of res.Contents ?? []) if (o.Key) objects.push({ key: o.Key, lastModified: o.LastModified ?? new Date(0) });
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

async function processBucket(admin, r2, r2Bucket, cfg, runId, priorState, dryRun) {
  const result = {
    bucket: cfg.bucket,
    tier: cfg.tier,
    status: "success",
    file_count: 0,
    uploaded_count: 0,
    skipped_count: 0,
    failed_count: 0,
    total_bytes: 0,
    errors: [],
    objects: [],
  };

  let objects;
  try {
    objects = await walkStorageObjects(makeListPage(admin, cfg.bucket));
  } catch (e) {
    result.status = "failed";
    result.errors.push(`list fallita: ${redactStorageSecrets(String(e?.message ?? e), SECRETS())}`);
    log(`🔴 [${cfg.bucket}] impossibile enumerare il bucket — bucket NON backuppato: ${e?.message ?? e}`);
    return result;
  }

  result.file_count = objects.length;

  if (dryRun) {
    // Nessuna chiamata I/O da qui in poi per questo bucket: planDryRunBucketSummary
    // non riceve ne' un client Supabase ne' un client R2 — impossibile per
    // costruzione che scarichi/carichi/cancelli alcunche'.
    const summary = planDryRunBucketSummary(objects, priorState[cfg.bucket] ?? {});
    result.uploaded_count = summary.would_upload_count; // "sarebbe caricato"
    result.skipped_count = summary.would_skip_count;
    result.total_bytes = summary.total_bytes;
    log(`   [${cfg.bucket}] ${summary.file_count} file totali, ${summary.would_upload_count} sarebbero caricati, ${summary.would_skip_count} invariati`);
    return result;
  }

  const plan = planIncrementalBackup(objects, priorState[cfg.bucket] ?? {});
  const planByPath = new Map(plan.map((p) => [p.path, p]));
  log(`   [${cfg.bucket}] ${objects.length} file totali, ${plan.filter((p) => p.action === "upload").length} da caricare, ${plan.filter((p) => p.action === "skip").length} invariati`);

  for (const obj of objects) {
    const decision = planByPath.get(obj.path);
    const safePath = sanitizeSourcePath(obj.path);
    if (!safePath) {
      result.failed_count += 1;
      result.errors.push(`path sospetto scartato: ${obj.path.slice(0, 80)}`);
      result.objects.push({ source_path: obj.path, r2_key: "", size: obj.size, checksum: null, updated_at: null, status: "failed" });
      continue;
    }

    if (decision?.action === "skip") {
      result.skipped_count += 1;
      result.total_bytes += obj.size;
      result.objects.push({
        source_path: safePath,
        r2_key: cfg.versioned ? "" : buildMirrorR2Key(cfg.bucket, safePath),
        size: obj.size,
        checksum: obj.etag,
        updated_at: obj.updatedAt,
        status: "skipped",
      });
      continue;
    }

    const r2Key = cfg.versioned ? buildHistoryR2Key(cfg.bucket, runId, safePath) : buildMirrorR2Key(cfg.bucket, safePath);
    try {
      const buffer = await downloadObject(admin, cfg.bucket, safePath);
      const contentType = "application/octet-stream";
      const verified = await uploadAndVerify(r2, r2Bucket, r2Key, buffer, contentType, {
        "supabase-updated-at": obj.updatedAt ?? "",
        "supabase-etag": obj.etag ?? "",
      });
      if (!verified) throw new Error("verifica HeadObject fallita (size non coincide)");
      result.uploaded_count += 1;
      result.total_bytes += buffer.length;
      result.objects.push({
        source_path: safePath,
        r2_key: r2Key,
        size: buffer.length,
        checksum: obj.etag,
        updated_at: obj.updatedAt,
        status: "uploaded",
      });
      log(`   ✓ [${cfg.bucket}] ${safePath} -> ${r2Key} (${buffer.length} byte)`);
    } catch (e) {
      result.failed_count += 1;
      const message = redactStorageSecrets(String(e?.message ?? e), SECRETS());
      result.errors.push(`${safePath}: ${message}`);
      result.objects.push({ source_path: safePath, r2_key: r2Key, size: obj.size, checksum: null, updated_at: null, status: "failed" });
      log(`   🔴 [${cfg.bucket}] ${safePath}: ${message}`);
    }
  }

  if (result.failed_count > 0) result.status = "warning";
  return result;
}

async function purgeExpiredHistory(r2, r2Bucket, cfg, now) {
  if (!cfg.versioned) return { deleted: 0 };
  const prefix = `production/storage/${cfg.bucket}/history/`;
  const all = await r2ListAllUnderPrefix(r2, r2Bucket, prefix);
  const versions = all
    .map((o) => {
      const parsed = parseHistoryKey(cfg.bucket, o.key);
      return parsed ? { r2Key: o.key, originalPath: parsed.originalPath, lastModified: o.lastModified } : null;
    })
    .filter((v) => v !== null);

  const { expire } = selectExpiredHistoryVersions(versions, now, cfg.retentionDays);
  if (expire.length === 0) return { deleted: 0 };
  await r2.send(
    new DeleteObjectsCommand({
      Bucket: r2Bucket,
      Delete: { Objects: expire.map((v) => ({ Key: v.r2Key })) },
    }),
  );
  return { deleted: expire.length };
}

async function main() {
  const startedAt = Date.now();
  const now = new Date();
  const runId = `storage_${now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}_${randomUUID().slice(0, 8)}`;
  const runner = process.env.GITHUB_ACTIONS ? "github-actions" : "manual";

  console.log("🗂️  ITS DISASTER RECOVERY V4 — Backup file Supabase Storage");
  console.log(`   Modalita': ${DRY_RUN ? "DRY-RUN (nessun download/upload, R2 e Supabase non toccati)" : "ESECUZIONE REALE"}`);
  console.log(`   Runner:    ${runner}`);
  console.log(`   Run id:    ${runId}`);

  const missing = missingStorageBackupEnv(process.env);
  if (missing.length) fail(`env mancanti: ${missing.join(", ")}`);

  const admin = adminClient();
  const r2 = r2Client();
  const r2Bucket = (process.env.R2_BUCKET_NAME ?? "").trim();

  console.log("\n─── PIANO ─────────────────────────────────────────────────");
  for (const cfg of STORAGE_BACKUP_BUCKETS) {
    console.log(`  ${cfg.bucket}  (Tier ${cfg.tier}, retention ${cfg.retentionDays}gg, ${cfg.versioned ? "versionato" : "mirror"})`);
  }
  console.log(`  R2 bucket: ${r2Bucket}   prefix: production/storage/`);
  console.log("───────────────────────────────────────────────────────────\n");

  // Lettura del manifest precedente (sola lettura, GetObject — nessuna
  // modifica a R2): fatta anche in dry-run, cosi' il conteggio "sarebbe
  // caricato" riflette lo stato incrementale reale invece di considerare
  // sempre tutto nuovo.
  let priorState = {};
  const priorManifest = await readLatestManifest(r2, r2Bucket);
  if (priorManifest) {
    for (const b of priorManifest.buckets ?? []) {
      priorState[b.bucket] = priorStateFromManifestObjects(b.objects ?? []);
    }
    log(`ℹ️  manifest precedente trovato (run ${priorManifest.run_id ?? "?"}), stato incrementale caricato.`);
  } else {
    log("ℹ️  nessun manifest precedente leggibile — primo run o manifest assente: tutto verra' considerato nuovo.");
  }

  const bucketResults = [];
  for (const cfg of STORAGE_BACKUP_BUCKETS) {
    const result = await processBucket(admin, r2, r2Bucket, cfg, runId, priorState, DRY_RUN);
    bucketResults.push(result);
  }

  const manifest = buildStorageBackupManifest({ runId, now, dryRun: DRY_RUN, buckets: bucketResults });

  console.log("\n─── RIEPILOGO ─────────────────────────────────────────────");
  for (const b of bucketResults) {
    console.log(`  ${b.bucket}: ${b.status}  caricati=${b.uploaded_count} invariati=${b.skipped_count} falliti=${b.failed_count} (${b.file_count} totali)`);
  }
  console.log(`  totale byte: ${manifest.totals.total_bytes}`);
  console.log("───────────────────────────────────────────────────────────");

  if (DRY_RUN) {
    log("\n✅ DRY-RUN completato: nessun file scaricato/caricato, R2 e Supabase non modificati.\n");
    return;
  }

  // Manifest: copia storica per-run + puntatore "latest" (sola per lo stato incrementale, sovrascritto ad ogni run — non e' un backup, e' solo un indice).
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), "utf-8");
  await r2.send(new PutObjectCommand({ Bucket: r2Bucket, Key: buildManifestR2Key(runId), Body: manifestBuf, ContentType: "application/json" }));
  await r2.send(new PutObjectCommand({ Bucket: r2Bucket, Key: `${STORAGE_BACKUP_MANIFEST_PREFIX}/latest.json`, Body: manifestBuf, ContentType: "application/json" }));
  log(`   ✓ manifest salvato: ${buildManifestR2Key(runId)}`);

  // Retention: solo bucket versionati (service-photos) — mai l'ultima versione nota per path.
  log("→ retention (solo bucket versionati) ...");
  for (const cfg of STORAGE_BACKUP_BUCKETS) {
    const { deleted } = await purgeExpiredHistory(r2, r2Bucket, cfg, now);
    if (deleted > 0) log(`   [${cfg.bucket}] eliminate ${deleted} versioni storiche oltre ${cfg.retentionDays}gg (ultima versione per path sempre conservata)`);
  }

  const overallStatus = classifyStorageBackupRunStatus(bucketResults);
  await healthPing({
    status: overallStatus,
    run_id: runId,
    dry_run: false,
    duration_ms: Date.now() - startedAt,
    total_uploaded: manifest.totals.uploaded_count,
    total_skipped: manifest.totals.skipped_count,
    total_failed: manifest.totals.failed_count,
    total_bytes: manifest.totals.total_bytes,
    manifest_r2_key: buildManifestR2Key(runId),
    buckets: bucketResults.map((b) => ({
      bucket: b.bucket,
      tier: b.tier,
      status: b.status,
      file_count: b.file_count,
      uploaded_count: b.uploaded_count,
      skipped_count: b.skipped_count,
      failed_count: b.failed_count,
      total_bytes: b.total_bytes,
      error: b.errors[0]?.slice(0, 300),
    })),
  });

  if (overallStatus === "failed") {
    console.log("\n🔴 BACKUP STORAGE V4: almeno un bucket Tier A non backuppato\n");
    process.exitCode = 1;
  } else if (overallStatus === "warning") {
    console.log("\n🟡 BACKUP STORAGE V4: completato con avvisi (vedi errors per bucket)\n");
  } else {
    console.log("\n🟢 BACKUP STORAGE V4: OK\n");
  }
}

main().catch((e) => {
  if (e?.message !== "__handled__") console.error("\n🔴 Errore non gestito:", redactStorageSecrets(String(e?.message ?? e), SECRETS()));
  process.exitCode = 1;
});
