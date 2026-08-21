import { describe, expect, it, vi } from "vitest";
import {
  completeJobRun,
  readSystemJobHealthSummary,
  sanitizeJobMetadata,
  startJobRun,
  withJobHealth
} from "@/lib/server/job-health";

function createInsertClient(error: { message: string } | null = null) {
  const single = vi.fn().mockResolvedValue(error ? { data: null, error } : { data: { id: "run-1" }, error: null });
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { client: { from }, calls: { from, insert, select, single } };
}

function createUpdateClient(error: { message: string } | null = null) {
  const eq = vi.fn().mockResolvedValue({ error });
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { client: { from }, calls: { from, update, eq } };
}

describe("job-health registry", () => {
  it("registra start run success con metadata sanitizzato", async () => {
    const { client, calls } = createInsertClient();

    const runId = await startJobRun({
      admin: client as never,
      tenantId: "tenant-1",
      jobKey: "backup",
      jobName: "Backup automatico",
      source: "api/cron/backup",
      metadata: { token: "secret-value", safe: "ok" }
    });

    expect(runId).toBe("run-1");
    expect(calls.from).toHaveBeenCalledWith("system_job_runs");
    expect(calls.insert).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: "tenant-1",
      job_key: "backup",
      status: "running",
      metadata: { token: "[redacted]", safe: "ok" }
    }));
  });

  it("registra completamento failed con conteggi corretti", async () => {
    const { client, calls } = createUpdateClient();

    await completeJobRun({
      admin: client as never,
      runId: "run-1",
      status: "failed",
      processedCount: 10,
      successCount: 7,
      failedCount: 3,
      warningCount: 0,
      errorMessage: "boom",
      metadata: { table: "services" }
    });

    expect(calls.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "failed",
      processed_count: 10,
      success_count: 7,
      failed_count: 3,
      warning_count: 0,
      error_message: "boom"
    }));
    expect(calls.eq).toHaveBeenCalledWith("id", "run-1");
  });

  it("supporta warning", async () => {
    const { client, calls } = createUpdateClient();

    await completeJobRun({
      admin: client as never,
      runId: "run-1",
      status: "warning",
      processedCount: 5,
      successCount: 4,
      failedCount: 0,
      warningCount: 1
    });

    expect(calls.update).toHaveBeenCalledWith(expect.objectContaining({ status: "warning", warning_count: 1 }));
  });

  it("metadata non obbligatorio", async () => {
    const { client, calls } = createInsertClient();

    await startJobRun({
      admin: client as never,
      jobKey: "poll-emails",
      jobName: "Polling email",
      source: "api/cron/poll-emails"
    });

    expect(calls.insert).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }));
  });

  it("errore registry non blocca il job principale", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const start = createInsertClient({ message: "db down" });

    const result = await withJobHealth({
      admin: start.client as never,
      jobKey: "backup",
      jobName: "Backup automatico",
      source: "api/cron/backup"
    }, async () => ({
      result: "ok",
      status: "success",
      counts: { processedCount: 1, successCount: 1 }
    }));

    expect(result).toBe("ok");
  });

  it("sanitizza secret e limita payload diagnostici", () => {
    expect(sanitizeJobMetadata({
      access_token: "abc",
      nested: { password: "pw", value: "visible" },
      long: "x".repeat(600)
    })).toEqual({
      access_token: "[redacted]",
      nested: { password: "[redacted]", value: "visible" },
      long: `${"x".repeat(500)}...`
    });
  });

  it("legge summary con isolamento tenant/null e conteggio fallimenti recenti", async () => {
    const rows = [
      { id: "1", tenant_id: "tenant-1", job_key: "backup", job_name: "Backup automatico", source: "cron", started_at: "2026-08-21T02:00:00.000Z", finished_at: "2026-08-21T02:01:00.000Z", status: "failed", processed_count: 1, success_count: 0, failed_count: 1, warning_count: 0, error_message: "x", metadata: {}, created_at: "2026-08-21T02:00:00.000Z" },
      { id: "2", tenant_id: null, job_key: "backup", job_name: "Backup automatico", source: "cron", started_at: "2026-08-20T02:00:00.000Z", finished_at: "2026-08-20T02:01:00.000Z", status: "success", processed_count: 1, success_count: 1, failed_count: 0, warning_count: 0, error_message: null, metadata: {}, created_at: "2026-08-20T02:00:00.000Z" }
    ];
    const limit = vi.fn().mockResolvedValue({ data: rows, error: null });
    const order = vi.fn(() => ({ limit }));
    const inFn = vi.fn(() => ({ order }));
    const or = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ or }));
    const from = vi.fn(() => ({ select }));

    const summary = await readSystemJobHealthSummary({ from } as never, "tenant-1", ["backup"], "2026-08-19T00:00:00.000Z");

    expect(or).toHaveBeenCalledWith("tenant_id.is.null,tenant_id.eq.tenant-1");
    expect(summary[0].latest_run?.id).toBe("1");
    expect(summary[0].latest_success?.id).toBe("2");
    expect(summary[0].recent_failed_count).toBe(1);
  });
});
