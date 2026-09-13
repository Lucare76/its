import { describe, expect, it } from "vitest";
import { evaluateJobHealth, computeOverallHealth } from "@/lib/server/job-health-evaluator";
import { JOB_HEALTH_CONFIG } from "@/lib/server/job-health-config";
import type { SystemJobRunRow } from "@/lib/server/job-health";

/**
 * Disaster Recovery V4 — integrazione Centro Salute per il job
 * "storage-backup". Stesso pattern di tests/unit/postgres-backup-health.test.ts.
 * Verifica soprattutto: un backup JSON/Postgres verde NON deve mai mascherare
 * un bucket Storage Tier A non backuppato (job DISTINTI).
 */

const NOW = new Date("2026-09-13T10:00:00.000Z");
const CONFIG = JOB_HEALTH_CONFIG["storage-backup"]!;

function storageRun(overrides: Partial<SystemJobRunRow> = {}): SystemJobRunRow {
  return {
    id: "sb-1",
    tenant_id: null,
    job_key: "storage-backup",
    job_name: "Backup file Storage (DR V4)",
    source: "github-actions/storage-backup",
    started_at: "2026-09-13T03:00:00.000Z",
    finished_at: "2026-09-13T03:02:00.000Z",
    status: "success",
    processed_count: 5,
    success_count: 5,
    failed_count: 0,
    warning_count: 0,
    error_message: null,
    metadata: {
      total_uploaded: 1,
      total_skipped: 4,
      total_bytes: 5000,
      buckets: [{ bucket: "vehicle-documents", tier: "A", status: "success" }],
    },
    created_at: "2026-09-13T03:02:00.000Z",
    ...overrides,
  };
}

describe("job-health — storage-backup (DR V4)", () => {
  it("config presente, abilitata, scheduled, critical AL PRIMO KO, stale critical", () => {
    expect(CONFIG).toBeDefined();
    expect(CONFIG.enabled).toBe(true);
    expect(CONFIG.schedulingMode).toBe("scheduled");
    expect(CONFIG.criticalConsecutiveFailures).toBe(1);
    expect(CONFIG.staleSeverity).toBe("critical");
  });

  it("run success, tutti i bucket 'success' -> healthy con note (file caricati/invariati/byte)", () => {
    const e = evaluateJobHealth({ config: CONFIG, runs: [storageRun()], now: NOW });
    expect(e.healthStatus).toBe("healthy");
    expect(e.notes.join(" ")).toMatch(/1 file caricati/);
    expect(e.notes.join(" ")).toMatch(/4 invariati/);
  });

  it("run success ma un bucket in 'warning' (alcuni file falliti) -> health warning, non healthy", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [
        storageRun({
          status: "warning",
          warning_count: 1,
          metadata: { buckets: [{ bucket: "vehicle-documents", tier: "A", status: "warning" }] },
        }),
      ],
      now: NOW,
    });
    expect(e.healthStatus).toBe("warning");
    expect(e.reason).toMatch(/vehicle-documents/);
  });

  it("run success ma un bucket Tier B totalmente fallito ('bucket opzionale fallito') -> warning, MAI critical", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [
        storageRun({
          status: "warning",
          metadata: {
            buckets: [
              { bucket: "vehicle-documents", tier: "A", status: "success" },
              { bucket: "vehicle-damage-photos", tier: "B", status: "failed" },
            ],
          },
        }),
      ],
      now: NOW,
    });
    expect(e.healthStatus).toBe("warning");
    expect(e.reason).toMatch(/vehicle-damage-photos/);
  });

  it("un SOLO run fallito (bucket Tier A non backuppato) -> critical IMMEDIATO (a differenza di postgres-backup che aspetta 2 KO)", () => {
    const oneFail = evaluateJobHealth({
      config: CONFIG,
      runs: [storageRun({ id: "f1", status: "failed", error_message: "Bucket Tier A non backuppato: vehicle-documents" })],
      now: NOW,
    });
    expect(oneFail.healthStatus).toBe("critical");
  });

  it("nessun run da oltre la finestra attesa -> stale -> critical", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [storageRun({ id: "old", started_at: "2026-09-10T03:00:00.000Z", finished_at: "2026-09-10T03:02:00.000Z" })],
      now: NOW,
    });
    expect(e.stale).toBe(true);
    expect(e.healthStatus).toBe("critical");
  });

  it("mai eseguito -> 'unknown' (mai un warning inventato in assenza di storico) — 'unknown' non e' mai trattato come warning", () => {
    const e = evaluateJobHealth({ config: CONFIG, runs: [], now: NOW });
    expect(e.healthStatus).toBe("unknown");
    expect(e.healthStatus).not.toBe("warning");
  });

  it("un backup Postgres/JSON verde NON maschera un bucket Storage Tier A non backuppato: overall = critical", () => {
    const postgresHealthy = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: [
        {
          id: "pg-1",
          tenant_id: null,
          job_key: "postgres-backup",
          job_name: "Backup PostgreSQL completo (DR V3)",
          source: "github-actions/postgres-backup",
          started_at: "2026-09-13T02:30:00.000Z",
          finished_at: "2026-09-13T02:33:00.000Z",
          status: "success",
          processed_count: 2,
          success_count: 2,
          failed_count: 0,
          warning_count: 0,
          error_message: null,
          metadata: { verification: "passed" },
          created_at: "2026-09-13T02:33:00.000Z",
        },
      ],
      now: NOW,
    });
    const storageFailed = evaluateJobHealth({
      config: CONFIG,
      runs: [storageRun({ id: "sb-fail", status: "failed", error_message: "Bucket Tier A non backuppato: vehicle-documents" })],
      now: NOW,
    });
    expect(postgresHealthy.healthStatus).toBe("healthy");
    expect(storageFailed.healthStatus).toBe("critical");
    expect(computeOverallHealth([postgresHealthy, storageFailed])).toBe("critical");
  });
});
