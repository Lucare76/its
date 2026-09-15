import { describe, expect, it, vi } from "vitest";
import {
  completeJobRun,
  readRecentJobRuns,
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

  it("readRecentJobRuns raggruppa lo storico ordinato per job_key, piu' recente prima", async () => {
    const rows = [
      { id: "b2", tenant_id: "tenant-1", job_key: "backup", job_name: "Backup automatico", source: "cron", started_at: "2026-08-22T02:00:00.000Z", finished_at: "2026-08-22T02:01:00.000Z", status: "success", processed_count: 1, success_count: 1, failed_count: 0, warning_count: 0, error_message: null, metadata: {}, created_at: "2026-08-22T02:00:00.000Z" },
      { id: "p1", tenant_id: "tenant-1", job_key: "poll-emails", job_name: "Polling email", source: "cron", started_at: "2026-08-22T06:00:00.000Z", finished_at: "2026-08-22T06:00:10.000Z", status: "success", processed_count: 1, success_count: 1, failed_count: 0, warning_count: 0, error_message: null, metadata: {}, created_at: "2026-08-22T06:00:00.000Z" },
      { id: "b1", tenant_id: "tenant-1", job_key: "backup", job_name: "Backup automatico", source: "cron", started_at: "2026-08-21T02:00:00.000Z", finished_at: "2026-08-21T02:01:00.000Z", status: "failed", processed_count: 1, success_count: 0, failed_count: 1, warning_count: 0, error_message: "boom", metadata: {}, created_at: "2026-08-21T02:00:00.000Z" }
    ];
    const limit = vi.fn().mockResolvedValue({ data: rows, error: null });
    const order = vi.fn(() => ({ limit }));
    const inFn = vi.fn(() => ({ order }));
    const or = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ or }));
    const from = vi.fn(() => ({ select }));

    const byKey = await readRecentJobRuns({ from } as never, "tenant-1", ["backup", "poll-emails", "whatsapp-reminders"]);

    expect(byKey.backup!.map((r) => r.id)).toEqual(["b2", "b1"]);
    expect(byKey["poll-emails"]!.map((r) => r.id)).toEqual(["p1"]);
    expect(byKey["whatsapp-reminders"]).toEqual([]);
  });

  it("readRecentJobRuns errore Supabase -> array vuoto per ogni chiave, mai un'eccezione propagata", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const limit = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } });
    const order = vi.fn(() => ({ limit }));
    const inFn = vi.fn(() => ({ order }));
    const or = vi.fn(() => ({ in: inFn }));
    const select = vi.fn(() => ({ or }));
    const from = vi.fn(() => ({ select }));

    const byKey = await readRecentJobRuns({ from } as never, "tenant-1", ["backup"]);

    expect(byKey).toEqual({ backup: [] });
  });
});

/**
 * Fix P1-3 (audit pre-go-live): startJobRun inseriva sempre una nuova riga
 * in system_job_runs, anche per lo stesso job/run ritentato o rinviato —
 * falsava consecutive failures/health. Fix definitivo (dopo la review
 * iniziale, che usava SELECT-poi-INSERT e NON reggeva sotto vera
 * concorrenza — vedi test "3" sotto): quando il chiamante passa `runId`
 * (identificativo esterno stabile, es. il run_id generato da
 * scripts/storage-backup.mjs), startJobRun tenta SEMPRE prima l'INSERT
 * diretto con run_id nella colonna dedicata (migration 0281, proposta, NON
 * applicata). Se l'insert fallisce per violazione dell'unique index
 * parziale — codice Postgres 23505 — recupera l'id della riga già
 * esistente con una SELECT di sola lettura, senza mai un secondo insert né
 * modifiche a started_at/metadata della prima riga. tenant_id NULL è
 * normalizzato a un sentinel fisso nell'indice (coalesce), cosi' due job
 * system-wide con lo stesso job_key/run_id collidono correttamente anche
 * loro. Senza `runId` (comportamento di tutti i chiamanti preesistenti —
 * backup/poll-emails/whatsapp-reminders/postgres-backup-report), nessun
 * cambiamento: sempre insert diretto.
 */
describe("Fix P1-3 — idempotenza startJobRun su (tenant_id, job_key, run_id)", () => {
  type Row = {
    id: string;
    tenant_id: string | null;
    job_key: string;
    job_name: string;
    source: string;
    started_at: string;
    finished_at: string | null;
    status: string;
    processed_count: number;
    success_count: number;
    failed_count: number;
    warning_count: number;
    error_message: string | null;
    metadata: Record<string, unknown>;
    run_id: string | null;
    created_at: string;
  };

  const TENANT_SENTINEL = "00000000-0000-0000-0000-000000000000";
  const normTenant = (tenantId: string | null) => tenantId ?? TENANT_SENTINEL;

  /**
   * Modella l'unique index parziale della migration 0281:
   * (coalesce(tenant_id, sentinel), job_key, run_id) WHERE run_id IS NOT
   * NULL — enforcement ATOMICO sull'insert stesso (esattamente come farebbe
   * Postgres), non un controllo separato prima dell'insert: il check e lo
   * "scrivi" avvengono nello stesso tick sincrono di questa funzione, senza
   * alcun `await` in mezzo, cosi' anche due chiamate lanciate insieme con
   * Promise.all non possono mai vedere entrambe "nessun conflitto" — la
   * stessa garanzia che un vero indice unico DB fornisce a livello di
   * statement SQL atomico. Non è un tentativo di simulare vera concorrenza
   * multi-thread (impossibile in Node single-threaded): è l'unica cosa che
   * conta davvero per il test — l'ESITO (1 riga, stesso id) è quello
   * garantito da un vincolo DB reale.
   */
  function makeFakeAdmin() {
    const rows: Row[] = [];
    const reservedKeys = new Set<string>();
    let counter = 0;
    let clock = 0; // started_at crescente e deterministico, un ms per riga

    const from = (table: string) => {
      if (table !== "system_job_runs") throw new Error(`tabella inattesa: ${table}`);
      return {
        select(_cols: string) {
          const filters: Array<(r: Row) => boolean> = [];
          const builder = {
            eq(col: string, val: unknown) {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return builder;
            },
            is(col: string, val: null) {
              filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
              return builder;
            },
            limit(_n: number) {
              return builder;
            },
            async maybeSingle() {
              const match = rows.find((r) => filters.every((f) => f(r))) ?? null;
              return { data: match ? { id: match.id } : null, error: null };
            },
          };
          return builder;
        },
        insert(data: Record<string, unknown>) {
          return {
            select() {
              return {
                async single() {
                  const runId = (data.run_id as string | null) ?? null;
                  const tenantId = (data.tenant_id as string | null) ?? null;
                  const key = runId != null ? `${normTenant(tenantId)}|${data.job_key}|${runId}` : null;

                  if (key != null) {
                    if (reservedKeys.has(key)) {
                      return {
                        data: null,
                        error: { code: "23505", message: `duplicate key value violates unique constraint "idx_system_job_runs_tenant_job_run_unique"` },
                      };
                    }
                    reservedKeys.add(key); // "commit" atomico della chiave PRIMA di qualunque await successivo
                  }

                  const id = `row-${++counter}`;
                  const startedAt = new Date(1000 + ++clock).toISOString();
                  rows.push({
                    id,
                    tenant_id: tenantId,
                    job_key: data.job_key as string,
                    job_name: data.job_name as string,
                    source: data.source as string,
                    started_at: startedAt,
                    finished_at: null,
                    status: data.status as string,
                    processed_count: 0,
                    success_count: 0,
                    failed_count: 0,
                    warning_count: 0,
                    error_message: null,
                    metadata: (data.metadata as Record<string, unknown>) ?? {},
                    run_id: runId,
                    created_at: startedAt,
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
    };

    return { admin: { from } as never, rows };
  }

  it("1. primo startJobRun (con runId) crea 1 riga", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-A" });
    expect(id).toBeTruthy();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata.run_id).toBe("run-A");
  });

  it("2. stesso tenant/job/run_id ripetuto: resta 1 riga, stesso id restituito, started_at/metadata della prima riga invariati", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id1 = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-A", metadata: { attempt: 1 } });
    const startedAtAfterFirst = rows[0]!.started_at;

    const id2 = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-A", metadata: { attempt: 2 } });

    expect(id2).toBe(id1);
    expect(rows).toHaveLength(1);
    // La seconda chiamata NON riscrive la storia della prima: started_at e metadata restano quelli originali.
    expect(rows[0]!.started_at).toBe(startedAtAfterFirst);
    expect(rows[0]!.metadata.attempt).toBe(1);
  });

  it("3. due chiamate DAVVERO concorrenti (Promise.all) con lo stesso run_id: ora VERDE — 1 sola riga, stesso id restituito a entrambe", async () => {
    const { admin, rows } = makeFakeAdmin();
    // Il fake modella il conflitto 23505 dell'unique index reale in modo
    // atomico (nessun await fra "controlla" e "scrivi" — vedi commento su
    // makeFakeAdmin): una delle due chiamate vince l'insert, l'altra riceve
    // 23505 e recupera l'id vincente via SELECT, MAI un secondo insert.
    const [id1, id2] = await Promise.all([
      startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-B" }),
      startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-B" }),
    ]);
    expect(id1).toBe(id2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.run_id).toBe("run-B");
  });

  it("4. stesso run_id ma job_key diverso: 2 righe distinte (la chiave include job_key)", async () => {
    const { admin, rows } = makeFakeAdmin();
    await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-C" });
    await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-C" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.job_key).sort()).toEqual(["postgres-backup", "storage-backup"]);
  });

  it("5. stesso run_id ma tenant diverso: consentito, 2 righe distinte (la chiave include tenant_id)", async () => {
    const { admin, rows } = makeFakeAdmin();
    await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-D" });
    await startJobRun({ admin, tenantId: "t2", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-D" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.tenant_id).sort()).toEqual(["t1", "t2"]);
  });

  it("6. run_id diverso: nuova riga", async () => {
    const { admin, rows } = makeFakeAdmin();
    await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-E1" });
    await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-E2" });
    expect(rows).toHaveLength(2);
  });

  describe("tenant_id NULL — normalizzazione via sentinel nell'unique index", () => {
    it("OBBLIGATORIO: due startJobRun concorrenti con tenant_id=null, stesso job_key/run_id -> UNA SOLA riga", async () => {
      const { admin, rows } = makeFakeAdmin();
      const [id1, id2] = await Promise.all([
        startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-1" }),
        startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-1" }),
      ]);
      expect(id1).toBe(id2);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBeNull();
      expect(rows[0]!.run_id).toBe("run-NULL-1");
    });

    it("tenant reale A + stesso job_key/run_id -> distinto da tenant reale B", async () => {
      const { admin, rows } = makeFakeAdmin();
      await startJobRun({ admin, tenantId: "tenant-A", jobKey: "poll-emails", jobName: "Polling email", source: "cron", runId: "run-NULL-2" });
      await startJobRun({ admin, tenantId: "tenant-B", jobKey: "poll-emails", jobName: "Polling email", source: "cron", runId: "run-NULL-2" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.tenant_id).sort()).toEqual(["tenant-A", "tenant-B"]);
    });

    it("tenant_id NULL + tenant reale, stesso job_key/run_id -> distinti (NULL non collide con un tenant reale)", async () => {
      const { admin, rows } = makeFakeAdmin();
      await startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-3" });
      await startJobRun({ admin, tenantId: "tenant-A", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-3" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.tenant_id).sort()).toEqual([null, "tenant-A"]);
    });

    it("stesso tenant_id NULL + job_key diverso -> distinti", async () => {
      const { admin, rows } = makeFakeAdmin();
      await startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-4" });
      await startJobRun({ admin, tenantId: null, jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-NULL-4" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.job_key).sort()).toEqual(["postgres-backup", "storage-backup"]);
    });

    it("stesso tenant_id NULL/job_key + run_id diverso -> distinti", async () => {
      const { admin, rows } = makeFakeAdmin();
      await startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-5A" });
      await startJobRun({ admin, tenantId: null, jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-NULL-5B" });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.run_id).sort()).toEqual(["run-NULL-5A", "run-NULL-5B"]);
    });
  });

  it("nessun runId passato (comportamento legacy invariato): due chiamate identiche creano SEMPRE 2 righe", async () => {
    const { admin, rows } = makeFakeAdmin();
    await startJobRun({ admin, tenantId: "t1", jobKey: "backup", jobName: "Backup", source: "cron" });
    await startJobRun({ admin, tenantId: "t1", jobKey: "backup", jobName: "Backup", source: "cron" });
    expect(rows).toHaveLength(2);
  });

  it("7. complete della stessa run due volte: stato coerente, nessun duplicato, retry identico sicuro", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-F" });

    await completeJobRun({ admin, runId: id, status: "success", processedCount: 5, successCount: 5, failedCount: 0, warningCount: 0 });
    await completeJobRun({ admin, runId: id, status: "success", processedCount: 5, successCount: 5, failedCount: 0, warningCount: 0 });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.processed_count).toBe(5);
  });

  it("completeJobRun sovrascrive metadata per intero (senza run_id) ma l'idempotenza NON ne risente più: run_id vive nella sua colonna dedicata, non in metadata", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id1 = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-META" });
    // Nessun metadata passato qui: prima del fix definitivo questo avrebbe
    // cancellato metadata.run_id e rotto il lookup di idempotenza. Ora
    // run_id resta intatto sulla colonna: l'update non lo tocca affatto.
    await completeJobRun({ admin, runId: id1, status: "failed", errorMessage: "boom" });
    expect(rows[0]!.run_id).toBe("run-META"); // colonna intatta nonostante metadata sia stato svuotato
    expect(rows[0]!.metadata).toEqual({});

    // Retry dopo il completamento: ritrova ancora la riga via la colonna run_id.
    const id2 = await startJobRun({ admin, tenantId: "t1", jobKey: "storage-backup", jobName: "Storage backup", source: "gha", runId: "run-META" });
    expect(id2).toBe(id1);
    expect(rows).toHaveLength(1);
  });

  it("8. duplicate failed report (stesso run_id): consecutive failures NON aumenta due volte", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id1 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-G" });
    await completeJobRun({ admin, runId: id1, status: "failed", errorMessage: "pg_dump fallito" });
    // Retry identico dello stesso run_id: startJobRun torna alla riga esistente (via colonna run_id, non metadata), completeJobRun la aggiorna di nuovo (stesso esito).
    const id2 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-G" });
    await completeJobRun({ admin, runId: id2, status: "failed", errorMessage: "pg_dump fallito" });

    expect(rows).toHaveLength(1);
    const { evaluateJobHealth } = await import("@/lib/server/job-health-evaluator");
    const { JOB_HEALTH_CONFIG } = await import("@/lib/server/job-health-config");
    const evaluation = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: [...rows].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)) as never,
      now: new Date(),
    });
    // criticalConsecutiveFailures per postgres-backup e' 2: UN solo
    // fallimento reale (anche se ritentato/segnalato due volte) NON deve
    // mai raggiungere artificialmente la soglia critica.
    expect(evaluation.consecutiveFailures).toBe(1);
    expect(evaluation.healthStatus).not.toBe("critical");
  });

  it("9. due failure con run_id DIVERSI: consecutive failures aumenta correttamente (2 fallimenti reali)", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id1 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-H1" });
    await completeJobRun({ admin, runId: id1, status: "failed", errorMessage: "pg_dump fallito" });
    const id2 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-H2" });
    await completeJobRun({ admin, runId: id2, status: "failed", errorMessage: "pg_dump fallito ancora" });

    expect(rows).toHaveLength(2);
    const { evaluateJobHealth } = await import("@/lib/server/job-health-evaluator");
    const { JOB_HEALTH_CONFIG } = await import("@/lib/server/job-health-config");
    const evaluation = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: [...rows].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)) as never,
      now: new Date(),
    });
    expect(evaluation.consecutiveFailures).toBe(2);
    expect(evaluation.healthStatus).toBe("critical");
  });

  it("10. success dopo failure: comportamento invariato rispetto alla logica esistente (consecutiveFailures si azzera)", async () => {
    const { admin, rows } = makeFakeAdmin();
    const id1 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-I1" });
    await completeJobRun({ admin, runId: id1, status: "failed", errorMessage: "pg_dump fallito" });
    const id2 = await startJobRun({ admin, tenantId: "t1", jobKey: "postgres-backup", jobName: "Postgres backup", source: "gha", runId: "run-I2" });
    await completeJobRun({ admin, runId: id2, status: "success", processedCount: 1, successCount: 1 });

    const { evaluateJobHealth } = await import("@/lib/server/job-health-evaluator");
    const { JOB_HEALTH_CONFIG } = await import("@/lib/server/job-health-config");
    const evaluation = evaluateJobHealth({
      config: JOB_HEALTH_CONFIG["postgres-backup"]!,
      runs: [...rows].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)) as never,
      now: new Date(),
    });
    expect(evaluation.consecutiveFailures).toBe(0);
    expect(evaluation.healthStatus).toBe("healthy");
  });
});
