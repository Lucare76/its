import { describe, it, expect } from "vitest";

/**
 * ITS Data Integrity Sprint 6 — TARGET A (auto-assign regenerate_all
 * compensation).
 *
 * Come in tests/unit/data-integrity-trips-rollback.test.ts (Sprint 5),
 * riproduce fedelmente — non reinventa — il pattern ORA presente in
 * produzione dopo il fix di questo sprint:
 *   app/api/ops/piano-giorno/auto-assign/route.ts, blocco
 *   "allServiceIds.length > 0" (snapshot pre-upsert → upsert → status update
 *   con retry → compensazione restore/delete). Un test end-to-end sull'intera
 *   route (2000+ righe, decine di guard non pertinenti a monte) non è stato
 *   scelto per lo stesso motivo già accettato per trips/route.ts.
 *
 * Contesto del bug chiuso: in regenerate_all, il passo di cleanup
 * (route.ts:~1209-1238) cancella SOLO gli assignment agganciati a un
 * trip_group "active" di quella data. Un assignment "orfano" (group_id
 * nullo, es. residuo di un fallimento precedente) o legato a un gruppo non
 * più "active" sopravvive al cleanup e viene quindi SOVRASCRITTO (non
 * ricreato) dall'upsert successivo — è esattamente questo il caso che una
 * compensating delete cieca perderebbe: il servizio finirebbe con
 * status='assigned' (mai toccato dal cleanup, perché quel filtro guarda solo
 * gli assignment con group_id in un gruppo attivo) e NESSUN assignment.
 */

type Row = Record<string, unknown>;

function makeFakeAdmin(seed: { assignments?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    assignments: [...(seed.assignments ?? [])],
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
        // delete
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
const SERVICE_ORPHAN = "svc-orphan";
const SERVICE_NEW = "svc-new";

// Riproduce esattamente la sequenza ora in produzione (auto-assign/route.ts,
// blocco "allServiceIds.length > 0", Sprint 6): snapshot batch pre-upsert →
// upsert → (se ok) services.status update con 1 retry → se persiste,
// compensazione che distingue restore (CASO B) da delete (CASO A).
async function runAutoAssignWritePattern(
  admin: ReturnType<typeof makeFakeAdmin>["admin"],
  tenantId: string,
  allServiceIds: string[],
  allAssignRows: Row[]
) {
  const snapshotRes = await admin.from("assignments").select("*").eq("tenant_id", tenantId).in("service_id", allServiceIds);
  if (snapshotRes.error) return { httpOk: true, compensated: null, restored: 0, deleted: 0 };

  const preExistingByServiceId = new Map<string, Row>(
    ((snapshotRes.data as Row[]) ?? []).map((row) => [row.service_id as string, row])
  );

  const assignRes = await admin.from("assignments").upsert(allAssignRows, { onConflict: "service_id,tenant_id" });
  if (assignRes.error) return { httpOk: true, compensated: null, restored: 0, deleted: 0 };

  let svcRes = await admin.from("services").update({ status: "assigned" }).in("id", allServiceIds).eq("tenant_id", tenantId);
  if (svcRes.error) svcRes = await admin.from("services").update({ status: "assigned" }).in("id", allServiceIds).eq("tenant_id", tenantId);

  if (!svcRes.error) return { httpOk: true, compensated: false, restored: 0, deleted: 0 };

  const restoreRows: Row[] = [];
  const deleteOnlyIds: string[] = [];
  for (const sid of allServiceIds) {
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

  return {
    httpOk: true, // il top-level auto-assign endpoint resta ok:true (convenzione preesistente, invariata da Sprint 6 — vedi report)
    compensated: !restoreError && !deleteError,
    restored: restoreRows.length,
    deleted: deleteOnlyIds.length,
  };
}

describe("Data Integrity Sprint 6 — auto-assign regenerate_all compensation (restore vs delete)", () => {
  it("1. assignment orfano (group_id null) sopravvissuto al cleanup: compensazione lo RIPRISTINA esattamente, non lo cancella", async () => {
    const orphanRow = { id: "asg-orphan", tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: null, driver_user_id: "driver-old", driver_profile_id: "profile-old", vehicle_label: "Van 5", locked_by_operator: false };
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [orphanRow] });
    admin.failNext("services.update");

    const newAssignRow = { tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" };
    const result = await runAutoAssignWritePattern(admin, TENANT_A, [SERVICE_ORPHAN], [newAssignRow]);

    expect(calls.updates).toBe(2); // tentativo + retry
    expect(result.compensated).toBe(true);
    expect(result.restored).toBe(1);
    expect(result.deleted).toBe(0);

    const finalRow = tables.assignments.find((a) => a.service_id === SERVICE_ORPHAN);
    expect(finalRow).toBeDefined();
    expect(finalRow?.group_id).toBeNull(); // ripristinato al valore ORIGINALE (orfano), non lasciato a "grp-new"
    expect(finalRow?.driver_profile_id).toBe("profile-old");
    expect(finalRow?.vehicle_label).toBe("Van 5");
  });

  it("2. servizio senza assignment precedente: compensazione CANCELLA l'assignment appena creato, nessun residuo", async () => {
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [] });
    admin.failNext("services.update");

    const newAssignRow = { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" };
    const result = await runAutoAssignWritePattern(admin, TENANT_A, [SERVICE_NEW], [newAssignRow]);

    expect(calls.updates).toBe(2);
    expect(result.compensated).toBe(true);
    expect(result.restored).toBe(0);
    expect(result.deleted).toBe(1);
    expect(tables.assignments.find((a) => a.service_id === SERVICE_NEW)).toBeUndefined();
  });

  it("3. batch misto (un orfano da ripristinare + un nuovo da cancellare): esito corretto per ciascuno", async () => {
    const orphanRow = { id: "asg-orphan", tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: null, driver_user_id: "driver-old", driver_profile_id: "profile-old", vehicle_label: "Van 5", locked_by_operator: false };
    const { admin, tables } = makeFakeAdmin({ assignments: [orphanRow] });
    admin.failNext("services.update");

    const allAssignRows = [
      { tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" },
      { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" },
    ];
    const result = await runAutoAssignWritePattern(admin, TENANT_A, [SERVICE_ORPHAN, SERVICE_NEW], allAssignRows);

    expect(result.restored).toBe(1);
    expect(result.deleted).toBe(1);
    expect(tables.assignments.find((a) => a.service_id === SERVICE_ORPHAN)?.group_id).toBeNull();
    expect(tables.assignments.find((a) => a.service_id === SERVICE_NEW)).toBeUndefined();
  });

  it("4. successo pieno (nessun fallimento nella sequenza): compensazione mai raggiunta", async () => {
    // Il caso "retry riesce al secondo tentativo" (fallimento transitorio
    // seguito da successo) è già coperto end-to-end da
    // data-integrity-auto-assign-atomicity.test.ts (test 2b, sulla route
    // reale). Qui verifichiamo solo che, a sequenza interamente riuscita, il
    // ramo di compensazione non venga mai raggiunto.
    const { admin, tables, calls } = makeFakeAdmin({ assignments: [] });
    const newAssignRow = { tenant_id: TENANT_A, service_id: SERVICE_NEW, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" };
    const result = await runAutoAssignWritePattern(admin, TENANT_A, [SERVICE_NEW], [newAssignRow]);

    expect(result.compensated).toBe(false);
    expect(calls.updates).toBe(1);
    expect(tables.assignments.find((a) => a.service_id === SERVICE_NEW)).toBeDefined();
  });

  it("5. compensazione stessa fallisce (la seconda upsert, quella di restore, fallisce): compensation_failed, mai un esito silenzioso", async () => {
    // Isola "compensazione fallisce" senza far fallire l'upsert iniziale
    // (che abortirebbe prima di arrivare alla compensazione): la fake fa
    // fallire solo la SECONDA chiamata upsert su "assignments" (quella di
    // restore), non la prima (creazione).
    const orphanRow = { id: "asg-orphan", tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: null, driver_user_id: "driver-old", driver_profile_id: "profile-old", vehicle_label: "Van 5", locked_by_operator: false };
    const { admin, calls } = makeFakeAdmin({ assignments: [orphanRow] });
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

    const newAssignRow = { tenant_id: TENANT_A, service_id: SERVICE_ORPHAN, group_id: "grp-new", driver_user_id: "driver-new", driver_profile_id: "profile-new", vehicle_label: "Van 8" };
    const result = await runAutoAssignWritePattern(admin, TENANT_A, [SERVICE_ORPHAN], [newAssignRow]);

    expect(result.compensated).toBe(false); // compensation_failed
    expect(calls.updates).toBe(2);
  });
});
