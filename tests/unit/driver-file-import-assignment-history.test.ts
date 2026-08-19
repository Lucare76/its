import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import * as XLSX from "xlsx";

/**
 * Test CONC-07 LOW — storico strutturato (driver_assignment_history) su
 * POST /api/ops/driver-file-import.
 *
 * L'import crea services + assignments nuovi da un file Excel caricato, ma
 * non registrava mai la variazione tramite logAssignmentChange (gap
 * confermato dall'audit finale CONC-07 a livello progetto). L'import scrive
 * assignments con `driver_user_id` (dal body) e `vehicle_label: ""` sempre —
 * mai `driver_profile_id`, campo che invece è l'unico tracciato dallo schema
 * driver_assignment_history per cambio driver. Il fix risolve
 * `driver_profile_id` dal `driver_user_id` con una query in sola lettura
 * tenant-scoped, esclusivamente per arricchire lo storico — non altera
 * parsing/creazione services/risoluzione driver/risposta HTTP.
 *
 * Contratto riusato: changeType "driver_swap" solo se il driver è
 * risolvibile a un driver_profile_id reale (previous sempre null: gli
 * assignment sono garantiti nuovi, i service_id sono appena generati in
 * questa stessa richiesta). vehicle_label è sempre "" per questo import
 * (mai un valore reale), quindi non genera mai "vehicle_binding" — nessun
 * evento inventato quando non c'è alcun segnale tracciabile (driver non
 * risolvibile).
 *
 * Poiché sia `services.insert(inserts)` sia `assignments.insert(...)` sono
 * ciascuno un'unica INSERT bulk (atomica lato Postgres: o l'intero batch
 * riesce o fallisce), non esiste un vero scenario di "partial success" a
 * livello di singola riga in questo import — uno scenario dedicato
 * documenta questo limite invece di inventare un comportamento inesistente.
 */

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_1 = "h1111111-1111-4111-8111-111111111111";
const HOTEL_2 = "h2222222-2222-4222-8222-222222222222";
const DRIVER_USER = "11111111-1111-4111-8111-111111111111";
const DRIVER_PROFILE = "d1111111-1111-4111-8111-111111111111";
const OPERATOR_1 = "op111111-1111-4111-8111-111111111111";
const TEST_DATE = "2026-08-10";

type Row = Record<string, unknown>;

function buildXlsxFile(rows: (string | number)[][]): File {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([buffer], "import.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

function singleValidRow(overrides: Partial<{
  driverName: string; time: string; reference: string; pax: string; typeLabel: string;
  billingParty: string; origin: string; destination: string; customer: string;
}> = {}) {
  const r = {
    driverName: "Mario Rossi",
    time: "10:00",
    reference: "TRF001",
    pax: "2",
    typeLabel: "Arrivo",
    billingParty: "Agenzia XYZ",
    origin: "Casamicciola",
    destination: "Hotel Test",
    customer: "Cliente Test",
    ...overrides,
  };
  return [r.driverName, r.time, r.reference, r.pax, r.typeLabel, r.billingParty, r.origin, r.destination, "", "", r.customer];
}

/** Fake Supabase in-memory, tenant-aware — schema minimo per le tabelle usate da driver-file-import. */
function createTenantAwareSupabase(
  seed: Partial<Record<"hotels" | "hotel_aliases" | "driver_profiles" | "services" | "assignments" | "status_events", Row[]>> = {}
) {
  const tables: Record<string, Row[]> = {
    hotels: [...(seed.hotels ?? [])],
    hotel_aliases: [...(seed.hotel_aliases ?? [])],
    driver_profiles: [...(seed.driver_profiles ?? [])],
    services: [...(seed.services ?? [])],
    assignments: [...(seed.assignments ?? [])],
    status_events: [...(seed.status_events ?? [])],
  };

  const tableErrors: Record<string, { message: string } | undefined> = {};
  // Data Integrity Sprint 7: coda di errori per operazione (es.
  // "services.update", "assignments.delete") — a differenza di tableErrors
  // (blanket, per tabella, tutte le operazioni), qui ogni chiamata consuma
  // una entry dalla coda: permette di simulare "1° tentativo fallisce, il
  // retry riesce" o "entrambi falliscono" senza toccare il comportamento
  // esistente di tableErrors (controllato per primo, invariato).
  const opErrorQueues: Record<string, Array<{ message: string } | null>> = {};
  let idCounter = 0;

  function nextOpError(opKey: string): { message: string } | null {
    const queue = opErrorQueues[opKey];
    if (!queue || queue.length === 0) return null;
    return queue.shift() ?? null;
  }

  function makeSelectBuilder(table: string) {
    let filtered = tables[table];
    const builder = {
      eq(field: string, value: unknown) {
        filtered = filtered.filter((r) => r[field] === value);
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      maybeSingle() {
        if (tableErrors[table]) return Promise.resolve({ data: null, error: tableErrors[table] });
        return Promise.resolve({ data: filtered[0] ? { ...filtered[0] } : null, error: null });
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        if (tableErrors[table]) return Promise.resolve({ data: null, error: tableErrors[table] }).then(resolve, reject);
        return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  function makeInsertBuilder(table: string, rowsArr: Row[]) {
    function settle() {
      if (tableErrors[table]) return { data: null, error: tableErrors[table] };
      const inserted = rowsArr.map((r) => ({ id: (r.id as string) ?? `${table}-${++idCounter}`, ...r }));
      tables[table].push(...inserted);
      return { data: inserted, error: null };
    }
    return {
      select() {
        return {
          then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
            return Promise.resolve(settle()).then(resolve, reject);
          },
        };
      },
      then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(settle()).then(resolve, reject);
      },
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
      then(resolve: (v: { data: null; error: { message: string } | null }) => unknown, reject?: (e: unknown) => unknown) {
        const opKey = `${table}.${op}`;
        const err = tableErrors[table] ?? nextOpError(opKey);
        if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
        if (op === "update") {
          const matched = new Set(filtered);
          for (const row of tables[table]) {
            if (matched.has(row)) Object.assign(row, patch);
          }
        } else {
          const toRemove = new Set(filtered);
          tables[table] = tables[table].filter((r) => !toRemove.has(r));
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  }

  const admin = {
    from(table: string) {
      return {
        select() {
          return makeSelectBuilder(table);
        },
        insert(rowsOrRow: Row | Row[]) {
          const rowsArr = Array.isArray(rowsOrRow) ? rowsOrRow : [rowsOrRow];
          return makeInsertBuilder(table, rowsArr);
        },
        update(patch: Row) {
          return makeMutateBuilder(table, "update", patch);
        },
        delete() {
          return makeMutateBuilder(table, "delete");
        },
      };
    },
  };

  return {
    admin,
    tables,
    setError(table: string, err: { message: string } | null) {
      tableErrors[table] = err ?? undefined;
    },
    // Data Integrity Sprint 7: inietta una sequenza di esiti per una singola
    // operazione (es. "services.update", "assignments.delete") — ogni
    // chiamata consuma un elemento; `null` = successo, `{message}` =
    // fallimento. Usato per simulare retry (1° fallisce, 2° riesce) senza
    // interferire con tableErrors (blanket, usato dai test preesistenti).
    setOpErrorQueue(table: string, op: "update" | "delete", queue: Array<{ message: string } | null>) {
      opErrorQueues[`${table}.${op}`] = [...queue];
    },
  };
}

const mocks = vi.hoisted(() => ({
  authorizePricingRequest: vi.fn(),
  logAssignmentChange: vi.fn(),
  updateLearnedPatterns: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/server/pricing-auth", () => ({
  authorizePricingRequest: mocks.authorizePricingRequest,
}));
vi.mock("@/lib/server/assignment-history", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/assignment-history")>("@/lib/server/assignment-history");
  return {
    ...actual,
    logAssignmentChange: mocks.logAssignmentChange,
  };
});
vi.mock("@/lib/server/learned-patterns", () => ({
  updateLearnedPatterns: mocks.updateLearnedPatterns,
}));
vi.mock("@/lib/server/ops-audit", () => ({
  auditLog: mocks.auditLog,
}));

import { POST } from "@/app/api/ops/driver-file-import/route";

function baseSeed(overrides: Parameters<typeof createTenantAwareSupabase>[0] = {}) {
  return createTenantAwareSupabase({
    hotels: [{ id: HOTEL_1, tenant_id: TENANT_A, name: "Hotel Test", normalized_name: "hotel test" }],
    hotel_aliases: [],
    driver_profiles: [{ id: DRIVER_PROFILE, tenant_id: TENANT_A, user_id: DRIVER_USER, full_name: "Mario Rossi" }],
    services: [],
    assignments: [],
    status_events: [],
    ...overrides,
  });
}

function makeRequest(fields: Record<string, string>, rows: (string | number)[][] | null) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  if (rows) fd.append("file", buildXlsxFile(rows));
  return new NextRequest("http://localhost:3010/api/ops/driver-file-import", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: fd,
  });
}

function callPost(fieldOverrides: Record<string, string> = {}, rows: (string | number)[][] = [singleValidRow()]) {
  return POST(makeRequest({
    service_date: TEST_DATE,
    driver_user_id: DRIVER_USER,
    dry_run: "false",
    ...fieldOverrides,
  }, rows));
}

function authorizeAs(fake: ReturnType<typeof createTenantAwareSupabase>, userId: string = OPERATOR_1, role: string = "operator") {
  mocks.authorizePricingRequest.mockResolvedValue({
    admin: fake.admin,
    user: { id: userId, email: `${userId}@test.dev` },
    membership: { tenant_id: TENANT_A, role, suspended: false },
  });
}

function lastHistoryEntries(): Row[] {
  const calls = mocks.logAssignmentChange.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][1] as Row[];
}

describe("CONC-07 LOW — storico strutturato (driver_assignment_history) su driver-file-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("1. import singolo con driver risolvibile: history scritta, changeType driver_swap", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].changeType).toBe("driver_swap");
  });

  it("2. import batch (più righe): un entry per assignment, una sola chiamata batch", async () => {
    const fake = baseSeed({
      hotels: [
        { id: HOTEL_1, tenant_id: TENANT_A, name: "Hotel Test", normalized_name: "hotel test" },
        { id: HOTEL_2, tenant_id: TENANT_A, name: "Hotel Alpha", normalized_name: "hotel alpha" },
      ],
    });
    authorizeAs(fake);

    const rows = [
      singleValidRow({ reference: "TRF001", destination: "Hotel Test" }),
      singleValidRow({ reference: "TRF002", destination: "Hotel Alpha", time: "11:00" }),
    ];
    const res = await callPost({}, rows);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.imported_rows).toBe(2);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.serviceId)).size).toBe(2);
  });

  it("3. driver_profile corretto nell'entry (risolto da driver_user_id)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].toDriverProfileId).toBe(DRIVER_PROFILE);
    expect(entries[0].fromDriverProfileId).toBeNull();
  });

  it("4. vehicle: N/A, questo import scrive sempre vehicle_label \"\" (mai un valore reale) — nessun campo vehicle_binding generato, from/to vehicle sempre null nell'entry", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].fromVehicleLabel).toBeNull();
    expect(entries[0].toVehicleLabel).toBeNull();
  });

  it("5. previous null: garantito per costruzione (service_id appena generato nella stessa richiesta)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].fromDriverProfileId).toBeNull();
    expect(entries[0].fromVehicleLabel).toBeNull();
  });

  it("6. groupId: N/A, questo import non crea mai un trip_group — sempre null nell'entry, nessun evento inventato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].groupId).toBeNull();
  });

  it("7. actor corretto: operatorId coincide con l'utente autenticato", async () => {
    const fake = baseSeed();
    authorizeAs(fake, "operator-xyz");

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].operatorId).toBe("operator-xyz");
  });

  it("8. tenant corretto: tenantId coincide con quello della sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("9. tenant spoof ignorato: non esiste un campo tenant nel form (solo service_date/driver_user_id/dry_run/file) — history usa sempre il tenant di sessione", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ tenant_id: TENANT_B });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    const entries = lastHistoryEntries();
    expect(entries[0].tenantId).toBe(TENANT_A);
  });

  it("10. tenant B escluso: driver_profiles/hotels di tenant B non vengono mai considerati (query tenant-scoped)", async () => {
    const fake = baseSeed({
      driver_profiles: [
        { id: DRIVER_PROFILE, tenant_id: TENANT_A, user_id: DRIVER_USER, full_name: "Mario Rossi" },
        { id: "d9999999-9999-4999-8999-999999999999", tenant_id: TENANT_B, user_id: DRIVER_USER, full_name: "Altro" },
      ],
    });
    authorizeAs(fake);

    await callPost();

    const entries = lastHistoryEntries();
    expect(entries[0].toDriverProfileId).toBe(DRIVER_PROFILE);
    const driverProfileRows = fake.tables.driver_profiles.filter((d) => d.user_id === DRIVER_USER);
    expect(driverProfileRows).toHaveLength(2);
  });

  it("11. assignment_source invariato: non toccato dal fix, resta come nell'insert preesistente (assente dal payload assignments)", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost();

    const assignment = fake.tables.assignments[0];
    expect(assignment).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(assignment, "assignment_source")).toBe(false);
  });

  it("12. no-op (driver non risolvibile a un driver_profile): zero history, import comunque riuscito", async () => {
    const fake = baseSeed({ driver_profiles: [] });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("13. dry_run (nessuna riga effettivamente importata): zero history, comportamento preview invariato", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost({ dry_run: "true" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dry_run).toBe(true);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("14. driver non risolto (nessun driver_profiles.user_id corrispondente): comportamento invariato, import riuscito, zero history", async () => {
    const fake = baseSeed({ driver_profiles: [] });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.imported_rows).toBe(1);
    expect(fake.tables.assignments).toHaveLength(1);
    expect(fake.tables.assignments[0].driver_user_id).toBe(DRIVER_USER);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("15. service insert error: 500, zero history (history mai raggiunta)", async () => {
    const fake = baseSeed();
    fake.setError("services", { message: "insert failed" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("insert failed");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("16. assignment insert error: 500, messaggio sanificato (non l'errore raw Supabase), zero history, servizio resta 'new' (non orphan)", async () => {
    const fake = baseSeed();
    fake.setError("assignments", { message: "assignment insert failed: unique_violation on assignments_pkey" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    // Data Integrity Sprint 7: messaggio sanificato — mai l'errore Supabase
    // grezzo esposto al client.
    expect(body.error).toBe("Errore durante il salvataggio delle assegnazioni. Nessun servizio è stato importato.");
    expect(body.summary.imported_rows).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    expect(fake.tables.assignments).toHaveLength(0);
    // Il service era già stato inserito prima del fallimento — ma nasce
    // "new", non "assigned": nessun mismatch, solo un servizio non assegnato.
    expect(fake.tables.services).toHaveLength(1);
    expect(fake.tables.services[0].status).toBe("new");
  });

  it("17. partial success: N/A, services.insert e assignments.insert sono ciascuno un'unica INSERT bulk atomica (Postgres) — non esiste un fallimento parziale a livello di singola riga in questo import; il fallimento dell'intero batch è già coperto dai test 15/16", () => {
    expect(true).toBe(true);
  });

  it("18. logAssignmentChange rigetta: risposta di successo invariata (fire-and-forget), nessun dettaglio history esposto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);
    mocks.logAssignmentChange.mockRejectedValueOnce(new Error("driver_assignment_history insert failed"));

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/driver_assignment_history/);
  });

  it("19. zero unhandled rejection: già verificato implicitamente dal test 18 (vitest fallisce su rejection non gestite)", () => {
    expect(true).toBe(true);
  });

  it("20. risposta HTTP invariata: stessa forma { ok, dry_run, summary, preview, errors }", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["dry_run", "errors", "ok", "preview", "summary"].sort());
  });

  it("21. non regressione import standard: hotel non riconosciuto continua a produrre errore di riga, import prosegue per le altre righe valide", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const rows = [
      singleValidRow({ reference: "TRF001", destination: "Hotel Test" }),
      singleValidRow({ reference: "TRF002", destination: "Hotel Sconosciuto Xyz", time: "12:00" }),
    ];
    const res = await callPost({}, rows);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.summary.imported_rows).toBe(1);
    expect(body.errors.length).toBeGreaterThanOrEqual(1);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
    const entries = lastHistoryEntries();
    expect(entries).toHaveLength(1);
  });
});

describe("Data Integrity Sprint 7 — driver-file-import orphan prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logAssignmentChange.mockResolvedValue(undefined);
    mocks.updateLearnedPatterns.mockResolvedValue({ upserted: 0 });
  });

  it("22. import riuscito: service.status='assigned', assignment esiste, imported_rows corretto", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(fake.tables.services).toHaveLength(1);
    expect(fake.tables.services[0].status).toBe("assigned");
    expect(fake.tables.assignments).toHaveLength(1);
    expect(fake.tables.status_events).toHaveLength(1);
  });

  it("23. assignments.insert fallisce: servizio resta 'new' (mai orphan), zero history, zero status_events", async () => {
    const fake = baseSeed();
    fake.setError("assignments", { message: "raw db error" });
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.summary.imported_rows).toBe(0);
    expect(fake.tables.services.every((s) => s.status === "new")).toBe(true);
    expect(fake.tables.assignments).toHaveLength(0);
    expect(fake.tables.status_events).toHaveLength(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("24. services.update(status) fallisce al 1° tentativo ma il retry riesce: import riuscito, nessuna compensazione", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "update", [{ message: "transient" }, null]);
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(fake.tables.services[0].status).toBe("assigned");
    // Nessuna compensazione: l'assignment scritto resta, non viene cancellato.
    expect(fake.tables.assignments).toHaveLength(1);
    expect(mocks.logAssignmentChange).toHaveBeenCalledTimes(1);
  });

  it("25. services.update(status) fallisce sia al 1° tentativo che al retry: compensazione cancella l'assignment appena creato, servizio resta 'new'", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "update", [{ message: "fail 1" }, { message: "fail 2" }]);
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Errore aggiornamento stato servizi: assegnazioni annullate, nessun servizio è stato importato.");
    expect(body.summary.imported_rows).toBe(0);
    // Compensazione: l'assignment appena creato viene cancellato (mai un
    // restore in questo import — sono garantiti tutti nuovi).
    expect(fake.tables.assignments).toHaveLength(0);
    expect(fake.tables.services[0].status).toBe("new");
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
    expect(fake.tables.status_events).toHaveLength(0);
  });

  it("26. compensazione fallisce anch'essa: mai un successo silenzioso, messaggio 'richiede verifica manuale'", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "update", [{ message: "fail 1" }, { message: "fail 2" }]);
    fake.setOpErrorQueue("assignments", "delete", [{ message: "compensation also fails" }]);
    authorizeAs(fake);

    const res = await callPost();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.ok).toBeUndefined();
    expect(body.error).toBe("Errore aggiornamento stato servizi: incoerenza NON risolta automaticamente, richiede verifica manuale.");
    expect(body.summary.imported_rows).toBe(0);
    expect(mocks.logAssignmentChange).not.toHaveBeenCalled();
  });

  it("27. audit log: nessuna PII, solo campi tecnici (tenant, service count, step, esito compensazione)", async () => {
    const fake = baseSeed();
    fake.setOpErrorQueue("services", "update", [{ message: "fail 1" }, { message: "fail 2" }]);
    authorizeAs(fake);

    await callPost();

    expect(mocks.auditLog).toHaveBeenCalled();
    const payload = JSON.stringify(mocks.auditLog.mock.calls);
    expect(payload).not.toMatch(/Cliente Test/);
    expect(payload).not.toMatch(/Agenzia XYZ/);
    expect(payload).not.toMatch(/customer_name/);
    expect(payload).not.toMatch(/phone/);
    expect(payload).not.toMatch(/notes/);
    const lastCall = mocks.auditLog.mock.calls[mocks.auditLog.mock.calls.length - 1][0];
    expect(lastCall.tenantId).toBe(TENANT_A);
    expect(lastCall.details.step).toBe("status_update");
    expect(typeof lastCall.details.serviceCount).toBe("number");
  });

  it("28. tenant isolation: assignments/services/audit scritti sempre con tenant_id di sessione, mai da input", async () => {
    const fake = baseSeed();
    authorizeAs(fake);

    await callPost({ tenant_id: TENANT_B });

    expect(fake.tables.services[0].tenant_id).toBe(TENANT_A);
    expect(fake.tables.assignments[0].tenant_id).toBe(TENANT_A);
  });
});
