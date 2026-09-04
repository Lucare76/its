import { describe, it, expect, vi } from "vitest";
import {
  normalizeBusStopOrder,
  reorderBusLineStops,
  normalizeBusLineStopOrder,
  createStopForTransfer,
} from "@/lib/server/bus-line-stops";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PROMPT "Fermate bus" — Fase B: reorder reale (drag&drop), normalizzazione
 * stop_order e unificazione create_stop_for_transfer sul core condiviso
 * createBusLineStop (già testato in tests/unit/bus-line-stops.test.ts).
 *
 * La RPC SQL `reorder_bus_line_stops` (supabase/migrations/
 * 0038_bus_booking_centric_reorder_and_audit.sql) è quella che applica
 * DAVVERO i vincoli cross-tenant/cross-linea/cross-direzione e la scrittura
 * atomica 1..N — non eseguibile qui senza un Postgres reale. Questi test
 * verificano lo strato di orchestrazione JS: le guardie applicate PRIMA di
 * chiamare la RPC (lista vuota, id duplicati), che la RPC venga invocata con
 * i parametri esatti attesi, la mappatura degli errori, e il determinismo
 * dell'helper di normalizzazione puro.
 */

const TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const LINE_CENTRO = "line-centro";
const OTHER_LINE = "line-italia";

type Row = Record<string, unknown>;

function makeFakeAdmin(tables: Record<string, Row[]>, opts: { rpcError?: string } = {}) {
  let idCounter = 0;
  const rpcCalls: Array<{ name: string; params: Row }> = [];

  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Row | Row[] | null = null;
    let updatePayload: Row | null = null;
    let orderCol: string | null = null;
    let orderDesc = false;
    let limitN: number | null = null;

    const api: Record<string, (...args: never[]) => unknown> = {};

    api.select = () => api;
    api.eq = (...args: unknown[]) => {
      const [col, val] = args as [string, unknown];
      rows = rows.filter((r) => r[col] === val);
      return api;
    };
    api.neq = (...args: unknown[]) => {
      const [col, val] = args as [string, unknown];
      rows = rows.filter((r) => r[col] !== val);
      return api;
    };
    api.ilike = (...args: unknown[]) => {
      const [col, val] = args as [string, string];
      rows = rows.filter((r) => String(r[col] ?? "").toLowerCase() === String(val).toLowerCase());
      return api;
    };
    api.order = (...args: unknown[]) => {
      const [col, opts2] = args as [string, { ascending?: boolean } | undefined];
      orderCol = col;
      orderDesc = opts2?.ascending === false;
      return api;
    };
    api.limit = (...args: unknown[]) => {
      limitN = args[0] as number;
      return api;
    };
    api.insert = (...args: unknown[]) => {
      mode = "insert";
      insertPayload = args[0] as Row | Row[];
      return api;
    };
    api.update = (...args: unknown[]) => {
      mode = "update";
      updatePayload = args[0] as Row;
      return api;
    };

    function materialize() {
      if (orderCol) {
        rows = [...rows].sort((a, b) => {
          const av = a[orderCol as string] as number;
          const bv = b[orderCol as string] as number;
          return orderDesc ? bv - av : av - bv;
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows;
    }

    api.maybeSingle = async () => ({ data: materialize()[0] ?? null, error: null });
    api.single = async () => {
      if (mode === "insert") {
        const items = (Array.isArray(insertPayload) ? insertPayload : [insertPayload as Row]).map((r) => ({
          id: `generated-${idCounter++}`,
          tenant_id: TENANT,
          ...r,
        }));
        tables[table] = [...(tables[table] ?? []), ...items];
        return { data: items[0], error: null };
      }
      if (mode === "update") {
        const target = materialize()[0];
        if (!target) return { data: null, error: { message: "not found" } };
        const merged = { ...target, ...updatePayload };
        tables[table] = (tables[table] ?? []).map((r) => (r.id === target.id ? merged : r));
        return { data: merged, error: null };
      }
      return { data: materialize()[0] ?? null, error: null };
    };
    api.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "update") {
        const targets = materialize();
        tables[table] = (tables[table] ?? []).map((r) =>
          targets.some((t) => t.id === r.id) ? { ...r, ...updatePayload } : r
        );
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      return Promise.resolve({ data: materialize(), error: null }).then(resolve);
    };

    return api;
  }

  const admin = {
    from: (t: string) => builder(t),
    rpc: async (name: string, params: Row) => {
      rpcCalls.push({ name, params });
      if (opts.rpcError) return { data: null, error: { message: opts.rpcError } };
      // Simula il comportamento della RPC reale: riscrive stop_order 1..N
      // sull'ordine ricevuto, solo per le righe di tenant/linea/direzione.
      const ids = params.p_stop_ids as string[];
      tables.tenant_bus_line_stops = (tables.tenant_bus_line_stops ?? []).map((r) => {
        const idx = ids.indexOf(r.id as string);
        if (idx === -1) return r;
        return { ...r, stop_order: idx + 1 };
      });
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;

  return { admin, rpcCalls };
}

async function allRows(admin: SupabaseClient, table: string): Promise<Row[]> {
  return new Promise<Row[]>((resolve) => {
    (admin.from(table) as unknown as { then: (r: (v: { data: Row[] }) => void) => void }).then((v) => resolve(v.data));
  });
}

describe("normalizeBusStopOrder — Fase B/3 (puro, deterministico)", () => {
  it("ordina per stop_order crescente e riscrive come sequenza id 1..N", () => {
    const result = normalizeBusStopOrder([
      { id: "c", stop_order: 3 },
      { id: "a", stop_order: 1 },
      { id: "b", stop_order: 2 },
    ]);
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("stop_order duplicati storici: tie-break deterministico per id (mai l'ordine di iterazione del DB)", () => {
    const inputA = [
      { id: "s2", stop_order: 5 },
      { id: "s1", stop_order: 5 },
      { id: "s3", stop_order: 1 },
    ];
    const inputB = [
      { id: "s3", stop_order: 1 },
      { id: "s1", stop_order: 5 },
      { id: "s2", stop_order: 5 },
    ];
    const resultA = normalizeBusStopOrder(inputA);
    const resultB = normalizeBusStopOrder(inputB);
    expect(resultA).toEqual(resultB);
    expect(resultA).toEqual(["s3", "s1", "s2"]);
  });
});

describe("reorderBusLineStops — Fase B/1/2 (orchestrazione JS attorno alla RPC atomica)", () => {
  it("lista vuota -> rifiutata PRIMA di chiamare la RPC", async () => {
    const { admin, rpcCalls } = makeFakeAdmin({});
    const result = await reorderBusLineStops(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", orderedStopIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty");
    expect(rpcCalls).toHaveLength(0);
  });

  it("id duplicati nell'elenco -> rifiutata PRIMA di chiamare la RPC (mai stop_order duplicato)", async () => {
    const { admin, rpcCalls } = makeFakeAdmin({});
    const result = await reorderBusLineStops(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", orderedStopIds: ["s1", "s2", "s1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("duplicate_ids");
    expect(rpcCalls).toHaveLength(0);
  });

  it("caso valido: chiama la RPC reorder_bus_line_stops con tenant/linea/direzione/ordine esatti", async () => {
    const { admin, rpcCalls } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 1 },
        { id: "s2", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 2 },
      ],
    });
    const result = await reorderBusLineStops(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", orderedStopIds: ["s2", "s1"],
    });
    expect(result.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({
      name: "reorder_bus_line_stops",
      params: { p_tenant_id: TENANT, p_bus_line_id: LINE_CENTRO, p_direction: "departure", p_stop_ids: ["s2", "s1"] },
    });
  });

  it("6. dopo il reorder, stop_order finale è 1..N senza duplicati (via RPC simulata)", async () => {
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 9 },
        { id: "s2", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 9 },
        { id: "s3", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 1 },
      ],
    });
    await reorderBusLineStops(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", orderedStopIds: ["s3", "s1", "s2"],
    });
    const rows = await allRows(admin, "tenant_bus_line_stops");
    const orders = rows.map((r) => r.stop_order).sort();
    expect(orders).toEqual([1, 2, 3]);
    expect(new Set(orders).size).toBe(3);
  });

  it("errore RPC (es. fermata estranea a linea/direzione) -> mappato come rpc_error con messaggio leggibile", async () => {
    const { admin } = makeFakeAdmin({}, { rpcError: "Una o piu fermate non appartengono alla linea/direzione selezionata." });
    const result = await reorderBusLineStops(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", orderedStopIds: ["s1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("rpc_error");
      if (result.reason === "rpc_error") expect(result.message).toMatch(/non appartengono/);
    }
  });
});

describe("normalizeBusLineStopOrder — Fase B/3 (esplicita, scoped a UNA linea+direzione)", () => {
  it("legge solo le fermate ATTIVE di quella linea+direzione e le rinumera 1..N deterministicamente", async () => {
    const { admin, rpcCalls } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 9, active: true },
        { id: "s2", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 9, active: true },
        // altra linea: mai toccata da questa chiamata
        { id: "s3", tenant_id: TENANT, bus_line_id: OTHER_LINE, direction: "departure", stop_order: 1, active: true },
        // stessa linea+direzione ma inattiva: esclusa dalla normalizzazione
        { id: "s4", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_order: 1, active: false },
        // stessa linea, direzione diversa: mai toccata
        { id: "s5", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_order: 1, active: true },
      ],
    });
    const result = await normalizeBusLineStopOrder(admin, TENANT, LINE_CENTRO, "departure");
    expect(result.ok).toBe(true);
    expect(rpcCalls).toHaveLength(1);
    expect(new Set(rpcCalls[0].params.p_stop_ids as string[])).toEqual(new Set(["s1", "s2"]));
    expect(rpcCalls[0].params.p_stop_ids).toEqual(["s1", "s2"]); // tie-break per id, deterministico
  });

  it("nessuna fermata attiva nel gruppo -> no-op, mai una RPC su lista vuota", async () => {
    const { admin, rpcCalls } = makeFakeAdmin({ tenant_bus_line_stops: [] });
    const result = await normalizeBusLineStopOrder(admin, TENANT, LINE_CENTRO, "departure");
    expect(result.ok).toBe(true);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("createStopForTransfer — Fase B/4 (core unificato su createBusLineStop)", () => {
  const geocodeNull = vi.fn(async () => null);

  it("fermata già esistente (match esatto case-insensitive) -> riusa l'id esistente, mai un secondo insert", async () => {
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "TERNI", city: "Terni", stop_order: 3, active: true },
      ],
    });
    const geocode = vi.fn(async () => ({ lat: 42.5, lng: 12.6 }));
    const result = await createStopForTransfer(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "arrival", stopName: "terni",
    }, geocode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stopId).toBe("s1");
    expect(geocode).not.toHaveBeenCalled(); // early exit: mai geocoding se la fermata esiste già
  });

  it("nessun match, geocoding fallisce (null) -> crea in coda (max stop_order + 1) via createBusLineStop", async () => {
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "TERNI", city: "Terni", stop_order: 3, active: true, lat: 42.5, lng: 12.6 },
      ],
    });
    const result = await createStopForTransfer(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "arrival", stopName: "Assisi",
    }, geocodeNull);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rows = await allRows(admin, "tenant_bus_line_stops");
      const newStop = rows.find((r) => r.id === result.stopId) as Row;
      expect(newStop.stop_order).toBe(4);
      expect(newStop.is_manual).toBe(true);
      expect(newStop.active).toBe(true);
    }
  });

  it("geocoding posiziona la nuova fermata in mezzo -> shift dei stop_order successivi, poi createBusLineStop con l'ordine calcolato", async () => {
    // direction=arrival: ordinamento per lat decrescente (nord->sud). Nuova
    // fermata (lat 42.0) va tra FIRENZE (lat 43.8, stop_order 1) e ROMA
    // (lat 41.9, stop_order 2).
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "firenze", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "FIRENZE", city: "Firenze", stop_order: 1, active: true, lat: 43.8, lng: 11.3 },
        { id: "roma", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "ROMA", city: "Roma", stop_order: 2, active: true, lat: 41.9, lng: 12.5 },
      ],
    });
    const geocode = vi.fn(async () => ({ lat: 42.0, lng: 12.0 })); // es. Perugia, tra Firenze e Roma
    const result = await createStopForTransfer(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "arrival", stopName: "Perugia",
    }, geocode);
    expect(result.ok).toBe(true);

    const rows = await allRows(admin, "tenant_bus_line_stops");
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    expect(byId.get("firenze")?.stop_order).toBe(1); // invariata
    expect(byId.get("roma")?.stop_order).toBe(3); // shiftata +1 per far posto
    if (result.ok) {
      const newStop = byId.get(result.stopId);
      expect(newStop?.stop_order).toBe(2); // inserita tra Firenze e Roma
      expect(newStop?.lat).toBe(42.0);
    }
  });

  it("regressione: duplicato con spaziatura/maiuscole diverse -> intercettato dal core condiviso, riusa l'id invece di crearne un secondo", async () => {
    // La fermata esiste già con doppio spazio interno rispetto alla ricerca:
    // il controllo rapido ilike iniziale (match esatto) NON lo intercetta,
    // ma il fallback su createBusLineStop (normalizeStopText, che collassa
    // gli spazi) lo blocca comunque — mai una seconda logica di dedup.
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "SAN  GEMINI", city: "San Gemini", stop_order: 1, active: true },
      ],
    });
    const result = await createStopForTransfer(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", stopName: "san gemini",
    }, geocodeNull);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stopId).toBe("s1");
    const rows = await allRows(admin, "tenant_bus_line_stops");
    expect(rows.filter((r) => r.bus_line_id === LINE_CENTRO && r.direction === "departure")).toHaveLength(1);
  });

  it("direzione indipendente: stessa città su arrival e departure non è considerata duplicata", async () => {
    const { admin } = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "TERNI", city: "Terni", stop_order: 1, active: true },
      ],
    });
    const result = await createStopForTransfer(admin, {
      tenantId: TENANT, busLineId: LINE_CENTRO, direction: "departure", stopName: "Terni",
    }, geocodeNull);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stopId).not.toBe("s1");
  });
});
