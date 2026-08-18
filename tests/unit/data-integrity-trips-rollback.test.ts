import { describe, it, expect } from "vitest";

/**
 * ITS Data Integrity Sprint 5 — TARGET 2 (trips/route.ts).
 *
 * Come in tests/unit/data-integrity-orphan-reproduction.test.ts (Sprint 4),
 * riproduce fedelmente — non reinventa — il pattern ORA presente nel codice
 * di produzione dopo il fix di questo sprint:
 *   app/api/ops/piano-giorno/trips/route.ts, branch "update_trip" (rimozione
 *   singoli servizi dal gruppo) e branch "delete_trip" (cancellazione
 *   intero trip). Un test end-to-end sull'intera route non è stato scelto
 *   per questi due branch: richiederebbe simulare le decine di guard non
 *   pertinenti a monte (disponibilità giornaliera, overlap driver/mezzo,
 *   push notification) per una route di 2000+ righe — stesso compromesso
 *   già accettato nello Sprint 4 per la stessa route.
 */

type Row = Record<string, unknown>;

function makeFakeAdmin(seed: { assignments?: Row[]; services?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    assignments: [...(seed.assignments ?? [])],
    services: [...(seed.services ?? [])],
  };
  const failures = new Set<string>();
  const calls = { deletes: 0, updates: 0, inserts: 0 };

  const admin = {
    from(table: string) {
      return {
        insert(rows: Row | Row[]) {
          calls.inserts += 1;
          if (failures.has(`${table}.insert`)) return Promise.resolve({ data: null, error: { message: "simulated insert failure" } });
          tables[table].push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ data: null, error: null });
        },
        update(payload: Row) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(field: string, value: unknown) { filters.push([field, value]); return builder; },
            in(field: string, values: unknown[]) { filters.push([field, values]); return builder; },
            then(resolve: (v: unknown) => unknown) {
              calls.updates += 1;
              if (failures.has(`${table}.update`)) return Promise.resolve({ data: null, error: { message: "simulated update failure" } }).then(resolve);
              const match = (r: Row) => filters.every(([f, v]) => Array.isArray(v) ? v.includes(r[f]) : r[f] === v);
              for (const r of tables[table]) if (match(r)) Object.assign(r, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return builder;
        },
        delete() {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(field: string, value: unknown) { filters.push([field, value]); return builder; },
            in(field: string, values: unknown[]) { filters.push([field, values]); return builder; },
            then(resolve: (v: unknown) => unknown) {
              calls.deletes += 1;
              if (failures.has(`${table}.delete`)) return Promise.resolve({ data: null, error: { message: "simulated delete failure" } }).then(resolve);
              const match = (r: Row) => filters.every(([f, v]) => Array.isArray(v) ? v.includes(r[f]) : r[f] === v);
              tables[table] = tables[table].filter((r) => !match(r));
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return builder;
        },
      };
    },
    failNext(key: string) { failures.add(key); },
  };

  return { admin, tables, calls };
}

const TENANT_A = "t1";
const SERVICE_1 = "svc-1";
const GROUP_1 = "grp-1";

// Riproduce esattamente il pattern del branch "update_trip" (rimozione
// singoli servizi) DOPO il fix Sprint 5:
// delete → (se ok) update status con 1 retry → (se ancora errore) restore.
// httpStatus riflette la risposta REALE della route dopo il fix: ogni ramo
// di fallimento (delete, o status-rollback anche quando la compensating
// restore riesce) restituisce ok:false/500 — mai più {ok:true} silenzioso.
async function runUpdateTripRemoveServicesPattern(admin: ReturnType<typeof makeFakeAdmin>["admin"], toRemove: Row[]) {
  const deleteRes = await admin.from("assignments").delete().in("id", toRemove.map((a) => a.id)).eq("tenant_id", TENANT_A);
  if (deleteRes.error) return { deleteFailed: true, statusRolledBack: false, restored: false, httpStatus: 500 };

  let statusRollbackRes = await admin.from("services").update({ status: "new" }).in("id", toRemove.map((a) => a.service_id)).eq("tenant_id", TENANT_A);
  if (statusRollbackRes.error) {
    statusRollbackRes = await admin.from("services").update({ status: "new" }).in("id", toRemove.map((a) => a.service_id)).eq("tenant_id", TENANT_A);
  }
  if (statusRollbackRes.error) {
    const restoreRows = toRemove.map((row) => { const { id: _id, ...rest } = row; return rest; });
    const restoreRes = await admin.from("assignments").insert(restoreRows);
    // La route restituisce sempre un errore qui (500), sia che la restore
    // riesca sia che fallisca: la rimozione richiesta dall'utente non è
    // comunque avvenuta con successo — nessun {ok:true} silenzioso.
    return { deleteFailed: false, statusRolledBack: false, restored: !restoreRes.error, httpStatus: 500 };
  }
  return { deleteFailed: false, statusRolledBack: true, restored: false, httpStatus: 200 };
}

describe("Data Integrity Sprint 5 — trips update_trip (remove services) rollback", () => {
  it("4. assignments.delete riesce, services.update(status='new') fallisce anche dopo retry ⇒ compensating restore, niente silent success", async () => {
    const toRemove = [{ id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, driver_user_id: "u1", vehicle_label: "Van 8" }];
    const { admin, tables, calls } = makeFakeAdmin({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
      assignments: [...toRemove],
    });
    admin.failNext("services.update");

    const result = await runUpdateTripRemoveServicesPattern(admin, toRemove);

    expect(result.deleteFailed).toBe(false);
    expect(result.statusRolledBack).toBe(false);
    expect(result.restored).toBe(true); // compensating restore applicato
    expect(result.httpStatus).toBe(500); // niente {ok:true} silenzioso, anche se la restore riesce
    expect(calls.updates).toBe(2); // tentativo + retry
    const restoredAssignment = tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(restoredAssignment).toBeDefined(); // assignment ripristinato
    const service = tables.services.find((s) => s.id === SERVICE_1);
    expect(service?.status).toBe("assigned"); // coerente con l'assignment ripristinato — NESSUN orphan
  });

  it("4b. assignments.delete riesce, services.update riesce al primo tentativo: nessuna compensazione necessaria, invariante rispettata (status='new', nessun assignment)", async () => {
    const toRemove = [{ id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, driver_user_id: "u1", vehicle_label: "Van 8" }];
    const { admin, tables, calls } = makeFakeAdmin({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
      assignments: [...toRemove],
    });

    const result = await runUpdateTripRemoveServicesPattern(admin, toRemove);

    expect(result.statusRolledBack).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(calls.updates).toBe(1); // nessun retry necessario
    expect(tables.assignments.find((a) => a.service_id === SERVICE_1)).toBeUndefined();
    expect(tables.services.find((s) => s.id === SERVICE_1)?.status).toBe("new");
  });
});

// Riproduce il pattern del branch "delete_trip" (cancellazione intero trip)
// DOPO il fix Sprint 5: assignments.delete (controllato, ritorna errore
// sanitizzato se fallisce, non più silenzioso) → services.update con retry
// → restore se persiste.
async function runDeleteTripPattern(admin: ReturnType<typeof makeFakeAdmin>["admin"], groupAssignments: Row[]) {
  const deleteRes = await admin.from("assignments").delete().eq("group_id", GROUP_1).eq("tenant_id", TENANT_A);
  if (deleteRes.error) return { httpStatus: 500, restored: false };

  const serviceIds = groupAssignments.map((a) => a.service_id as string);
  if (serviceIds.length === 0) return { httpStatus: 200, restored: false };

  let statusRollbackRes = await admin.from("services").update({ status: "new" }).in("id", serviceIds).eq("tenant_id", TENANT_A);
  if (statusRollbackRes.error) {
    statusRollbackRes = await admin.from("services").update({ status: "new" }).in("id", serviceIds).eq("tenant_id", TENANT_A);
  }
  if (statusRollbackRes.error) {
    const restoreRows = groupAssignments.map((row) => { const { id: _id, ...rest } = row; return rest; });
    const restoreRes = await admin.from("assignments").insert(restoreRows);
    // La route restituisce sempre un errore qui (500), sia che la restore
    // riesca sia che fallisca: la cancellazione richiesta dall'utente non è
    // comunque avvenuta con successo — nessun {ok:true} silenzioso.
    return { httpStatus: 500, restored: !restoreRes.error };
  }
  return { httpStatus: 200, restored: false };
}

describe("Data Integrity Sprint 5 — trips delete_trip (cancel) rollback", () => {
  it("5a. assignments.delete fallisce: errore sanitizzato restituito, status MAI toccato (niente più silent success)", async () => {
    const groupAssignments = [{ id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, driver_user_id: "u1", vehicle_label: "Van 8" }];
    const { admin, tables } = makeFakeAdmin({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
      assignments: [...groupAssignments],
    });
    admin.failNext("assignments.delete");

    const result = await runDeleteTripPattern(admin, groupAssignments);

    expect(result.httpStatus).toBe(500); // errore esplicito, non {ok:true} silenzioso
    expect(tables.assignments.find((a) => a.service_id === SERVICE_1)).toBeDefined(); // mai toccato
    expect(tables.services.find((s) => s.id === SERVICE_1)?.status).toBe("assigned"); // mai toccato — coerente
  });

  it("5b. assignments.delete riesce, services.update fallisce anche dopo retry ⇒ compensating restore, niente orphan", async () => {
    const groupAssignments = [{ id: "asg-1", tenant_id: TENANT_A, group_id: GROUP_1, service_id: SERVICE_1, driver_user_id: "u1", vehicle_label: "Van 8" }];
    const { admin, tables, calls } = makeFakeAdmin({
      services: [{ id: SERVICE_1, tenant_id: TENANT_A, status: "assigned" }],
      assignments: [...groupAssignments],
    });
    admin.failNext("services.update");

    const result = await runDeleteTripPattern(admin, groupAssignments);

    expect(result.httpStatus).toBe(500); // niente {ok:true} silenzioso, anche se la restore riesce
    expect(result.restored).toBe(true);
    expect(calls.updates).toBe(2);
    expect(tables.assignments.find((a) => a.service_id === SERVICE_1)).toBeDefined(); // ripristinato
    expect(tables.services.find((s) => s.id === SERVICE_1)?.status).toBe("assigned"); // coerente col ripristino
  });
});
