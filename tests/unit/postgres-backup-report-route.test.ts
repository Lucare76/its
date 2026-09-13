import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { evaluateJobHealth } from "@/lib/server/job-health-evaluator";
import { JOB_HEALTH_CONFIG } from "@/lib/server/job-health-config";
import type { SystemJobRunRow } from "@/lib/server/job-health";

/**
 * POST /api/cron/postgres-backup-report — Disaster Recovery V3, Layer 8.
 *
 * Copre la regressione del 400: lo script (scripts/postgres-backup.mjs) invia
 * SEMPRE `postgres_server_version` gia' troncato a 40 char lato sender (fix
 * applicato), ma questi test blindano anche il contratto lato receiver — cosa
 * lo schema accetta/rifiuta e come ogni esito si traduce nello stato
 * registrato su system_job_runs.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

import { POST } from "@/app/api/cron/postgres-backup-report/route";

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
  return new NextRequest("http://localhost:3010/api/cron/postgres-backup-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3010/api/cron/postgres-backup-report", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: rawBody,
  });
}

const SECRET = "test-dr-health-secret";
const AUTH = { authorization: `Bearer ${SECRET}` };

const VALID_PASSED_PAYLOAD = {
  status: "success" as const,
  base_name: "its_full_2026-09-06_02-30",
  created_at: "2026-09-06T02:33:00.000Z",
  total_size_bytes: 5 * 1024 * 1024,
  artifact_count: 2,
  verification: "passed" as const,
  public_verification: "passed" as const,
  auth_verification: "passed" as const,
  duration_ms: 180_000,
  postgres_server_version: "17.4",
  pg_dump_version: "pg_dump (PostgreSQL) 17.4",
  retention_days: 30,
};

describe("POST /api/cron/postgres-backup-report", () => {
  let rows: FakeRow[];

  beforeEach(() => {
    rows = [];
    mocks.createClient.mockReset();
    mocks.createClient.mockReturnValue(createFakeAdmin(rows));
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.DR_HEALTH_REPORT_SECRET = SECRET;
  });

  it("1. payload valido (verifica passed) -> 200, ok=true, recorded='success'", async () => {
    const res = await POST(makeRequest(VALID_PASSED_PAYLOAD, AUTH));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.recorded).toBe("success");
    expect(body.run_id).toBe("run-1");
  });

  it("2. secret errato -> 401", async () => {
    const res = await POST(makeRequest(VALID_PASSED_PAYLOAD, { authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it("2b. nessun header Authorization -> 401", async () => {
    const res = await POST(makeRequest(VALID_PASSED_PAYLOAD));
    expect(res.status).toBe(401);
  });

  it("3. payload malformato (JSON non valido) -> 400", async () => {
    const res = await POST(makeRawRequest("{not json", AUTH));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("3b. payload con enum non valido (status fuori contratto) -> 400", async () => {
    const res = await POST(makeRequest({ ...VALID_PASSED_PAYLOAD, status: "bogus" }, AUTH));
    expect(res.status).toBe(400);
  });

  it("3c. regressione del bug originale: postgres_server_version >40 char (fallback verboso pre-fix) -> 400 sullo STESSO campo", async () => {
    const overlong = "PostgreSQL 17 (server_version_num 170004)"; // 41 char — cio' che il sender inviava prima del fix
    expect(overlong.length).toBeGreaterThan(40);
    const res = await POST(makeRequest({ ...VALID_PASSED_PAYLOAD, postgres_server_version: overlong }, AUTH));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/40 character/i);
  });

  it("4. verification='passed' -> job registrato 'success' -> evaluator lo legge come 'healthy'", async () => {
    await POST(makeRequest(VALID_PASSED_PAYLOAD, AUTH));
    expect(rows[0]!.status).toBe("success");
    const evaluation = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: rows,
      now: new Date(),
    });
    expect(evaluation.healthStatus).toBe("healthy");
  });

  it("5. verification='unverified' (unaccent assente dal TOC, backup comunque riuscito) -> job 'warning', MAI 'critical' automatico", async () => {
    const payload = {
      ...VALID_PASSED_PAYLOAD,
      verification: "unverified" as const,
      public_verification: "unverified" as const,
    };
    const res = await POST(makeRequest(payload, AUTH));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.recorded).toBe("warning");
    expect(rows[0]!.status).toBe("warning");
    expect(rows[0]!.failed_count).toBe(0);
    expect(rows[0]!.warning_count).toBe(1);

    const evaluation = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: rows,
      now: new Date(),
    });
    expect(evaluation.healthStatus).toBe("warning");
  });

  it("6. status='failed' -> job registrato 'failed'; un run singolo resta 'warning', due falliti CONSECUTIVI -> 'critical'", async () => {
    const failedPayload = {
      status: "failed" as const,
      base_name: "its_full_2026-09-06_02-30",
      error: "pg_dump exit 1",
      duration_ms: 4_200,
    };

    const res1 = await POST(makeRequest(failedPayload, AUTH));
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.recorded).toBe("failed");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.failed_count).toBe(1);

    const oneFailure = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: rows,
      now: new Date(),
    });
    expect(oneFailure.healthStatus).toBe("warning"); // 1 solo fallimento non e' ancora critical

    // Secondo run, fallito anche questo -> due falliti consecutivi.
    await POST(makeRequest(failedPayload, AUTH));
    expect(rows).toHaveLength(2);

    const twoFailures = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: rows,
      now: new Date(),
    });
    expect(twoFailures.healthStatus).toBe("critical");
  });

  it("7. timestamp/duration validi -> passano intatti in metadata (created_at, duration_ms)", async () => {
    await POST(makeRequest(VALID_PASSED_PAYLOAD, AUTH));
    expect(rows[0]!.metadata.reported_created_at).toBe(VALID_PASSED_PAYLOAD.created_at);
    expect(rows[0]!.metadata.duration_ms).toBe(VALID_PASSED_PAYLOAD.duration_ms);
    expect(rows[0]!.finished_at).not.toBeNull();
  });

  it("8. system_job_runs aggiornato correttamente: insert (running) poi update (esito finale) sullo stesso run_id", async () => {
    const res = await POST(makeRequest(VALID_PASSED_PAYLOAD, AUTH));
    const body = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(body.run_id);
    expect(rows[0]!.job_key).toBe("postgres-backup");
    expect(rows[0]!.job_name).toBe("Backup PostgreSQL completo (DR V3)");
    expect(rows[0]!.source).toBe("github-actions/postgres-backup");
    expect(rows[0]!.status).toBe("success"); // aggiornato dallo stato iniziale 'running'
    expect(rows[0]!.success_count).toBe(VALID_PASSED_PAYLOAD.artifact_count);
    expect(rows[0]!.processed_count).toBe(VALID_PASSED_PAYLOAD.artifact_count);
  });
});
