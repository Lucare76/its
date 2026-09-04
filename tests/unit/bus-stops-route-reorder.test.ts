import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * PROMPT "Fermate bus" — Fase B: verifica le action POST
 * "reorder_bus_line_stops", "normalize_bus_line_stop_order" e
 * "create_bus_line_stop" su app/api/ops/bus-network/route.ts, con lo stesso
 * harness (POST reale + authorizePricingRequest mockato) già usato in
 * tests/unit/bus-network-bulk-allocate.test.ts. "create_bus_line_stop" è
 * qui perché è l'action che ora usa anche il flusso pending/import (Fase
 * B/5, vedi confirmApprovePendingWithNewStop in
 * app/(app)/bus-network/page.tsx) — provando qui l'anti-duplicato end-to-end
 * a livello route, non solo a livello helper.
 */

const mocks = vi.hoisted(() => ({ authorizePricingRequest: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorizePricingRequest }));

import { POST } from "@/app/api/ops/bus-network/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999";
const LINE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_LINE_ID = "22222222-2222-4222-8222-222222222299";
const STOP_A = "44444444-4444-4444-8444-444444444401";
const STOP_B = "44444444-4444-4444-8444-444444444402";
const STOP_C = "44444444-4444-4444-8444-444444444403";
const STOP_OTHER_LINE = "44444444-4444-4444-8444-444444444404";
const STOP_OTHER_TENANT = "44444444-4444-4444-8444-444444444405";

type Row = Record<string, unknown>;

function makeAdmin(seed: Record<string, Row[]>) {
  const rpcCalls: Array<{ name: string; params: Row }> = [];
  const state = seed;

  function builder(table: string) {
    let rows = [...(state[table] ?? [])];
    let mode: "select" | "insert" | "update" = "select";
    let insertPayload: Row | Row[] | null = null;
    let updatePayload: Row | null = null;
    let orderCol: string | null = null;

    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = (col: string) => { orderCol = col; return b; };
    b.limit = () => b;
    b.in = () => b;
    b.or = () => b;
    b.eq = (col: string, val: unknown) => { rows = rows.filter((r) => r[col] === val); return b; };
    b.neq = (col: string, val: unknown) => { rows = rows.filter((r) => r[col] !== val); return b; };
    b.ilike = (col: string, val: unknown) => {
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === String(val).toLowerCase());
      return b;
    };
    b.insert = (payload: Row | Row[]) => { mode = "insert"; insertPayload = payload; return b; };
    b.update = (payload: Row) => { mode = "update"; updatePayload = payload; return b; };

    function materialize() {
      if (orderCol) rows = [...rows].sort((a, b2) => ((a[orderCol as string] as number) ?? 0) - ((b2[orderCol as string] as number) ?? 0));
      return rows;
    }

    b.maybeSingle = async () => {
      if (mode === "insert") return finishInsertSingle();
      return { data: materialize()[0] ?? null, error: null };
    };
    b.single = async () => {
      if (mode === "insert") return finishInsertSingle();
      if (mode === "update") return finishUpdate();
      return { data: materialize()[0] ?? null, error: null };
    };
    function finishInsertSingle() {
      const items = (Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row]).map((r, i) => ({
        id: `generated-${table}-${state[table]?.length ?? 0}-${i}`,
        tenant_id: TENANT,
        ...r,
      }));
      state[table] = [...(state[table] ?? []), ...items];
      return { data: items[0], error: null };
    }
    function finishUpdate() {
      const targets = materialize();
      state[table] = (state[table] ?? []).map((r) => (targets.some((t) => t.id === r.id) ? { ...r, ...updatePayload } : r));
      return { data: targets[0] ? { ...targets[0], ...updatePayload } : null, error: null };
    }
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      if (mode === "update") {
        const targets = materialize();
        state[table] = (state[table] ?? []).map((r) => (targets.some((t) => t.id === r.id) ? { ...r, ...updatePayload } : r));
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      }
      return Promise.resolve({ data: materialize(), error: null }).then(resolve, reject);
    };
    return b;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      rpcCalls.push({ name, params });
      if (name === "reorder_bus_line_stops") {
        const ids = params.p_stop_ids as string[];
        const scoped = (state.tenant_bus_line_stops ?? []).filter(
          (r) => r.tenant_id === params.p_tenant_id && r.bus_line_id === params.p_bus_line_id && r.direction === params.p_direction
        );
        const matched = ids.every((id) => scoped.some((r) => r.id === id));
        if (!matched || scoped.length !== ids.length) {
          return { data: null, error: { message: "Una o piu fermate non appartengono alla linea/direzione selezionata." } };
        }
        state.tenant_bus_line_stops = (state.tenant_bus_line_stops ?? []).map((r) => {
          const idx = ids.indexOf(r.id as string);
          return idx === -1 ? r : { ...r, stop_order: idx + 1 };
        });
        return { data: null, error: null };
      }
      return { data: null, error: { message: `RPC ${name} non gestita nel fake test` } };
    },
  };
  return { admin, rpcCalls, state };
}

function authCtx(admin: unknown, role = "operator", tenantId = TENANT) {
  return { admin, user: { id: "u1", email: "op@test.it" }, membership: { tenant_id: tenantId, role, suspended: false } };
}

function post(body: unknown) {
  return new NextRequest("http://localhost/api/ops/bus-network", { method: "POST", body: JSON.stringify(body) });
}

function baseStops(): Row[] {
  return [
    { id: STOP_A, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "AAA", city: "Aaa", stop_order: 3, active: true, is_manual: true },
    { id: STOP_B, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "BBB", city: "Bbb", stop_order: 1, active: true, is_manual: true },
    { id: STOP_C, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "CCC", city: "Ccc", stop_order: 2, active: true, is_manual: true },
    { id: STOP_OTHER_LINE, tenant_id: TENANT, bus_line_id: OTHER_LINE_ID, direction: "departure", stop_name: "DDD", city: "Ddd", stop_order: 1, active: true, is_manual: true },
    { id: STOP_OTHER_TENANT, tenant_id: OTHER_TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "EEE", city: "Eee", stop_order: 1, active: true, is_manual: true },
  ];
}

beforeEach(() => { vi.clearAllMocks(); });

describe("POST reorder_bus_line_stops — Fase B/1/2", () => {
  it("1. reorder valido stesso line+direction: persiste 1..N nell'ordine ricevuto e restituisce le fermate aggiornate", async () => {
    const { admin, rpcCalls } = makeAdmin({ tenant_bus_line_stops: baseStops(), tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "reorder_bus_line_stops",
      bus_line_id: LINE_ID, direction: "departure",
      ordered_stop_ids: [STOP_C, STOP_A, STOP_B],
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].params).toEqual({
      p_tenant_id: TENANT, p_bus_line_id: LINE_ID, p_direction: "departure",
      p_stop_ids: [STOP_C, STOP_A, STOP_B],
    });
    const byId = new Map((json.stops as Array<{ id: string; stop_order: number }>).map((s) => [s.id, s.stop_order]));
    expect(byId.get(STOP_C)).toBe(1);
    expect(byId.get(STOP_A)).toBe(2);
    expect(byId.get(STOP_B)).toBe(3);
  });

  it("2/5. un id di un'ALTRA linea nell'elenco -> la RPC rifiuta, azione 400, nessuna scrittura mascherata da successo", async () => {
    const { admin, rpcCalls } = makeAdmin({ tenant_bus_line_stops: baseStops(), tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "reorder_bus_line_stops",
      bus_line_id: LINE_ID, direction: "departure",
      ordered_stop_ids: [STOP_A, STOP_B, STOP_OTHER_LINE],
    }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(rpcCalls).toHaveLength(1); // la guardia JS (dup/empty) non la intercetta: la RPC la respinge lato SQL
  });

  it("5b. un id di un ALTRO TENANT nell'elenco -> respinto (mai un id estraneo)", async () => {
    const { admin } = makeAdmin({ tenant_bus_line_stops: baseStops(), tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "reorder_bus_line_stops",
      bus_line_id: LINE_ID, direction: "departure",
      ordered_stop_ids: [STOP_A, STOP_OTHER_TENANT],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("3. un id di un'altra DIREZIONE (stesso id fisico non esiste su arrival) -> respinto allo stesso modo", async () => {
    const ARRIVAL_STOP = "66666666-6666-4666-8666-666666666601";
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [
        ...baseStops(),
        { id: ARRIVAL_STOP, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "arrival", stop_name: "FFF", city: "Fff", stop_order: 1, active: true },
      ],
      tenant_bus_allocations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "reorder_bus_line_stops",
      bus_line_id: LINE_ID, direction: "departure",
      ordered_stop_ids: [STOP_A, ARRIVAL_STOP],
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  it("4. ordered_stop_ids con id duplicati -> errore 400 PRIMA di chiamare la RPC", async () => {
    const { admin, rpcCalls } = makeAdmin({ tenant_bus_line_stops: baseStops(), tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "reorder_bus_line_stops",
      bus_line_id: LINE_ID, direction: "departure",
      ordered_stop_ids: [STOP_A, STOP_B, STOP_A],
    }));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.ok).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("elenco vuoto -> rifiutato dallo schema zod .min(1) (stesso comportamento delle altre action di questa route su input non valido)", async () => {
    const { admin } = makeAdmin({ tenant_bus_line_stops: baseStops(), tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "reorder_bus_line_stops", bus_line_id: LINE_ID, direction: "departure", ordered_stop_ids: [] }));
    expect(res.status).not.toBe(200);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("POST normalize_bus_line_stop_order — Fase B/3", () => {
  it("riscrive 1..N le fermate attive del gruppo linea+direzione, senza toccare le altre linee", async () => {
    const { admin } = makeAdmin({
      tenant_bus_line_stops: [
        { id: STOP_A, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "AAA", city: "Aaa", stop_order: 9, active: true },
        { id: STOP_B, tenant_id: TENANT, bus_line_id: LINE_ID, direction: "departure", stop_name: "BBB", city: "Bbb", stop_order: 9, active: true },
        { id: STOP_OTHER_LINE, tenant_id: TENANT, bus_line_id: OTHER_LINE_ID, direction: "departure", stop_name: "DDD", city: "Ddd", stop_order: 9, active: true },
      ],
      tenant_bus_allocations: [],
    });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({ action: "normalize_bus_line_stop_order", bus_line_id: LINE_ID, direction: "departure" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const byId = new Map((json.stops as Array<{ id: string; stop_order: number }>).map((s) => [s.id, s.stop_order]));
    expect(new Set([byId.get(STOP_A), byId.get(STOP_B)])).toEqual(new Set([1, 2]));
    expect(byId.get(STOP_OTHER_LINE)).toBe(9); // altra linea: mai toccata
  });
});

describe("POST create_bus_line_stop — Fase B/5 (usata anche dal flusso pending/import)", () => {
  it("10/11. crea la fermata per la sola direzione richiesta (mai la gemella sull'altra direzione)", async () => {
    const { admin, state } = makeAdmin({ tenant_bus_line_stops: [], tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const res = await POST(post({
      action: "create_bus_line_stop",
      bus_line_id: LINE_ID, direction: "arrival",
      stop_name: "ROMA CENTRO", city: "Roma",
    }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.stop.direction).toBe("arrival");

    const rows = state.tenant_bus_line_stops;
    expect(rows.filter((r) => r.bus_line_id === LINE_ID)).toHaveLength(1); // nessuna riga "departure" gemella creata
  });

  it("13. stessa fermata creata due volte (stesso scenario: pending risolto due volte, o import dopo pending) -> seconda chiamata bloccata come duplicato, nessuna riga doppia", async () => {
    const { admin, state } = makeAdmin({ tenant_bus_line_stops: [], tenant_bus_allocations: [] });
    mocks.authorizePricingRequest.mockResolvedValue(authCtx(admin));

    const first = await POST(post({
      action: "create_bus_line_stop",
      bus_line_id: LINE_ID, direction: "departure",
      stop_name: "TERNI", city: "Terni",
    }));
    expect((await first.json()).ok).toBe(true);

    const second = await POST(post({
      action: "create_bus_line_stop",
      bus_line_id: LINE_ID, direction: "departure",
      stop_name: "terni", city: "Terni",
    }));
    const secondJson = await second.json();
    expect(second.status).toBe(409);
    expect(secondJson.ok).toBe(false);
    expect(secondJson.existing_stop_id).toBeDefined();

    const rows = state.tenant_bus_line_stops;
    expect(rows.filter((r) => r.bus_line_id === LINE_ID && r.direction === "departure")).toHaveLength(1);
  });
});
