import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Sprint 8 — writeDirectImportServicesAndAssignments()
 * (scripts/import-driver-file-direct.ts).
 *
 * Lo script CLI import-driver-file-direct.ts creava service.status='assigned'
 * direttamente nell'insert, prima di scrivere assignments — stesso bug già
 * corretto in Sprint 7 su app/api/ops/driver-file-import/route.ts. Poiché lo
 * script fa I/O reale (file system, env vars, client Supabase live) dentro
 * main(), non è testabile end-to-end senza un refactor ampio (esplicitamente
 * vietato dallo sprint). La sola sequenza di scrittura rischiosa è stata
 * estratta in una funzione pura, testabile qui contro un fake Supabase
 * minimale, senza toccare parsing/CLI/file system.
 *
 * Importare questo modulo NON deve eseguire main() dal vivo: lo script ha un
 * guard di entry point (isDirectRun, basato su fileURLToPath(import.meta.url)
 * confrontato con process.argv[1]) che esegue main() solo quando lanciato
 * direttamente da CLI — mai quando importato da un test. Verificato
 * empiricamente: nessun accesso a file system/env/rete avviene al semplice
 * import qui sotto.
 */

import { writeDirectImportServicesAndAssignments } from "@/scripts/import-driver-file-direct";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DRIVER_USER = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown>;

/** Fake Supabase minimale — solo services/assignments, solo le operazioni usate dall'helper. */
function createFakeAdmin(seed: { services?: Row[]; assignments?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
  };
  const opErrorQueues: Record<string, Array<{ message: string } | null>> = {};
  let idCounter = 0;

  function nextOpError(opKey: string): { message: string } | null {
    const queue = opErrorQueues[opKey];
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  function makeInsertBuilder(table: string) {
    return (rowsOrRow: Row | Row[]) => {
      const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
      function settle() {
        const err = nextOpError(`${table}.insert`);
        if (err) return { data: null, error: err };
        const inserted = rowsArr.map((r) => ({ id: (r.id as string) ?? `${table}-${++idCounter}`, ...r }));
        tables[table].push(...inserted);
        return { data: inserted, error: null };
      }
      return {
        select() {
          return { then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve) };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
    };
  }

  function makeMutateBuilder(table: string, op: "update" | "delete", patch?: Row) {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      in(field: string, values: unknown[]) {
        filtered = filtered.filter((r) => values.includes(r[field]));
        return builder;
      },
      then(resolve: (v: unknown) => unknown) {
        const err = nextOpError(`${table}.${op}`);
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve);
        if (op === "update") {
          const matched = new Set(filtered);
          for (const row of tables[table]) {
            if (matched.has(row)) Object.assign(row, patch);
          }
        } else {
          const toRemove = new Set(filtered);
          tables[table] = tables[table].filter((r) => !toRemove.has(r));
        }
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        insert: makeInsertBuilder(table),
        update(patch: Row) {
          return makeMutateBuilder(table, "update", patch);
        },
        delete() {
          return makeMutateBuilder(table, "delete");
        },
      };
    },
  } as unknown as SupabaseClient;

  return {
    admin,
    tables,
    setOpErrorQueue(table: string, op: "insert" | "update" | "delete", queue: Array<{ message: string } | null>) {
      opErrorQueues[`${table}.${op}`] = [...queue];
    },
  };
}

function sampleInsertRow(overrides: Row = {}): Row {
  return {
    tenant_id: TENANT_A,
    created_by_user_id: DRIVER_USER,
    is_draft: false,
    status: "new",
    date: "2026-08-10",
    time: "10:00:00",
    direction: "arrival",
    service_type: "transfer",
    vessel: "TRF001",
    pax: 2,
    hotel_id: "h1111111-1111-4111-8111-111111111111",
    customer_name: "Cliente Test",
    ...overrides,
  };
}

describe("import-driver-file-direct.ts — importabile senza side effect", () => {
  it("importare il modulo non esegue main() dal vivo (nessun accesso a file/env/rete)", () => {
    // Se il guard isDirectRun non funzionasse, l'import sopra avrebbe già
    // lanciato (file non trovato / env Supabase mancanti) prima che questo
    // test venga eseguito — arrivare qui è già la prova.
    expect(typeof writeDirectImportServicesAndAssignments).toBe("function");
  });
});

describe("writeDirectImportServicesAndAssignments — Sprint 8 orphan prevention", () => {
  it("1. successo: services+assignments+status update tutti riusciti", async () => {
    const fake = createFakeAdmin();
    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.insertedIds).toHaveLength(1);
    expect(fake.tables.services[0].status).toBe("assigned");
    expect(fake.tables.assignments).toHaveLength(1);
  });

  it("2. assignments.insert fallisce: step ASSIGNMENT_INSERT_FAILED, servizio resta 'new' (mai orphan)", async () => {
    const fake = createFakeAdmin();
    fake.setOpErrorQueue("assignments", "insert", [{ message: "raw db error" }]);

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe("ASSIGNMENT_INSERT_FAILED");
    expect(fake.tables.services).toHaveLength(1);
    expect(fake.tables.services[0].status).toBe("new");
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("3. services.update(status) fallisce al 1° tentativo ma il retry riesce: successo, nessuna compensazione", async () => {
    const fake = createFakeAdmin();
    fake.setOpErrorQueue("services", "update", [{ message: "transient" }, null]);

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(true);
    expect(fake.tables.services[0].status).toBe("assigned");
    expect(fake.tables.assignments).toHaveLength(1);
  });

  it("4. services.update(status) fallisce sia al 1° tentativo che al retry: compensazione cancella l'assignment, servizio resta 'new'", async () => {
    const fake = createFakeAdmin();
    fake.setOpErrorQueue("services", "update", [{ message: "fail 1" }, { message: "fail 2" }]);

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe("STATUS_UPDATE_FAILED");
    expect(fake.tables.assignments).toHaveLength(0);
    expect(fake.tables.services[0].status).toBe("new");
  });

  it("5. compensazione fallisce anch'essa: step COMPENSATION_FAILED, mai un successo silenzioso", async () => {
    const fake = createFakeAdmin();
    fake.setOpErrorQueue("services", "update", [{ message: "fail 1" }, { message: "fail 2" }]);
    fake.setOpErrorQueue("assignments", "delete", [{ message: "compensation also fails" }]);

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("COMPENSATION_FAILED");
      expect(result.error).toMatch(/compensazione fallita/);
    }
    // La riga assignment "fallita da cancellare" resta orfana in questo
    // scenario limite (compensazione stessa fallita) — per questo il
    // risultato NON è mai ok:true e il chiamante (main()) deve trattarlo
    // come errore fatale (throw), mai come successo.
  });

  it("6. services.insert fallisce: step SERVICE_INSERT_FAILED, nessuna scrittura assignments tentata", async () => {
    const fake = createFakeAdmin();
    fake.setOpErrorQueue("services", "insert", [{ message: "insert failed" }]);

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [sampleInsertRow()]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.step).toBe("SERVICE_INSERT_FAILED");
    expect(fake.tables.assignments).toHaveLength(0);
  });

  it("7. batch (più righe): un'unica insert bulk, nessuna query per riga", async () => {
    const fake = createFakeAdmin();
    const insertSpy = vi.spyOn(fake.admin, "from");

    const result = await writeDirectImportServicesAndAssignments(fake.admin, TENANT_A, DRIVER_USER, [
      sampleInsertRow({ vessel: "TRF001" }),
      sampleInsertRow({ vessel: "TRF002" }),
      sampleInsertRow({ vessel: "TRF003" }),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.insertedIds).toHaveLength(3);
    expect(fake.tables.assignments).toHaveLength(3);
    // services.insert, assignments.insert, services.update: 3 chiamate a
    // .from(), indipendentemente dal numero di righe nel batch (no N+1).
    expect(insertSpy).toHaveBeenCalledTimes(3);
  });
});
