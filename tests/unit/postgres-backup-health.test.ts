import { describe, expect, it } from "vitest";
import { evaluateJobHealth, computeOverallHealth } from "@/lib/server/job-health-evaluator";
import { JOB_HEALTH_CONFIG } from "@/lib/server/job-health-config";
import type { SystemJobRunRow } from "@/lib/server/job-health";

/**
 * Disaster Recovery V3 — integrazione Centro Salute per il job "postgres-backup".
 * Verifica soprattutto: un backup JSON verde NON deve mascherare un pg_dump
 * fallito (job DISTINTI, computeOverallHealth prende il peggiore).
 */

const NOW = new Date("2026-09-06T10:00:00.000Z");
const CONFIG = JOB_HEALTH_CONFIG["postgres-backup"]!;

function pgRun(overrides: Partial<SystemJobRunRow> = {}): SystemJobRunRow {
  return {
    id: "pg-1",
    tenant_id: null,
    job_key: "postgres-backup",
    job_name: "Backup PostgreSQL completo (DR V3)",
    source: "github-actions/postgres-backup",
    started_at: "2026-09-06T02:30:00.000Z",
    finished_at: "2026-09-06T02:33:00.000Z",
    status: "success",
    processed_count: 2,
    success_count: 2,
    failed_count: 0,
    warning_count: 0,
    error_message: null,
    metadata: {
      base_name: "its_full_2026-09-06_02-30",
      artifact_count: 2,
      total_size_bytes: 5 * 1024 * 1024,
      verification: "passed",
      postgres_server_version: "15.8",
    },
    created_at: "2026-09-06T02:33:00.000Z",
    ...overrides,
  };
}

describe("job-health — postgres-backup (DR V3)", () => {
  it("config presente, abilitata, scheduled, critical a 2 KO, stale critical", () => {
    expect(CONFIG).toBeDefined();
    expect(CONFIG.enabled).toBe(true);
    expect(CONFIG.schedulingMode).toBe("scheduled");
    expect(CONFIG.criticalConsecutiveFailures).toBe(2);
    expect(CONFIG.staleSeverity).toBe("critical");
  });

  it("run success + verifica passed -> healthy con note (artefatti, size, versione)", () => {
    const e = evaluateJobHealth({ config: CONFIG, runs: [pgRun()], now: NOW });
    expect(e.healthStatus).toBe("healthy");
    expect(e.notes.join(" ")).toMatch(/2 artefatti/);
    expect(e.notes.join(" ")).toMatch(/5\.0 MiB/);
    expect(e.notes.join(" ")).toMatch(/PostgreSQL 15\.8/);
  });

  it("run success ma verifica strutturale 'failed' -> warning", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [pgRun({ status: "warning", metadata: { verification: "failed", artifact_count: 2 } })],
      now: NOW,
    });
    expect(e.healthStatus).toBe("warning");
    expect(e.reason).toMatch(/verifica strutturale non superata/i);
  });

  it("run success ma verifica 'unverified' (unaccent assente dal TOC) -> warning, non healthy", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [pgRun({ status: "warning", metadata: { verification: "unverified", public_verification: "unverified", artifact_count: 2 } })],
      now: NOW,
    });
    expect(e.healthStatus).toBe("warning");
  });

  it("un solo run fallito -> warning; due falliti consecutivi -> critical", () => {
    const oneFail = evaluateJobHealth({
      config: CONFIG,
      runs: [pgRun({ id: "f1", status: "failed", error_message: "pg_dump exit 1" })],
      now: NOW,
    });
    expect(oneFail.healthStatus).toBe("warning");

    const twoFails = evaluateJobHealth({
      config: CONFIG,
      runs: [
        pgRun({ id: "f2", status: "failed", started_at: "2026-09-06T02:30:00.000Z", error_message: "R2 upload failed" }),
        pgRun({ id: "f1", status: "failed", started_at: "2026-09-05T02:30:00.000Z", error_message: "pg_dump exit 1" }),
      ],
      now: NOW,
    });
    expect(twoFails.healthStatus).toBe("critical");
  });

  it("nessun run da oltre 30h -> stale -> critical", () => {
    const e = evaluateJobHealth({
      config: CONFIG,
      runs: [pgRun({ id: "old", started_at: "2026-09-04T02:30:00.000Z", finished_at: "2026-09-04T02:33:00.000Z" })],
      now: NOW,
    });
    expect(e.stale).toBe(true);
    expect(e.healthStatus).toBe("critical");
  });

  it("mai eseguito -> unknown (nessun falso allarme finche' non c'e' storico)", () => {
    const e = evaluateJobHealth({ config: CONFIG, runs: [], now: NOW });
    expect(e.healthStatus).toBe("unknown");
  });

  it("un backup JSON verde NON maschera un pg_dump fallito: overall = critical", () => {
    const jsonBackupHealthy = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["backup"]!,
      runs: [
        {
          ...pgRun(),
          job_key: "backup",
          metadata: { tables_exported: 24, rows_total: 12345, offsite_backup: { status: "success" } },
        },
      ],
      now: NOW,
    });
    const pgBackupFailedTwice = evaluateJobHealth({
      config: CONFIG,
      runs: [
        pgRun({ id: "f2", status: "failed", started_at: "2026-09-06T02:30:00.000Z" }),
        pgRun({ id: "f1", status: "failed", started_at: "2026-09-05T02:30:00.000Z" }),
      ],
      now: NOW,
    });
    expect(jsonBackupHealthy.healthStatus).toBe("healthy");
    expect(pgBackupFailedTwice.healthStatus).toBe("critical");
    expect(computeOverallHealth([jsonBackupHealthy, pgBackupFailedTwice])).toBe("critical");
  });
});
