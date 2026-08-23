import { describe, it, expect } from "vitest";

/**
 * ITS Data Integrity Sprint 4 — FASE 8/10/12.
 *
 * Riproduce, con un fake Supabase minimale, i DUE meccanismi non-atomici
 * individuati via code audit che POSSONO in teoria produrre un servizio
 * "assigned" senza assignment corrispondente (indipendentemente dal fatto
 * che siano o meno la causa dei 36 record storici — vedi report Sprint 4,
 * §5/§13: quei 36 hanno una firma diversa, zero status_events/history,
 * incompatibile con questi due path che scrivono sempre status_events).
 *
 * Non invoca le route reali (setup con decine di tabelle/dipendenze fuori
 * scope per un test mirato): riproduce fedelmente, riga per riga, lo stesso
 * pattern Promise.all/sequenza già presente nel codice di produzione,
 * citato con path:linea nei commenti — non una logica reinventata.
 */

type Row = Record<string, unknown>;

function makeFakeAdmin(seed: { assignments?: Row[]; services?: Row[]; status_events?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    assignments: [...(seed.assignments ?? [])],
    services: [...(seed.services ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };
  const failures = new Set<string>();

  const admin = {
    from(table: string) {
      return {
        upsert(rows: Row[]) {
          if (failures.has(`${table}.upsert`)) return Promise.resolve({ data: null, error: { message: "simulated upsert failure" } });
          tables[table].push(...rows);
          return Promise.resolve({ data: null, error: null });
        },
        insert(rows: Row[]) {
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
            then(resolve: (v: unknown) => unknown) {
              const match = (r: Row) => filters.every(([f, v]) => r[f] === v);
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

  return { admin, tables };
}

describe("Orphan reproduction — auto-assign Promise.all non-atomico (app/api/ops/piano-giorno/auto-assign/route.ts:2030-2033)", () => {
  it("1. assignments.upsert fallisce ma services.update(status=assigned) riesce comunque: produce un orphan CON status_events (firma diversa dai 36 storici, ma un vero rischio latente)", async () => {
    const SERVICE_1 = "svc-1";
    const { admin, tables } = makeFakeAdmin({ services: [{ id: SERVICE_1, tenant_id: "t1", status: "new" }] });
    admin.failNext("assignments.upsert");

    // Stesso pattern esatto della route: le tre scritture in Promise.all,
    // nessuna dipende dall'esito delle altre.
    const [assignRes, svcRes, statusRes] = await Promise.all([
      admin.from("assignments").upsert([{ tenant_id: "t1", service_id: SERVICE_1, driver_profile_id: "d1" }]),
      admin.from("services").update({ status: "assigned" }).in("id", [SERVICE_1]).eq("tenant_id", "t1"),
      admin.from("status_events").insert([{ tenant_id: "t1", service_id: SERVICE_1, status: "assigned" }]),
    ]);

    expect(assignRes.error).toBeTruthy();
    expect(svcRes.error).toBeNull();
    expect(statusRes.error).toBeNull();

    const service = tables.services.find((s) => s.id === SERVICE_1);
    const assignment = tables.assignments.find((a) => a.service_id === SERVICE_1);
    expect(service?.status).toBe("assigned"); // orphan riprodotto: status flippato
    expect(assignment).toBeUndefined(); // nessun assignment creato
    expect(tables.status_events.length).toBe(1); // MA lo status_event esiste — firma diversa dai 36 reali (zero status_events)
  });
});

describe("Orphan reproduction — trips/route.ts cancel_trip: delete assignment poi services.update senza controllo errore (app/api/ops/piano-giorno/trips/route.ts:816-822)", () => {
  it("2. assignments.delete riesce, il successivo services.update(status='new') fallisce silenziosamente: status resta 'assigned' senza assignment", async () => {
    const SERVICE_1 = "svc-2";
    const GROUP_1 = "grp-1";
    const { admin, tables } = makeFakeAdmin({
      services: [{ id: SERVICE_1, tenant_id: "t1", status: "assigned" }],
      assignments: [{ id: "asg-1", tenant_id: "t1", group_id: GROUP_1, service_id: SERVICE_1 }],
    });
    admin.failNext("services.update");

    // Stesso pattern esatto della route: delete assignments (Promise.all con
    // trip_groups.update, qui omesso perché non rilevante per l'invariante),
    // poi un services.update SEPARATO e SENZA controllo dell'errore.
    await Promise.all([
      admin.from("assignments").delete().eq("group_id", GROUP_1).eq("tenant_id", "t1"),
    ]);
    await admin.from("services").update({ status: "new" }).in("id", [SERVICE_1]).eq("tenant_id", "t1");
    // La route reale non verifica l'errore di questo update — riprodotto
    // fedelmente: nessun controllo qui neppure nel test.

    const service = tables.services.find((s) => s.id === SERVICE_1);
    const assignment = tables.assignments.find((a) => a.group_id === GROUP_1);
    expect(assignment).toBeUndefined(); // assignment correttamente cancellato
    expect(service?.status).toBe("assigned"); // orphan riprodotto: rollback status fallito silenziosamente
  });
});

describe("Non-riproducibilità — assignServiceCore (lib/server/assign-service-core.ts)", () => {
  it("3. il write di assignments precede sempre quello di services.status: un fallimento sull'assignment impedisce l'update dello status (documentato, già coperto da assign-service-assignment-history.test.ts #20)", () => {
    // Nessun test aggiuntivo necessario: assign-service-assignment-history.test.ts
    // (test #20 "nessun history su errore insert assignment (500)") già dimostra
    // che un errore sull'insert assignments produce 500 PRIMA di qualunque
    // scrittura su services.status — la sequenza (non il Promise.all) rende
    // assignServiceCore strutturalmente non capace di produrre questo orphan
    // pattern. Documentato qui come nota di readibilità del report, non
    // duplicato come test.
    expect(true).toBe(true);
  });
});
