import { describe, it, expect } from "vitest";
import {
  STORAGE_BACKUP_BUCKETS,
  STORAGE_BACKUP_R2_PREFIX,
  STORAGE_BACKUP_REQUIRED_ENV,
  missingStorageBackupEnv,
  getStorageBucketDrConfig,
  sanitizeSourcePath,
  buildMirrorR2Key,
  buildHistoryR2Key,
  buildManifestR2Key,
  parseHistoryKey,
  walkStorageObjects,
  planIncrementalBackup,
  priorStateFromManifestObjects,
  planDryRunBucketSummary,
  verifyUpload,
  buildStorageBackupManifest,
  classifyStorageBackupRunStatus,
  selectExpiredHistoryVersions,
  redactStorageSecrets,
  type StorageListEntry,
  type StorageObjectInfo,
  type StorageBackupBucketResult,
} from "@/lib/server/storage-backup";

// ─── FASE 1 audit decisions locked in as config assertions ─────────────────
describe("storage-backup — configurazione bucket (decisioni DR V4)", () => {
  it("2. Tier classification: esattamente vehicle-documents(A)/vehicle-damage-photos(B)/service-photos(B, versionato)", () => {
    expect(STORAGE_BACKUP_BUCKETS.map((b) => b.bucket)).toEqual(["vehicle-documents", "vehicle-damage-photos", "service-photos"]);
    expect(getStorageBucketDrConfig("vehicle-documents")).toMatchObject({ tier: "A", retentionDays: 365, versioned: false });
    expect(getStorageBucketDrConfig("vehicle-damage-photos")).toMatchObject({ tier: "B", retentionDays: 180, versioned: false });
    expect(getStorageBucketDrConfig("service-photos")).toMatchObject({ tier: "B", retentionDays: 180, versioned: true });
  });

  it("bus-qr-codes e backups sono deliberatamente ESCLUSI (nessuna config)", () => {
    expect(getStorageBucketDrConfig("bus-qr-codes")).toBeNull();
    expect(getStorageBucketDrConfig("backups")).toBeNull();
  });

  it("missingStorageBackupEnv rileva le env richieste mancanti", () => {
    expect(missingStorageBackupEnv({})).toEqual([...STORAGE_BACKUP_REQUIRED_ENV]);
    const complete = Object.fromEntries(STORAGE_BACKUP_REQUIRED_ENV.map((k) => [k, "x"]));
    expect(missingStorageBackupEnv(complete)).toEqual([]);
  });
});

// ─── FASE 3: path mapping Supabase -> R2 ────────────────────────────────────
describe("storage-backup — path mapping Supabase -> R2", () => {
  it("3. mirror (bucket non versionati): production/storage/<bucket>/<path>, preserva path/filename originali", () => {
    expect(buildMirrorR2Key("vehicle-documents", "vehicle-1/libretto.pdf")).toBe(
      `${STORAGE_BACKUP_R2_PREFIX}/vehicle-documents/vehicle-1/libretto.pdf`,
    );
  });

  it("3. storico (bucket versionati): production/storage/<bucket>/history/<runId>/<path>", () => {
    expect(buildHistoryR2Key("service-photos", "storage_20260913_ab12cd34", "srv-1/interior.jpg")).toBe(
      `${STORAGE_BACKUP_R2_PREFIX}/service-photos/history/storage_20260913_ab12cd34/srv-1/interior.jpg`,
    );
  });

  it("manifest key: production/storage/manifests/<runId>.json", () => {
    expect(buildManifestR2Key("run-1")).toBe(`${STORAGE_BACKUP_R2_PREFIX}/manifests/run-1.json`);
  });

  it("parseHistoryKey inverte buildHistoryR2Key (round-trip)", () => {
    const key = buildHistoryR2Key("service-photos", "run-42", "medmar-ticket-memory/tenant-a/photo.jpg");
    expect(parseHistoryKey("service-photos", key)).toEqual({ runId: "run-42", originalPath: "medmar-ticket-memory/tenant-a/photo.jpg" });
  });

  it("parseHistoryKey ritorna null per chiavi fuori formato o di un altro bucket", () => {
    expect(parseHistoryKey("service-photos", "production/storage/vehicle-documents/history/run-1/x.pdf")).toBeNull();
    expect(parseHistoryKey("service-photos", "production/storage/service-photos/history/run-1")).toBeNull(); // manca il path
    expect(parseHistoryKey("service-photos", "production/postgres/its_full.dump")).toBeNull();
  });
});

// ─── FASE 10: path traversal protection ────────────────────────────────────
describe("storage-backup — sanitizeSourcePath (path traversal protection)", () => {
  it("15. accetta path normali, anche annidati", () => {
    expect(sanitizeSourcePath("vehicle-1/libretto.pdf")).toBe("vehicle-1/libretto.pdf");
    expect(sanitizeSourcePath("medmar-ticket-memory/tenant-a/123-foto.jpg")).toBe("medmar-ticket-memory/tenant-a/123-foto.jpg");
  });

  it("15. rifiuta path traversal (..), path assoluti, backslash, segmenti vuoti", () => {
    expect(sanitizeSourcePath("../../etc/passwd")).toBeNull();
    expect(sanitizeSourcePath("vehicle-1/../../../secret")).toBeNull();
    expect(sanitizeSourcePath("/etc/passwd")).toBeNull();
    expect(sanitizeSourcePath("C:\\Windows\\system.ini")).toBeNull();
    expect(sanitizeSourcePath("vehicle-1//doppio-slash.pdf")).toBeNull();
    expect(sanitizeSourcePath("")).toBeNull();
    expect(sanitizeSourcePath("   ")).toBeNull();
  });

  it("una chiave R2 costruita da un path rifiutato non può mai uscire dal prefix production/storage/<bucket>/", () => {
    const malicious = "../../../production/postgres/its_full.dump";
    expect(sanitizeSourcePath(malicious)).toBeNull(); // lo script scarta l'oggetto invece di costruire la chiave
  });
});

// ─── FASE 1: bucket discovery ricorsiva ─────────────────────────────────────
describe("storage-backup — walkStorageObjects (bucket discovery)", () => {
  function fakeTree(): Record<string, StorageListEntry[]> {
    return {
      "": [
        { name: "vehicle-1", id: null }, // cartella
        { name: "readme.txt", id: "file-0", updated_at: "2026-09-01T00:00:00Z", metadata: { size: 10, eTag: "e0" } },
      ],
      "vehicle-1": [
        { name: "libretto.pdf", id: "file-1", updated_at: "2026-09-01T00:00:00Z", metadata: { size: 1000, eTag: "e1" } },
        { name: "sub", id: null }, // sotto-cartella annidata
      ],
      "vehicle-1/sub": [
        { name: "extra.pdf", id: "file-2", updated_at: "2026-09-02T00:00:00Z", metadata: { size: 500, eTag: "e2" } },
      ],
    };
  }

  it("1. cammina ricorsivamente cartelle annidate a profondità arbitraria e raccoglie solo i file", async () => {
    const tree = fakeTree();
    const listPage = async (folderPath: string, offset: number) => (offset === 0 ? (tree[folderPath] ?? []) : []);
    const objects = await walkStorageObjects(listPage);
    const paths = objects.map((o) => o.path).sort();
    expect(paths).toEqual(["readme.txt", "vehicle-1/libretto.pdf", "vehicle-1/sub/extra.pdf"]);
  });

  it("1. pagina fino ad esaurimento (offset incrementale) quando una cartella supera pageSize", async () => {
    const page0 = Array.from({ length: 3 }, (_, i) => ({ name: `f${i}.jpg`, id: `id-${i}`, updated_at: null, metadata: { size: 1, eTag: null } }));
    const page1 = [{ name: "f3.jpg", id: "id-3", updated_at: null, metadata: { size: 1, eTag: null } }];
    const calls: Array<[string, number]> = [];
    const listPage = async (folderPath: string, offset: number) => {
      calls.push([folderPath, offset]);
      if (offset === 0) return page0;
      if (offset === 3) return page1;
      return [];
    };
    const objects = await walkStorageObjects(listPage, 3);
    expect(objects.map((o) => o.path).sort()).toEqual(["f0.jpg", "f1.jpg", "f2.jpg", "f3.jpg"]);
    expect(calls).toEqual([["", 0], ["", 3]]);
  });

  it("1. bucket vuoto -> nessun oggetto, nessun errore", async () => {
    const objects = await walkStorageObjects(async () => []);
    expect(objects).toEqual([]);
  });

  it("estrae size/updated_at/etag dagli entry, size=0 se metadata assente", async () => {
    const listPage = async (folderPath: string) =>
      folderPath === ""
        ? [{ name: "no-metadata.bin", id: "id-x", updated_at: null, metadata: null } as StorageListEntry]
        : [];
    const [obj] = await walkStorageObjects(listPage);
    expect(obj).toEqual({ path: "no-metadata.bin", size: 0, updatedAt: null, etag: null });
  });
});

// ─── FASE 4: backup incrementale ────────────────────────────────────────────
describe("storage-backup — planIncrementalBackup (FASE 4 incrementale)", () => {
  it("5. file nuovo (nessuno stato precedente) -> upload, reason 'new'", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: "e1" }];
    const [d] = planIncrementalBackup(objs, {});
    expect(d).toEqual({ path: "a.pdf", action: "upload", reason: "new" });
  });

  it("4. file invariato (eTag identico) -> skip", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: "e1" }];
    const prior = { "a.pdf": { size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: "e1" } };
    const [d] = planIncrementalBackup(objs, prior);
    expect(d).toEqual({ path: "a.pdf", action: "skip", reason: "unchanged" });
  });

  it("6. file modificato: eTag diverso -> upload (segnale prioritario)", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: "e2" }];
    const prior = { "a.pdf": { size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: "e1" } };
    const [d] = planIncrementalBackup(objs, prior);
    expect(d).toEqual({ path: "a.pdf", action: "upload", reason: "etag_changed" });
  });

  it("6. file modificato: updated_at diverso, senza eTag disponibile -> upload", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 100, updatedAt: "2026-09-02T00:00:00Z", etag: null }];
    const prior = { "a.pdf": { size: 100, updatedAt: "2026-09-01T00:00:00Z", etag: null } };
    const [d] = planIncrementalBackup(objs, prior);
    expect(d).toEqual({ path: "a.pdf", action: "upload", reason: "updated_at_changed" });
  });

  it("6. file modificato: solo size come segnale residuo (eTag e updated_at entrambi mancanti su un lato) -> upload", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 200, updatedAt: "2026-09-01T00:00:00Z", etag: null }];
    const prior = { "a.pdf": { size: 100, updatedAt: null, etag: null } };
    const [d] = planIncrementalBackup(objs, prior);
    expect(d.action).toBe("upload");
  });

  it("fallback sicuro e documentato: nessun segnale affidabile disponibile su ENTRAMBI i lati -> upload comunque (mai skip per incertezza)", () => {
    const objs: StorageObjectInfo[] = [{ path: "a.pdf", size: 100, updatedAt: null, etag: null }];
    const prior = { "a.pdf": { size: 100, updatedAt: null, etag: null } };
    const [d] = planIncrementalBackup(objs, prior);
    expect(d).toEqual({ path: "a.pdf", action: "upload", reason: "no_reliable_signal_fallback_upload" });
  });

  it("priorStateFromManifestObjects ignora gli oggetti 'failed' (non sono uno stato noto buono)", () => {
    const state = priorStateFromManifestObjects([
      { source_path: "ok.pdf", size: 10, checksum: "e1", updated_at: "t1", status: "uploaded" },
      { source_path: "bad.pdf", size: 10, checksum: "e2", updated_at: "t2", status: "failed" },
    ]);
    expect(Object.keys(state)).toEqual(["ok.pdf"]);
  });
});

// ─── FASE 11: dry-run puro (nessun I/O nella firma) ─────────────────────────
describe("storage-backup — planDryRunBucketSummary (13. dry-run zero side effects)", () => {
  it("conta correttamente nuovi/invariati SENZA alcun parametro di I/O nella firma della funzione", () => {
    const objs: StorageObjectInfo[] = [
      { path: "new.pdf", size: 100, updatedAt: "t1", etag: "e1" },
      { path: "same.pdf", size: 50, updatedAt: "t1", etag: "e2" },
    ];
    const prior = { "same.pdf": { size: 50, updatedAt: "t1", etag: "e2" } };
    const summary = planDryRunBucketSummary(objs, prior);
    expect(summary).toEqual({ file_count: 2, would_upload_count: 1, would_skip_count: 1, total_bytes: 150 });
  });

  it("bucket vuoto -> summary tutta a zero", () => {
    expect(planDryRunBucketSummary([], {})).toEqual({ file_count: 0, would_upload_count: 0, would_skip_count: 0, total_bytes: 0 });
  });
});

// ─── FASE 7: verifica upload ─────────────────────────────────────────────────
describe("storage-backup — verifyUpload (FASE 7 verifica)", () => {
  it("7. size coincidente -> verified true", () => {
    expect(verifyUpload(1024, 1024)).toBe(true);
  });

  it("8. mismatch size -> verified false", () => {
    expect(verifyUpload(1024, 512)).toBe(false);
  });

  it("ContentLength assente (null/undefined) -> verified false, mai un falso positivo", () => {
    expect(verifyUpload(1024, null)).toBe(false);
    expect(verifyUpload(1024, undefined)).toBe(false);
  });
});

// ─── FASE 6: manifest ────────────────────────────────────────────────────────
describe("storage-backup — buildStorageBackupManifest (11. manifest corretto)", () => {
  function bucketResult(overrides: Partial<StorageBackupBucketResult> = {}): StorageBackupBucketResult {
    return {
      bucket: "vehicle-documents",
      tier: "A",
      status: "success",
      file_count: 2,
      uploaded_count: 1,
      skipped_count: 1,
      failed_count: 0,
      total_bytes: 1500,
      errors: [],
      objects: [
        { source_path: "a.pdf", r2_key: "production/storage/vehicle-documents/a.pdf", size: 1000, checksum: "e1", updated_at: "t1", status: "uploaded" },
        { source_path: "b.pdf", r2_key: "production/storage/vehicle-documents/b.pdf", size: 500, checksum: "e2", updated_at: "t2", status: "skipped" },
      ],
      ...overrides,
    };
  }

  it("contiene run_id/timestamp/dry_run/bucket/totali aggregati, oggetti con tutti i campi richiesti", () => {
    const manifest = buildStorageBackupManifest({
      runId: "run-1",
      now: new Date("2026-09-13T03:00:00Z"),
      dryRun: false,
      buckets: [bucketResult()],
    });
    expect(manifest.run_id).toBe("run-1");
    expect(manifest.timestamp).toBe("2026-09-13T03:00:00.000Z");
    expect(manifest.dry_run).toBe(false);
    expect(manifest.buckets[0]!.bucket).toBe("vehicle-documents");
    expect(manifest.buckets[0]!.objects[0]).toMatchObject({ source_path: "a.pdf", r2_key: expect.any(String), size: 1000, checksum: "e1", status: "uploaded" });
    expect(manifest.totals).toEqual({ file_count: 2, uploaded_count: 1, skipped_count: 1, failed_count: 0, total_bytes: 1500 });
  });

  it("9. i totali sommano correttamente anche con file falliti su più bucket", () => {
    const manifest = buildStorageBackupManifest({
      runId: "run-2",
      now: new Date("2026-09-13T03:00:00Z"),
      dryRun: false,
      buckets: [
        bucketResult({ bucket: "vehicle-documents", failed_count: 1, total_bytes: 500 }),
        bucketResult({ bucket: "vehicle-damage-photos", tier: "B", uploaded_count: 0, skipped_count: 0, failed_count: 3, total_bytes: 0, objects: [] }),
      ],
    });
    expect(manifest.totals.failed_count).toBe(4);
    expect(manifest.totals.total_bytes).toBe(500);
  });
});

describe("storage-backup — classifyStorageBackupRunStatus (10. errore bucket Tier A -> failed)", () => {
  it("10. bucket Tier A 'failed' (non enumerabile) -> run status 'failed', a prescindere dagli altri bucket", () => {
    const status = classifyStorageBackupRunStatus([
      { tier: "A", status: "failed" },
      { tier: "B", status: "success" },
    ]);
    expect(status).toBe("failed");
  });

  it("bucket Tier B 'failed' (bucket opzionale non backuppato) senza Tier A failed -> 'warning', non 'failed'", () => {
    const status = classifyStorageBackupRunStatus([
      { tier: "A", status: "success" },
      { tier: "B", status: "failed" },
    ]);
    expect(status).toBe("warning");
  });

  it("qualunque bucket 'warning' (alcuni file falliti) senza bucket totalmente falliti -> 'warning'", () => {
    const status = classifyStorageBackupRunStatus([
      { tier: "A", status: "warning" },
      { tier: "B", status: "success" },
    ]);
    expect(status).toBe("warning");
  });

  it("tutti i bucket 'success' -> 'success'", () => {
    expect(classifyStorageBackupRunStatus([{ tier: "A", status: "success" }, { tier: "B", status: "success" }])).toBe("success");
  });
});

// ─── FASE 5: retention (solo bucket versionati) ─────────────────────────────
describe("storage-backup — selectExpiredHistoryVersions (12. retention non elimina l'ultima versione)", () => {
  it("12. mantiene SEMPRE almeno la versione più recente per ogni original_path, anche se più vecchia della retention", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const versions = [
      { r2Key: "k-old", originalPath: "srv-1/interior.jpg", lastModified: new Date("2025-01-01T00:00:00Z") }, // unica versione, molto vecchia
    ];
    const { keep, expire } = selectExpiredHistoryVersions(versions, now, 180);
    expect(keep).toEqual(versions);
    expect(expire).toEqual([]);
  });

  it("elimina le versioni più vecchie della retention MA mantiene la più recente per lo stesso path", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const versions = [
      { r2Key: "k-newest", originalPath: "srv-1/interior.jpg", lastModified: new Date("2026-09-10T00:00:00Z") }, // recente
      { r2Key: "k-old-1", originalPath: "srv-1/interior.jpg", lastModified: new Date("2025-01-01T00:00:00Z") }, // scaduta
      { r2Key: "k-old-2", originalPath: "srv-1/interior.jpg", lastModified: new Date("2025-06-01T00:00:00Z") }, // scaduta
    ];
    const { keep, expire } = selectExpiredHistoryVersions(versions, now, 180);
    expect(keep.map((v) => v.r2Key)).toEqual(["k-newest"]);
    expect(expire.map((v) => v.r2Key).sort()).toEqual(["k-old-1", "k-old-2"]);
  });

  it("versioni entro la retention restano tutte, anche se non le più recenti", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const versions = [
      { r2Key: "k-a", originalPath: "p", lastModified: new Date("2026-09-01T00:00:00Z") },
      { r2Key: "k-b", originalPath: "p", lastModified: new Date("2026-08-01T00:00:00Z") },
    ];
    const { keep, expire } = selectExpiredHistoryVersions(versions, now, 180);
    expect(keep).toHaveLength(2);
    expect(expire).toEqual([]);
  });

  it("raggruppa correttamente per original_path indipendente (path diversi non si influenzano)", () => {
    const now = new Date("2026-09-13T00:00:00Z");
    const versions = [
      { r2Key: "a-new", originalPath: "a", lastModified: new Date("2026-09-12T00:00:00Z") },
      { r2Key: "a-old", originalPath: "a", lastModified: new Date("2025-01-01T00:00:00Z") },
      { r2Key: "b-only", originalPath: "b", lastModified: new Date("2025-01-01T00:00:00Z") },
    ];
    const { keep, expire } = selectExpiredHistoryVersions(versions, now, 180);
    expect(keep.map((v) => v.r2Key).sort()).toEqual(["a-new", "b-only"]);
    expect(expire.map((v) => v.r2Key)).toEqual(["a-old"]);
  });
});

// ─── FASE 10 sicurezza: nessun secret nei log ───────────────────────────────
describe("storage-backup — redactStorageSecrets (16. no secret leakage)", () => {
  it("16. redacta ogni occorrenza letterale dei secret passati", () => {
    const message = redactStorageSecrets("errore con chiave SEGRETO123 e token ALTROSEGRETO456", ["SEGRETO123", "ALTROSEGRETO456"]);
    expect(message).not.toContain("SEGRETO123");
    expect(message).not.toContain("ALTROSEGRETO456");
    expect(message).toContain("[redacted]");
  });

  it("ignora secret vuoti/troppo corti (mai un redact accidentale su testo comune)", () => {
    expect(redactStorageSecrets("abc", [undefined, null, "", "ab"])).toBe("abc");
  });
});
