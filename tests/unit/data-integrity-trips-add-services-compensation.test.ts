import { describe, it, expect } from "vitest";

/**
 * ITS Data Integrity Sprint 6 — TARGET B (_assignServicesToGroup add-path).
 *
 * Come in tests/unit/data-integrity-trips-rollback.test.ts (Sprint 5, stesso
 * file trips/route.ts, branch "remove"), riproduce fedelmente il pattern ORA
 * presente in produzione dopo il fix di questo sprint per
 * _assignServicesToGroup() — usato sia da create_trip sia dal branch
 * "aggiungi servizi a un giro esistente" di update_trip (variabile "toAdd").
 * Un test end-to-end sull'intera route non è stato scelto per lo stesso
 * motivo già accettato per il branch "remove" nello Sprint 5 (decine di
 * guard non pertinenti a monte). Il caso "create_trip, assignments.upsert
 * fallisce" È comunque coperto end-to-end da
 * tests/unit/piano-giorno-trips-create-trip-assignment-history.test.ts
 * (test 22, aggiornato in questo sprint).
 *
 * Prima del fix: _assignServicesToGroup faceva upsert(assignments) →
 * update(services.status) senza controllare NESSUno dei due esiti — un
 * upsert riuscito seguito da uno status update fallito lasciava
 * "assignment presente + status non 'assigned'" (mismatch), oppure — se
 * l'assignment sovrascriveva una riga preesistente legata a un altro
 * gruppo — una eventuale correzione avrebbe perso quella riga precedente.
 */

type Row = Record<string, unknown>;

function makeFakeAdmin(seed: { assignments?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    assignments: [...(seed.assignments ?? [])],
    services: [],
    status_events: [],
  };
  const failures = new Set<string>();
  const calls = { selects: 0, upserts: 0, updates: 0, deletes: 0 };

  function chain(table: string, op: "select" | "delete") {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
      in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
      then(resolve: (v: unknown) => unknown) {
        if (op === "select") {
          calls.selects += 1;
          if (failures.has(`${table}.select`)) return Promise.resolve({ data: null, error: { message: "simulated select failure" } }).then(resolve);
          return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve);
        }
        calls.deletes += 1;
        if (failures.has(`${table}.delete`)) return Promise.resolve({ data: null, error: { message: "simulated delete failure" } }).then(resolve);
        const toRemove = new Set(filtered);
        tables[table] = tables[table].filter((r) => !toRemove.has(r));
        return Promise.resolve({ data: null, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() { return chain(table, "select"); },
        delete() { return chain(table, "delete"); },
        update(payload: Row) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(field: string, value: unknown) { filters.push([field, value]); return builder; },
            in(field: string, values: unknown[]) { filters.push([field, values]); return builder; },
            then(resolve: (v: unknown) => unknown) {
              calls.updates += 1;
              if (failures.has(`${table}.update`)) return Promise.resolve({ data: null, error: { message: "simulated update failure" } }).then(resolve);
              const match = (r: Row) => filters.every(([f, v]) => Array.isArray(v) ? v.includes(r[f]) : r[f] === v);
              for (const r of tables[table] ?? []) if (match(r)) Object.assign(r, payload);
              return Promise.resolve({ data: null, error: null }).then(resolve);
            },
          };
          return builder;
        },
        upsert(rowsOrRow: Row | Row[], opts: { onConflict?: string } = {}) {
          calls.upserts += 1;
          if (failures.has(`${table}.upsert`)) return Promise.resolve({ data: null, error: { message: "simulated upsert failure" } });
          const rows = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          const conflictFields = (opts.onConflict ?? "id").split(",");
          for (const row of rows) {
            const existingIdx = tables[table].findIndex((r) => conflictFields.every((f) => r[f] === row[f]));
            if (existingIdx >= 0) Object.assign(tables[table][existingIdx], row);
            else tables[table].push({ id: row.id ?? `${table}-${Math.random().toString(36).slice(2)}`, ...row });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
    failNext(key: string) { failures.add(key); },
  };

  return { admin, tables, calls };
}

const TENANT_A = "t1";
const SERVICE_NEW = "svc-new";
const SERVICE_REASSIGNED = "svc-reassigned";
const GROUP_NEW = "grp-new";
const GROUP_OLD = "grp-A";

// Riproduce esattamente _assignServicesToGroup() ora in produzione
// (app/api/ops/piano-giorno/trips/route.ts, Sprint 6): snapshot batch →
// upsert (controllato) → services.status con 1 retry (controllato) →
// compensazione restore/delete → status_events solo se coerente.
async function runAssignServicesToGroupPattern(
  admin: ReturnType<typeof makeFakeAdmin>["admin"],
  tenantId: string,
  serviceIds: string[],
  assignRows: Row[]
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (serviceIds.length === 0) return { ok: true };

  const snapshotRes = await admin.from("assignments").select("*").eq("tenant_id", tenantId).in("service_id", serviceIds);
  if (snapshotRes.error) return { ok: false, error: "ASSIGNMENT_WRITE_FAILED" };

  const preExistingByServiceId = new Map<string, Row>(
    ((snapshotRes.data as Row[]) ?? []).map((row) => [row.service_id as string, row])
  );

  const assignRes = await admin.from("assignments").upsert(assignRows, { onConflict: "service_id,tenant_id" });
  if (assignRes.error) return { ok: false, error: "ASSIGNMENT_WRITE_FAILED" };

  let svcRes = await admin.from("services").update({ status: "assigned" }).in("id", serviceIds).eq("tenant_id", tenantId);
  if (svcRes.error) svcRes = await admin.from("services").update({ status: "assigned" }).in("id", serviceIds).eq("tenant_id", tenantId);

  if (svcRes.error) {
    const restoreRows: Row[] = [];
    const deleteOnlyIds: string[] = [];
    for (const sid of serviceIds) {
      const prev = preExistingByServiceId.get(sid);
      if (prev) {
        const { id: _id, ...rest } = prev;
        restoreRows.push(rest);
      } else {
        deleteOnlyIds.push(sid);
      }
    }
    let restoreError: string | null = null;
    if (restoreRows.length > 0) {
      const restoreRes = await admin.from("assignments").upsert(restoreRows, { onConflict: "service_id,tenant_id" });
      if (restoreRes.error) restoreError = restoreRes.error.message as string;
    }
    let deleteError: string | null = null;
    if (deleteOnlyIds.length > 0) {
      const deleteRes = await admin.from("assignments").delete().eq("tenant_id", tenantId).in("service_id", deleteOnlyIds);
      if (deleteRes.error) deleteError = deleteRes.error.message as string;
    }
    return (restoreError || deleteError) ? { ok: false, error: "COMPENSATION_FAILED" } : { ok: false, error: "STATUS_UPDATE_FAILED" };
  }

  await admin.from("status_events").upsert([{ tenant_id: tenantId, service_id: serviceIds[0] }], { onConflict: "tenant_id,service_id,status" });
  return { ok: true };
}

describe("Data Integrity Sprint 6 — _assignServicesToGroup add-path compensation", () => {
  it("1. assignments.upsert fallisce: services.status MAI toccato, ok:false", async () => {
    const { admin, calls } = makeFakeAdmin({ assignments: [] });
    admin.failNext("assignments.upsert");

    const result = await runAssignServicesToGroupPattern(admin, TENANT_A, [SERVICE_NEW], [
      { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: GROUP_NEW, driver_user_id: "d1", driver_profile_id: "p1", vehicle_label: "Van 8" },
    ]);

    expect(result).toEqual({ ok: false, error: "ASSIGNMENT_WRITE_FAILED" });
    expect(calls.updates).toBe(0); // services.status mai tentato
  });

  it("2. status update fallisce due volte, servizio SENZA assignment precedente: nuova riga cancellata, ok:false", async () => {
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [] });
    admin.failNext("services.update");

    const result = await runAssignServicesToGroupPattern(admin, TENANT_A, [SERVICE_NEW], [
      { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: GROUP_NEW, driver_user_id: "d1", driver_profile_id: "p1", vehicle_label: "Van 8" },
    ]);

    expect(result).toEqual({ ok: false, error: "STATUS_UPDATE_FAILED" });
    expect(calls.updates).toBe(2); // tentativo + retry
    expect(tables.assignments.find((a) => a.service_id === SERVICE_NEW)).toBeUndefined();
  });

  it("3. status update fallisce due volte, servizio CON assignment precedente in un altro gruppo (grp-A): ripristinato esattamente a grp-A, non lasciato al nuovo gruppo né cancellato", async () => {
    const previousRow = { id: "asg-prev", tenant_id: TENANT_A, service_id: SERVICE_REASSIGNED, group_id: GROUP_OLD, driver_user_id: "d-old", driver_profile_id: "p-old", vehicle_label: "Van 3", locked_by_operator: true };
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [previousRow] });
    admin.failNext("services.update");

    const result = await runAssignServicesToGroupPattern(admin, TENANT_A, [SERVICE_REASSIGNED], [
      { tenant_id: TENANT_A, service_id: SERVICE_REASSIGNED, group_id: GROUP_NEW, driver_user_id: "d-new", driver_profile_id: "p-new", vehicle_label: "Van 8" },
    ]);

    expect(result).toEqual({ ok: false, error: "STATUS_UPDATE_FAILED" });
    expect(calls.updates).toBe(2);
    const finalRow = tables.assignments.find((a) => a.service_id === SERVICE_REASSIGNED);
    expect(finalRow).toBeDefined();
    expect(finalRow?.group_id).toBe(GROUP_OLD); // tornato al gruppo ORIGINALE, non "grp-new"
    expect(finalRow?.driver_profile_id).toBe("p-old");
    expect(finalRow?.vehicle_label).toBe("Van 3");
  });

  it("4. compensazione stessa fallisce (restore fallisce): COMPENSATION_FAILED, mai un successo silenzioso", async () => {
    const previousRow = { id: "asg-prev", tenant_id: TENANT_A, service_id: SERVICE_REASSIGNED, group_id: GROUP_OLD, driver_user_id: "d-old", driver_profile_id: "p-old", vehicle_label: "Van 3", locked_by_operator: true };
    const { admin, calls } = makeFakeAdmin({ assignments: [previousRow] });
    admin.failNext("services.update");
    let upsertCount = 0;
    const originalFrom = admin.from.bind(admin);
    admin.from = (table: string) => {
      const built = originalFrom(table);
      if (table === "assignments") {
        const originalUpsert = built.upsert.bind(built);
        built.upsert = (rows: Row | Row[], opts?: { onConflict?: string }) => {
          upsertCount += 1;
          if (upsertCount === 2) return Promise.resolve({ data: null, error: { message: "restore also failed" } });
          return originalUpsert(rows, opts);
        };
      }
      return built;
    };

    const result = await runAssignServicesToGroupPattern(admin, TENANT_A, [SERVICE_REASSIGNED], [
      { tenant_id: TENANT_A, service_id: SERVICE_REASSIGNED, group_id: GROUP_NEW, driver_user_id: "d-new", driver_profile_id: "p-new", vehicle_label: "Van 8" },
    ]);

    expect(result).toEqual({ ok: false, error: "COMPENSATION_FAILED" });
    expect(calls.updates).toBe(2);
  });

  it("5. successo pieno: ok:true, status_events scritto, nessuna compensazione", async () => {
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [] });

    const result = await runAssignServicesToGroupPattern(admin, TENANT_A, [SERVICE_NEW], [
      { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: GROUP_NEW, driver_user_id: "d1", driver_profile_id: "p1", vehicle_label: "Van 8" },
    ]);

    expect(result).toEqual({ ok: true });
    expect(calls.updates).toBe(1);
    expect(tables.assignments.find((a) => a.service_id === SERVICE_NEW)).toBeDefined();
    expect(tables.status_events.length).toBe(1);
  });
});
