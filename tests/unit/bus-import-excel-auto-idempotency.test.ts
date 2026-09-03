import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { vi } from "vitest";

/**
 * Regressione "solo 4 pax Terni" (audit DB 2026-09-06) sull'azione
 * import_excel_auto in app/api/ops/bus-network/route.ts.
 *
 * ROOT CAUSE confermata dall'audit: il bus preferito per la fermata TERNI
 * aveva solo 4 posti residui su 18 pax richiesti. La vecchia logica
 * sceglieva UN bus per l'INTERO gruppo (groupPax=18) e poi allocava ogni
 * riga sullo stesso bus una a una: le prime righe che entravano nei 4 posti
 * residui riuscivano, le altre fallivano sulla RPC ("Capienza bus superata")
 * e finivano in pending SENZA che l'operatore vedesse un conteggio chiaro —
 * e `if (existing?.allocated) continue;` scartava i duplicati già allocati
 * senza contarli da nessuna parte.
 *
 * Questo test verifica il fix: ogni riga sceglie il proprio bus (preferendo
 * sempre la stessa fermata quando c'è posto, come da regola esistente), così
 * un gruppo che non entra in un solo bus si distribuisce su più bus invece
 * di essere scartato, e ogni riga finisce in uno stato esplicito
 * (imported/reused_existing/duplicate/pending/error) la cui somma è sempre
 * uguale al numero di righe ricevute.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));
vi.mock("@/lib/server/bus-network-loader", () => ({ loadBusNetwork: vi.fn(async () => ({})) }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const LINE_ID = "75523299-187a-4775-a1d1-2402d7e11e15";
const TERNI_STOP_ID = "e49a8739-d6ab-4f27-9837-9de0cbdb7872";
const BUS_1 = "bus-centro-1"; // stesso bus già usato per Terni, solo 4 posti residui
const BUS_2 = "bus-centro-2"; // bus vuoto della stessa linea
const SVC_PRE = "svc-pre-existing-terni";
const DATE = "2026-09-06";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  let idCounter = 0;
  const nextId = (table: string) => `gen-${table}-${++idCounter}`;

  function builder(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: Row | Row[] | null = null;

    const rowsForFilters = () => (seed[table] ?? []).filter((r) => filters.every((f) => f(r)));

    const finishInsert = () => {
      const rows = Array.isArray(payload) ? payload : [payload as Row];
      const withIds = rows.map((r) => ({ id: nextId(table), ...r }));
      seed[table] = [...(seed[table] ?? []), ...withIds];
      return withIds;
    };
    const finishUpdate = () => {
      const matched = rowsForFilters();
      const ids = new Set(matched.map((r) => r.id));
      seed[table] = (seed[table] ?? []).map((r) => (ids.has(r.id) ? { ...r, ...(payload as Row) } : r));
      return matched.map((r) => ({ ...r, ...(payload as Row) }));
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
    b.not = () => b;
    b.eq = (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; };
    b.is = (col: string, val: null) => { filters.push((r) => (r[col] ?? null) === val); return b; };
    b.ilike = (col: string, val: string) => {
      const needle = String(val).trim().toLowerCase();
      filters.push((r) => String(r[col] ?? "").trim().toLowerCase() === needle);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; };
    b.insert = (p: Row | Row[]) => { mode = "insert"; payload = p; return b; };
    b.update = (p: Row) => { mode = "update"; payload = p; return b; };
    b.delete = () => { mode = "delete"; return b; };
    b.maybeSingle = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      if (mode === "update") { const rows = finishUpdate(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.single = async () => {
      if (mode === "insert") { const rows = finishInsert(); return { data: rows[0] ?? null, error: null }; }
      if (mode === "update") { const rows = finishUpdate(); return { data: rows[0] ?? null, error: null }; }
      return { data: rowsForFilters()[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: null };
      if (mode === "insert") result = { data: finishInsert(), error: null };
      else if (mode === "update") result = { data: finishUpdate(), error: null };
      else if (mode === "delete") result = { data: finishDelete(), error: null };
      else result = { data: rowsForFilters(), error: null };
      return Promise.resolve(result).then(resolve, reject);
    };
    return b;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      if (name !== "allocate_bus_service") return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
      const unit = (seed.tenant_bus_units ?? []).find((u) => u.id === params.p_bus_unit_id);
      if (!unit) return { data: null, error: { message: "Bus non trovato." } };
      const already = (seed.tenant_bus_allocations ?? []).some((a) => a.service_id === params.p_service_id);
      if (already) return { data: null, error: { message: "Il servizio e' gia allocato a un bus." } };
      const svc = (seed.services ?? []).find((s) => s.id === params.p_service_id);
      const existingPax = (seed.tenant_bus_allocations ?? [])
        .filter((a) => a.bus_unit_id === params.p_bus_unit_id)
        .reduce((sum, a) => {
          const s = (seed.services ?? []).find((x) => x.id === a.service_id);
          return s && svc && s.date === svc.date ? sum + Number(a.pax_assigned) : sum;
        }, 0);
      const capacity = Number(unit.capacity);
      const paxAssigned = Number(params.p_pax_assigned);
      if (existingPax + paxAssigned > capacity) {
        return { data: null, error: { message: "Capienza bus superata per questa data." } };
      }
      const allocId = nextId("tenant_bus_allocations");
      seed.tenant_bus_allocations = [...(seed.tenant_bus_allocations ?? []), {
        id: allocId, tenant_id: params.p_tenant_id, service_id: params.p_service_id,
        bus_line_id: params.p_bus_line_id, bus_unit_id: params.p_bus_unit_id,
        stop_id: params.p_stop_id, stop_name: params.p_stop_name, pax_assigned: paxAssigned,
      }];
      return { data: { allocation_id: allocId }, error: null };
    },
  };
  return { admin, seed };
}

function authCtx(admin: unknown, role = "operator") {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: TENANT, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

function baseSeed(overrides: Partial<Record<string, Row[]>> = {}): Record<string, Row[]> {
  return {
    tenant_bus_line_stops: [
      { id: TERNI_STOP_ID, tenant_id: TENANT, bus_line_id: LINE_ID, stop_name: "TERNI", city: "TERNI", direction: "departure", stop_order: 5, pickup_note: "Terminal Bus Atc", active: true },
    ],
    tenant_bus_units: [
      { id: BUS_1, tenant_id: TENANT, bus_line_id: LINE_ID, label: "centro 1", capacity: 10, status: "open", sort_order: 1 },
      { id: BUS_2, tenant_id: TENANT, bus_line_id: LINE_ID, label: "CENTRO 2", capacity: 54, status: "open", sort_order: 2 },
    ],
    tenant_bus_lines: [{ id: LINE_ID, tenant_id: TENANT, family_code: "CENTRO" }],
    hotels: [],
    hotel_pickup_times: [],
    services: [
      // Prenotazione pre-esistente (non di Mario) già allocata su BUS_1 alla
      // fermata Terni: 6 pax su 10 di capienza -> restano solo 4 posti,
      // esattamente come nell'incidente reale (50/54 -> 4 residui).
      { id: SVC_PRE, tenant_id: TENANT, date: DATE, direction: "departure", pax: 6, customer_name: "Preesistente Terni", bus_city_origin: "TERNI", booking_service_kind: "bus_city_hotel", hotel_id: null },
    ],
    tenant_bus_allocations: [
      { id: "alloc-pre", tenant_id: TENANT, service_id: SVC_PRE, bus_line_id: LINE_ID, bus_unit_id: BUS_1, stop_id: TERNI_STOP_ID, stop_name: "TERNI", pax_assigned: 6 },
    ],
    bus_import_pending: [],
    ...overrides,
  };
}

// Le 8 righe Terni reali: 2+3+2+3+2+2+2+2 = 18 pax (audit 2026-09-06).
const TERNI_ROWS = [
  { name: "FRANCA", phone: "3801111111", city: "TERNI", pax: 2, hotel: null, agency: "TIVA" },
  { name: "PALIY", phone: "3803875690", city: "TERNI", pax: 3, hotel: null, agency: "TIVA" },
  { name: "ANGELUZZI", phone: "3802222222", city: "TERNI", pax: 2, hotel: null, agency: "TIVA" },
  { name: "MASSARELLI", phone: "3280548772", city: "TERNI", pax: 3, hotel: null, agency: "TIVA" },
  { name: "BATTISTELLI", phone: "3351341527", city: "TERNI", pax: 2, hotel: null, agency: "TIVA" },
  { name: "SARUBBI MARA", phone: "3406846508", city: "TERNI", pax: 2, hotel: null, agency: "ANGELINO" },
  { name: "MOSCA ANGELO - VIRILI CARLA", phone: null, city: "TERNI", pax: 2, hotel: null, agency: "CAMPANIA OVERLAND" },
  { name: "SILVERI MASSIMO", phone: "3471079617", city: "TERNI", pax: 2, hotel: null, agency: "ZIGOLO" },
];

function importPayload() {
  return { action: "import_excel_auto", direction: "departure", travel_date: DATE, rows: TERNI_ROWS };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("POST import_excel_auto — regressione Terni 2026-09-06 (audit reale)", () => {
  it("primo import: tutte le 8 righe Terni (18 pax) vengono assegnate, distribuite su più bus se un solo bus non basta", async () => {
    const { admin, seed } = makeAdmin(baseSeed());
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post(importPayload()));
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.received_rows).toBe(8);
    expect(body.received_pax).toBe(18);
    expect(body.imported_rows).toBe(8);
    expect(body.imported_pax).toBe(18);
    expect(body.reused_rows).toBe(0);
    expect(body.duplicate_rows).toBe(0);
    expect(body.pending_rows).toBe(0);
    expect(body.error_rows).toBe(0);
    // La somma degli stati è sempre uguale al numero di righe ricevute.
    expect(body.imported_rows + body.reused_rows + body.duplicate_rows + body.pending_rows + body.error_rows).toBe(8);
    expect(body.details).toHaveLength(8);
    expect(body.details.every((d: { status: string }) => d.status === "imported")).toBe(true);

    // Nessuna riga persa: il totale pax allocato su Terni (pre-esistente + le
    // 8 nuove) è 6 + 18 = 24, mai "solo 4 pax" come nel bug originale.
    const terniPax = seed.tenant_bus_allocations
      .filter((a) => a.stop_id === TERNI_STOP_ID)
      .reduce((sum, a) => sum + Number(a.pax_assigned), 0);
    expect(terniPax).toBe(24);

    // Distribuito su entrambi i bus (non scartato perché un solo bus non basta).
    const bus1Pax = seed.tenant_bus_allocations.filter((a) => a.bus_unit_id === BUS_1).reduce((s, a) => s + Number(a.pax_assigned), 0);
    const bus2Pax = seed.tenant_bus_allocations.filter((a) => a.bus_unit_id === BUS_2).reduce((s, a) => s + Number(a.pax_assigned), 0);
    expect(bus1Pax).toBe(10); // pieno (6 pre + 4 nuovi)
    expect(bus2Pax).toBe(14); // resto del gruppo (18 - 4)
    expect(bus1Pax + bus2Pax).toBe(24);
  });

  it("idempotenza: import #2 e #3 dello stesso file non creano nuove allocazioni, restano 8 righe/18 pax 'duplicate'", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post(importPayload())); // import #1

    const servicesAfterFirst = seed.services.length;
    const allocationsAfterFirst = seed.tenant_bus_allocations.length;

    for (const attempt of [2, 3]) {
      const res = await POST(post(importPayload()));
      const body = await res.json();

      expect(body.received_rows, `tentativo #${attempt}`).toBe(8);
      expect(body.received_pax, `tentativo #${attempt}`).toBe(18);
      expect(body.imported_rows, `tentativo #${attempt}`).toBe(0);
      expect(body.reused_rows, `tentativo #${attempt}`).toBe(0);
      expect(body.duplicate_rows, `tentativo #${attempt}`).toBe(8);
      expect(body.duplicate_pax, `tentativo #${attempt}`).toBe(18);
      expect(body.pending_rows, `tentativo #${attempt}`).toBe(0);
      expect(body.error_rows, `tentativo #${attempt}`).toBe(0);
      expect(body.details.every((d: { status: string; service_id: string | null }) => d.status === "duplicate" && d.service_id)).toBe(true);

      // Nessun nuovo service/allocazione: niente 22, 36 o 54 pax fantasma.
      expect(seed.services.length, `tentativo #${attempt}`).toBe(servicesAfterFirst);
      expect(seed.tenant_bus_allocations.length, `tentativo #${attempt}`).toBe(allocationsAfterFirst);

      const terniPax = seed.tenant_bus_allocations
        .filter((a) => a.stop_id === TERNI_STOP_ID)
        .reduce((sum, a) => sum + Number(a.pax_assigned), 0);
      expect(terniPax, `tentativo #${attempt}`).toBe(24); // 6 pre + 18, mai di più
    }
  });

  it("il matching duplicati è insensibile a spazi/maiuscole ma richiede comunque nome+pax+città+hotel coerenti", async () => {
    const seed = baseSeed();
    const { admin } = makeAdmin(seed);
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    await POST(post(importPayload())); // import #1, crea i service con customer_name originale (es. "FRANCA")

    const reimportWithNoise = {
      action: "import_excel_auto",
      direction: "departure",
      travel_date: DATE,
      rows: [{ name: "  franca  ", phone: "3801111111", city: "terni", pax: 2, hotel: null, agency: "TIVA" }],
    };
    const res = await POST(post(reimportWithNoise));
    const body = await res.json();

    expect(body.duplicate_rows).toBe(1);
    expect(body.imported_rows).toBe(0);
    expect(body.details[0].status).toBe("duplicate");
    expect(body.details[0].reason).toMatch(/già presente/i);
  });
});
