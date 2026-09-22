import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Chiude il gap di concorrenza residuo sulla dedupe dell'import Excel
 * LEGACY (app/api/excel/import/route.ts): il lookup applicativo pre-insert
 * (tests/unit/excel-import-legacy-dedupe.test.ts) non e' concurrency-safe —
 * due upload identici avviati nello stesso momento possono entrambi superare
 * il lookup prima che l'altro abbia scritto.
 *
 * Fix: migration 0285, colonna `services.legacy_import_fingerprint`
 * (scritta SOLO da questa route con l'output letterale di
 * buildImportFingerprint) + unique index parziale
 * uq_services_legacy_import_fingerprint (tenant_id, legacy_import_fingerprint)
 * WHERE legacy_import_fingerprint IS NOT NULL AND status <> 'cancelled'.
 *
 * Il fake admin qui sotto estende il pattern gia' usato in
 * excel-import-legacy-dedupe.test.ts e nei test 0284: il check di conflitto
 * sull'unique index e la scrittura avvengono nello stesso tick sincrono
 * dentro `finishInsert` (nessun `await` di mezzo), cosi' anche due richieste
 * lanciate con Promise.all non possono mai vedere entrambe "nessun
 * conflitto" — stesso principio dell'indice reale sotto concorrenza.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/excel/import/route";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const HOTEL_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

type Row = Record<string, unknown>;

/** Fake Supabase in-memory che modella uq_services_legacy_import_fingerprint (migration 0285). */
function makeAdmin(seed: Record<string, Row[]> = {}) {
  let idCounter = 0;
  const nextId = (table: string) => `gen-${table}-${++idCounter}`;
  const insertCallCounts: Record<string, number> = {};

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const finishInsert = (): { rows: Row[]; error: { code: string; message: string } | null } => {
      const rows = Array.isArray(payload) ? payload : [payload as Row];
      if (table === "services") {
        for (const r of rows) {
          const fp = r.legacy_import_fingerprint;
          if (fp !== undefined && fp !== null) {
            const conflict = (seed.services ?? []).some(
              (existing) =>
                existing.tenant_id === r.tenant_id &&
                existing.legacy_import_fingerprint === fp &&
                existing.status !== "cancelled",
            );
            if (conflict) {
              return {
                rows: [],
                error: { code: "23505", message: 'duplicate key value violates unique constraint "uq_services_legacy_import_fingerprint"' },
              };
            }
          }
        }
      }
      insertCallCounts[table] = (insertCallCounts[table] ?? 0) + 1;
      const withIds = rows.map((r) => ({ id: nextId(table), ...r }));
      seed[table] = [...(seed[table] ?? []), ...withIds];
      return { rows: withIds, error: null };
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
      if (mode === "insert") { const { rows, error } = finishInsert(); return { data: error ? null : rows[0] ?? null, error }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.maybeSingle = async () => {
      if (mode === "insert") { const { rows, error } = finishInsert(); return { data: error ? null : rows[0] ?? null, error }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: unknown };
      if (mode === "insert") { const { rows, error } = finishInsert(); result = { data: error ? null : rows, error }; }
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
      { id: HOTEL_B, tenant_id: TENANT_A, name: "Hotel Altro", normalized_name: "hotel altro", zone: "Ischia Porto" },
    ],
    hotel_aliases: [],
    ferry_pickup_rules: [],
    ferry_schedules: [],
    places: [],
    services: [],
    status_events: [],
    service_audit_events: [],
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

describe("Migration 0285 — dedupe import Excel legacy concurrency-safe a livello DB", () => {
  it("1. stesso file caricato due volte in sequenza -> seconda volta tutto skipped", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await post(importPayload([importRow()]));
    expect(seed.services).toHaveLength(1);
    expect(seed.services[0]?.legacy_import_fingerprint).toBeTruthy();

    const res2 = await post(importPayload([importRow()]));
    const body2 = await res2.json();

    expect(body2.ok).toBe(true);
    expect(body2.summary.imported_rows).toBe(0);
    expect(body2.summary.duplicate_rows).toBe(1);
    expect(seed.services).toHaveLength(1);
  });

  it("2. due upload identici simultanei -> una sola copia persistita", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const [res1, res2] = await Promise.all([
      post(importPayload([importRow()])),
      post(importPayload([importRow()])),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    expect(res1.status).not.toBe(500);
    expect(res2.status).not.toBe(500);
    const imported = [body1, body2].filter((b) => b.summary?.imported_rows === 1);
    const skipped = [body1, body2].filter((b) => b.summary?.duplicate_rows === 1);
    expect(imported).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(seed.services).toHaveLength(1);
  });

  it("3. due upload misti simultanei -> duplicato saltato una sola volta, righe nuove entrambe importate", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const [res1, res2] = await Promise.all([
      post(importPayload([
        importRow({ row_index: 1 }),
        importRow({ row_index: 2, customer_name: "Cliente Solo Batch 1", phone: "3330000001" }),
      ])),
      post(importPayload([
        importRow({ row_index: 1 }), // stesso fingerprint del batch 1
        importRow({ row_index: 2, customer_name: "Cliente Solo Batch 2", phone: "3330000002" }),
      ])),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    expect(res1.status).not.toBe(500);
    expect(res2.status).not.toBe(500);

    const totalImported = (body1.summary?.imported_rows ?? 0) + (body2.summary?.imported_rows ?? 0);
    const totalDuplicates = (body1.summary?.duplicate_rows ?? 0) + (body2.summary?.duplicate_rows ?? 0);
    // 3 righe realmente distinte (Mario Rossi una sola volta + i 2 clienti "solo batch"), 1 duplicato tra i due batch.
    expect(totalImported).toBe(3);
    expect(totalDuplicates).toBe(1);
    expect(seed.services).toHaveLength(3);
    expect(seed.services.some((s) => s.customer_name === "Cliente Solo Batch 1")).toBe(true);
    expect(seed.services.some((s) => s.customer_name === "Cliente Solo Batch 2")).toBe(true);
    expect(seed.services.filter((s) => s.customer_name === "Mario Rossi")).toHaveLength(1);
  });

  it("4. stesso cliente/data ma orario diverso -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, time: "10:00" }),
      importRow({ row_index: 2, time: "18:30" }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("5. stesso tutto ma direzione diversa -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, direction: "arrival" }),
      importRow({ row_index: 2, direction: "departure" }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("6. stesso tutto ma hotel diverso -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, destination: "Hotel Test" }),
      importRow({ row_index: 2, destination: "Hotel Altro" }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("7. stesso tutto ma pax diverso -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, pax: 2 }),
      importRow({ row_index: 2, pax: 4 }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("8. stesso tutto ma transport_code diverso -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, transport_code: "SNAV123" }),
      importRow({ row_index: 2, transport_code: "MEDMAR456" }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("9. stesso tutto ma billing_party_name diverso -> allowed", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));
    const res = await post(importPayload([
      importRow({ row_index: 1, billing_party_name: "Agenzia Test" }),
      importRow({ row_index: 2, billing_party_name: "Agenzia Altra" }),
    ]));
    const body = await res.json();
    expect(body.summary.imported_rows).toBe(2);
    expect(seed.services).toHaveLength(2);
  });

  it("10. stesso fingerprint ma tenant diverso -> allowed", async () => {
    const seed = baseSeed({
      hotels: [
        { id: HOTEL_A, tenant_id: TENANT_A, name: "Hotel Test", normalized_name: "hotel test", zone: "Ischia Porto" },
        { id: HOTEL_A, tenant_id: TENANT_B, name: "Hotel Test", normalized_name: "hotel test", zone: "Ischia Porto" },
      ],
    });
    const { admin: adminA } = makeAdmin(seed);
    const { admin: adminB } = makeAdmin(seed);

    mocks.authorizePricingRequest.mockResolvedValueOnce(authCtx(adminA, TENANT_A));
    await post(importPayload([importRow()]));

    mocks.authorizePricingRequest.mockResolvedValueOnce(authCtx(adminB, TENANT_B));
    const resB = await post(importPayload([importRow()]));
    const bodyB = await resB.json();

    expect(bodyB.summary.imported_rows).toBe(1);
    expect(seed.services.filter((s) => s.tenant_id === TENANT_A)).toHaveLength(1);
    expect(seed.services.filter((s) => s.tenant_id === TENANT_B)).toHaveLength(1);
  });

  it("11. servizio cancellato con stesso fingerprint -> nuovo import deve poter passare (coerente con la logica legacy attuale)", async () => {
    const seed = baseSeed({
      services: [{
        id: "svc-cancelled-1",
        tenant_id: TENANT_A,
        date: "2026-09-20",
        time: "10:00:00",
        direction: "arrival",
        hotel_id: HOTEL_A,
        customer_name: "Mario Rossi",
        pax: 2,
        transport_code: "SNAV123",
        billing_party_name: "Agenzia Test",
        status: "cancelled",
        legacy_import_fingerprint: "2026-09-20|10:00|arrival|" + HOTEL_A + "|mario rossi|2|snav123|agenzia test",
      }],
    });
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([importRow()]));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.summary.imported_rows).toBe(1);
    expect(body.summary.duplicate_rows).toBe(0);
    expect(seed.services.filter((s) => s.status !== "cancelled")).toHaveLength(1);
  });

  it("12. normalizzazione (spazi extra, maiuscole/minuscole, testo equivalente) -> stesso fingerprint, trattato come duplicato", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await post(importPayload([
      importRow({ row_index: 1, customer_name: "Mario Rossi", transport_code: "SNAV123", billing_party_name: "Agenzia Test" }),
      importRow({ row_index: 2, customer_name: "  MARIO   ROSSI  ", transport_code: "  SNAV123  ", billing_party_name: "AGENZIA   TEST" }),
    ]));
    const body = await res.json();

    expect(body.summary.imported_rows).toBe(1);
    expect(body.summary.duplicate_rows).toBe(1);
    expect(seed.services).toHaveLength(1);
  });

  it("13. conflitto DB concorrente -> skipped/duplicate, mai 500", async () => {
    const { admin } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const [res1, res2] = await Promise.all([
      post(importPayload([importRow()])),
      post(importPayload([importRow()])),
    ]);

    expect(res1.status).not.toBe(500);
    expect(res2.status).not.toBe(500);
    expect([res1.status, res2.status].every((s) => s === 200)).toBe(true);
  });

  it("14. nessun audit per riga duplicata/conflittuale non inserita", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await Promise.all([
      post(importPayload([importRow()])),
      post(importPayload([importRow()])),
    ]);

    // Un solo service persistito -> un solo audit event, mai uno per il conflitto.
    expect(seed.services).toHaveLength(1);
    expect((seed.service_audit_events ?? []).length).toBe(1);
    expect((seed.service_audit_events ?? [])[0]?.service_id).toBe(seed.services[0]?.id);
  });

  it("15. nessuna scrittura parziale incoerente nel batch misto concorrente", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const [res1, res2] = await Promise.all([
      post(importPayload([
        importRow({ row_index: 1 }),
        importRow({ row_index: 2, customer_name: "Unico Batch 1", phone: "3330000011" }),
      ])),
      post(importPayload([
        importRow({ row_index: 1 }),
        importRow({ row_index: 2, customer_name: "Unico Batch 2", phone: "3330000022" }),
      ])),
    ]);
    const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

    // Ogni riga importata ha esattamente un service + un status_event + un audit event: nessuna scrittura orfana/parziale.
    expect(seed.services).toHaveLength(3);
    expect(seed.status_events.length).toBe(3);
    expect((seed.service_audit_events ?? []).length).toBe(3);
    const totalImported = (body1.summary?.imported_rows ?? 0) + (body2.summary?.imported_rows ?? 0);
    expect(totalImported).toBe(3);
  });
});
