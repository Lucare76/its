import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { evaluateJobHealth } from "@/lib/server/job-health-evaluator";
import { JOB_HEALTH_CONFIG } from "@/lib/server/job-health-config";
import type { SystemJobRunRow } from "@/lib/server/job-health";

/**
 * POST /api/cron/storage-backup-report — Disaster Recovery V4, Layer 8.
 * Stesso pattern di tests/unit/postgres-backup-report-route.test.ts.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

import { POST } from "@/app/api/cron/storage-backup-report/route";

type FakeRow = SystemJobRunRow;

function createFakeAdmin(rows: FakeRow[]) {
  let counter = 0;
  return {
    from(table: string) {
      if (table !== "system_job_runs") throw new Error(`tabella inattesa: ${table}`);
      return {
        insert(data: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const id = `run-${++counter}`;
                  const now = new Date().toISOString();
                  rows.push({
                    id,
                    tenant_id: (data.tenant_id as string | null) ?? null,
                    job_key: data.job_key as string,
                    job_name: data.job_name as string,
                    source: data.source as string,
                    started_at: now,
                    finished_at: null,
                    status: data.status as FakeRow["status"],
                    processed_count: 0,
                    success_count: 0,
                    failed_count: 0,
                    warning_count: 0,
                    error_message: null,
                    metadata: (data.metadata as Record<string, unknown>) ?? {},
                    created_at: now,
                  });
                  return { data: { id }, error: null };
                },
              };
            },
          };
        },
        update(patch: Record<string, unknown>) {
          return {
            async eq(_col: string, val: string) {
              const row = rows.find((r) => r.id === val);
              if (row) Object.assign(row, patch);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3010/api/cron/storage-backup-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3010/api/cron/storage-backup-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

const SECRET = "test-dr-health-secret";
const AUTH = { authorization: `Bearer ${SECRET}` };

const OK_BUCKET = { bucket: "vehicle-documents", tier: "A" as const, status: "success" as const, file_count: 5, uploaded_count: 1, skipped_count: 4, failed_count: 0, total_bytes: 5000 };

const VALID_PAYLOAD = {
  status: "success" as const,
  run_id: "storage_20260913030000_ab12cd34",
  dry_run: false,
  duration_ms: 4200,
  total_uploaded: 1,
  total_skipped: 4,
  total_failed: 0,
  total_bytes: 5000,
  manifest_r2_key: "production/storage/manifests/storage_20260913030000_ab12cd34.json",
  buckets: [OK_BUCKET],
};

describe("POST /api/cron/storage-backup-report", () => {
  let rows: FakeRow[];

  beforeEach(() => {
    rows = [];
    mocks.createClient.mockReset();
    mocks.createClient.mockReturnValue(createFakeAdmin(rows));
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.DR_HEALTH_REPORT_SECRET = SECRET;
  });

  it("payload valido -> 200, ok=true, recorded='success'", async () => {
    const res = await POST(makeRequest(VALID_PAYLOAD, AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe("success");
  });

  it("secret errato -> 401", async () => {
    const res = await POST(makeRequest(VALID_PAYLOAD, { authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it("nessun header Authorization -> 401", async () => {
    const res = await POST(makeRequest(VALID_PAYLOAD));
    expect(res.status).toBe(401);
  });

  it("payload malformato (JSON non valido) -> 400", async () => {
    const res = await POST(makeRawRequest("{not json", AUTH));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("payload con enum status fuori contratto -> 400", async () => {
    const res = await POST(makeRequest({ ...VALID_PAYLOAD, status: "bogus" }, AUTH));
    expect(res.status).toBe(400);
  });

  it("payload con tier bucket fuori contratto ('C', mai inviato dal sender: bus-qr-codes è escluso) -> 400", async () => {
    const res = await POST(makeRequest({ ...VALID_PAYLOAD, buckets: [{ ...OK_BUCKET, tier: "C" }] }, AUTH));
    expect(res.status).toBe(400);
  });

  it("14. status='success' -> job registrato 'success' -> evaluator lo legge come 'healthy'", async () => {
    await POST(makeRequest(VALID_PAYLOAD, AUTH));
    expect(rows[0]!.status).toBe("success");
    const evaluation = evaluateJobHealth({ config: JOB_HEALTH_CONFIG["storage-backup"]!, runs: rows, now: new Date() });
    expect(evaluation.healthStatus).toBe("healthy");
  });

  it("14. status='warning' (alcuni file falliti) -> job 'warning' -> evaluator 'warning'", async () => {
    const payload = {
      ...VALID_PAYLOAD,
      status: "warning" as const,
      total_failed: 1,
      buckets: [{ ...OK_BUCKET, status: "warning" as const, failed_count: 1, error: "vehicle-1/scan.pdf: download vuoto" }],
    };
    const res = await POST(makeRequest(payload, AUTH));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.recorded).toBe("warning");
    expect(rows[0]!.status).toBe("warning");
    expect(rows[0]!.warning_count).toBe(1);
    expect(rows[0]!.error_message).toContain("scan.pdf");

    const evaluation = evaluateJobHealth({ config: JOB_HEALTH_CONFIG["storage-backup"]!, runs: rows, now: new Date() });
    expect(evaluation.healthStatus).toBe("warning");
  });

  it("10./14. status='failed' (bucket Tier A non backuppato) -> job 'failed' -> evaluator 'critical' AL PRIMO KO (criticalConsecutiveFailures=1)", async () => {
    const payload = {
      ...VALID_PAYLOAD,
      status: "failed" as const,
      total_uploaded: 0,
      total_skipped: 0,
      total_failed: 0,
      buckets: [{ bucket: "vehicle-documents", tier: "A" as const, status: "failed" as const, file_count: 0, uploaded_count: 0, skipped_count: 0, failed_count: 0, total_bytes: 0, error: "list fallita: credenziali R2 non valide" }],
    };
    const res = await POST(makeRequest(payload, AUTH));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.recorded).toBe("failed");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toContain("vehicle-documents");

    // UN solo run fallito basta per 'critical' su questo job (a differenza di postgres-backup, 2 KO).
    const evaluation = evaluateJobHealth({ config: JOB_HEALTH_CONFIG["storage-backup"]!, runs: rows, now: new Date() });
    expect(evaluation.healthStatus).toBe("critical");
  });

  it("9. errore di upload su un singolo file (bucket comunque 'warning', non 'failed') si riflette nel metadata del run", async () => {
    const payload = {
      ...VALID_PAYLOAD,
      status: "warning" as const,
      buckets: [{ ...OK_BUCKET, status: "warning" as const, uploaded_count: 0, failed_count: 1, error: "vehicle-1/danno.jpg: verifica HeadObject fallita (size non coincide)" }],
    };
    await POST(makeRequest(payload, AUTH));
    const buckets = rows[0]!.metadata.buckets as Array<Record<string, unknown>>;
    expect(buckets[0]!.error).toContain("HeadObject");
  });

  it("system_job_runs aggiornato correttamente: insert (running) poi update (esito finale) sullo stesso run_id", async () => {
    const res = await POST(makeRequest(VALID_PAYLOAD, AUTH));
    const body = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(body.run_id);
    expect(rows[0]!.job_key).toBe("storage-backup");
    expect(rows[0]!.job_name).toBe("Backup file Storage (DR V4)");
    expect(rows[0]!.source).toBe("github-actions/storage-backup");
    expect(rows[0]!.success_count).toBe(5); // uploaded+skipped
    expect(rows[0]!.processed_count).toBe(5);
    expect(rows[0]!.metadata.run_id).toBe(VALID_PAYLOAD.run_id);
  });

  it("dry_run=true viene registrato nel metadata per tracciabilità (anche se in pratica il sender non invia report per i dry-run)", async () => {
    await POST(makeRequest({ ...VALID_PAYLOAD, dry_run: true }, AUTH));
    expect(rows[0]!.metadata.dry_run).toBe(true);
  });
});
