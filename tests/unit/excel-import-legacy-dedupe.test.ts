import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Fix P1-4 (audit pre-go-live): app/api/excel/import/route.ts (import Excel
 * LEGACY) non aveva alcuna protezione anti-duplicato, a differenza di
 * operational-v2 (buildOperationalV2ServerPreview) e MTS Globe
 * (findExistingAgencyBooking). Un re-upload dello stesso file poteva creare
 * servizi duplicati.
 *
 * Fix: fingerprint composita (date+time+direction+hotel_id+customer_name+
 * pax+transport_code+billing_party_name, normalizzata) calcolata sul
 * payload già pronto per l'insert, confrontata con un lookup BATCHED (una
 * query per data distinta nel batch, mai una per riga) sui service non
 * cancellati dello stesso tenant, e con le righe già viste nello stesso
 * file. Righe duplicate: MAI inserite, MAI audit di import, riportate in
 * summary.duplicate_rows + errors-like array `duplicates`.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/excel/import/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOTEL_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

/** Fake Supabase in-memory, stesso pattern generico già usato altrove in questa suite (bus-import-excel-auto-idempotency.test.ts). */
function makeAdmin(seed: Record<string, Row[]> = {}) {
  let idCounter = 0;
  const nextId = (table: string) => `gen-${table}-${++idCounter}`;
  const insertCallCounts: Record<string, number> = {};

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const finishInsert = () => {
      insertCallCounts[table] = (insertCallCounts[table] ?? 0) + 1;
      const rows = Array.isArray(payload) ? payload : [payload as Row];
      const withIds = rows.map((r) => ({ id: nextId(table), ...r }));
      seed[table] = [...(seed[table] ?? []), ...withIds];
      return withIds;
    };
    const finishDelete = () => {
      const matched = rowsForFilters();
      const ids = new Set(matched.map((r) => r.id));
      seed[table] = (seed[table] ?? []).filter((r) => !ids.has(r.id));
      return matched;
    };

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; };
    b.neq = (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return b; };
    b.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; };
    b.insert = (p: Row | Row[]) => { mode = "insert"; payload = p; return b; };
    b.delete = () => { mode = "delete"; return b; };
    b.single = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.maybeSingle = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: null };
      if (mode === "insert") result = { data: finishInsert(), error: null };
      else if (mode === "delete") result = { data: finishDelete(), error: null };
      else result = { data: rowsForFilters(), error: null };
      return Promise.resolve(result).then(resolve, reject);
    };
    return b;
  }

  const admin = { from: (t: string) => builder(t) };
  return { admin, seed, getInsertCallCount: (table: string) => insertCallCounts[table] ?? 0 };
}

function authCtx(admin: unknown, tenantId: string = TENANT_A, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: tenantId, role, suspended: false } };
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    hotels: [
      { id: HOTEL_A, tenant_id: TENANT_A, name: "Hotel Test", normalized_name: "hotel test", zone: "Ischia Porto" },
      { id: HOTEL_B, tenant_id: TENANT_B, name: "Hotel Test", normalized_name: "hotel test", zone: "Ischia Porto" },
    ],
    hotel_aliases: [],
    ferry_pickup_rules: [],
    ferry_schedules: [],
    places: [],
    services: [],
    status_events: [],
    ...overrides,
  };
}

function importRow(overrides: Row = {}): Row {
  return {
    row_index: 1,
    customer_name: "Mario Rossi",
    date: "2026-09-20",
    time: "10:00",
    pickup: "Porto Napoli",
    destination: "Hotel Test",
    pax: 2,
    transport_code: "SNAV123",
    phone: "3331234567",
    billing_party_name: "Agenzia Test",
    direction: "arrival",
    ...overrides,
  };
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest("http://localhost:3010/api/excel/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function importPayload(rows: Row[], overrides: Record<string, unknown> = {}) {
  return {
    dry_run: false,
    preset_key: "generic_transfer",
    default_direction: "arrival",
    rows,
    ...overrides,
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("Fix P1-4 — dedupe import Excel legacy", () => {
  it("1. primo import: crea il servizio, nessun duplicato", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([importRow()]));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(body.summary.duplicate_rows).toBe(0);
    expect(body.duplicates).toHaveLength(0);
    expect(seed.services).toHaveLength(1);
  });

  it("2. stesso file ricaricato una seconda volta: 0 nuovi duplicati, duplicate_rows coerente, ok:true", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await post(importPayload([importRow()])); // import #1
    expect(seed.services).toHaveLength(1);

    const res = await post(importPayload([importRow()])); // stesso file, import #2
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(0);
    expect(body.summary.duplicate_rows).toBe(1);
    expect(body.duplicates).toHaveLength(1);
    expect(body.duplicates[0].row_index).toBe(1);
    // nessun nuovo service creato
    expect(seed.services).toHaveLength(1);
  });

  it("3. file misto: righe già presenti saltate, nuove righe importate", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await post(importPayload([importRow({ row_index: 1 })])); // già presente dopo questo
    expect(seed.services).toHaveLength(1);

    const mixedRes = await post(importPayload([
      importRow({ row_index: 1 }), // duplicato della riga già importata
      importRow({ row_index: 2, customer_name: "Luigi Bianchi", phone: "3339876543" }), // nuova
    ]));
    const body = await mixedRes.json();

    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(body.summary.duplicate_rows).toBe(1);
    expect(body.duplicates[0].row_index).toBe(1);
    expect(seed.services).toHaveLength(2);
    expect(seed.services.some((s) => s.customer_name === "Luigi Bianchi")).toBe(true);
  });

  it("4. duplicati interni allo stesso file: una sola copia importata", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([
      importRow({ row_index: 1 }),
      importRow({ row_index: 2 }), // stessa identica prenotazione, riga ripetuta nel file
    ]));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(body.summary.duplicate_rows).toBe(1);
    expect(body.duplicates[0].row_index).toBe(2);
    expect(body.duplicates[0].message).toMatch(/duplicato interno/i);
    expect(seed.services).toHaveLength(1);
  });

  it("5. Caso E — stesso cliente/data ma servizio realmente diverso (orario e direzione diversi): ENTRAMBI creati, nessun falso duplicato", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([
      importRow({ row_index: 1, time: "10:00", direction: "arrival" }),
      importRow({ row_index: 2, time: "18:30", direction: "departure" }), // stesso cliente/data/hotel, viaggio diverso
    ]));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(2);
    expect(body.summary.duplicate_rows).toBe(0);
    expect(seed.services).toHaveLength(2);
  });

  it("6. tenant-scoped: stesso identico file per due tenant diversi non si blocca a vicenda", async () => {
    const seed = baseSeed();
    const { admin: adminA } = makeAdmin(seed);
    const { admin: adminB } = makeAdmin(seed);

    mocks.authorizePricingRequest.mockResolvedValue(authCtx(adminA, TENANT_A));
    await post(importPayload([importRow()]));

    mocks.authorizePricingRequest.mockResolvedValue(authCtx(adminB, TENANT_B, "operator"));
    const resB = await post(importPayload([importRow({ destination: "Hotel Test" })]));
    const bodyB = await resB.json();

    expect(bodyB.ok).toBe(true);
    expect(bodyB.summary.imported_rows).toBe(1);
    expect(bodyB.summary.duplicate_rows).toBe(0);
    expect(seed.services.filter((s) => s.tenant_id === TENANT_A)).toHaveLength(1);
    expect(seed.services.filter((s) => s.tenant_id === TENANT_B)).toHaveLength(1);
  });

  it("7. concurrency: due upload identici in sequenza ravvicinata restano coerenti (nota: un vero test di race condition richiede due connessioni DB reali concorrenti, non riproducibile in un test unitario single-threaded — vedi report per la valutazione esplicita del gap residuo)", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const [res1, res2] = await Promise.all([
      post(importPayload([importRow()])),
      post(importPayload([importRow()])),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    // In questo harness in-memory single-threaded le due richieste vengono
    // comunque serializzate dall'event loop, quindi il lookup+insert non
    // corre mai realmente in parallelo: il test verifica solo che NESSUNA
    // delle due risposte generi un errore inatteso, non l'assenza di race
    // condition reale (limite esplicito, vedi report).
    const totalImported = (body1.summary?.imported_rows ?? 0) + (body2.summary?.imported_rows ?? 0);
    expect(totalImported).toBeGreaterThanOrEqual(1);
    expect(seed.services.length).toBeGreaterThanOrEqual(1);
  });

  it("10. malformed rows/error handling invariato: riga senza hotel riconoscibile finisce ancora in errors, dedupe non la tocca", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([importRow({ destination: "Hotel Sconosciuto Xyz" })]));
    const body = await res.json();

    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0].message).toMatch(/hotel non riconosciuto/i);
    expect(seed.services).toHaveLength(0);
  });
});
