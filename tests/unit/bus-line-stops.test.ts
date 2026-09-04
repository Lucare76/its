import { describe, it, expect } from "vitest";
import {
  createBusLineStop,
  updateBusLineStop,
  deleteBusLineStop,
  findNearDuplicateStopNames,
} from "@/lib/server/bus-line-stops";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * PROMPT "Fermate bus" — Fase 8/9/10/12: test diretti sull'helper server
 * condiviso (createBusLineStop / updateBusLineStop / deleteBusLineStop),
 * la UNICA logica di creazione/modifica/eliminazione fermata — usata sia da
 * /bus-stops sia da qualsiasi futuro punto di creazione (import/planner).
 */

const TENANT = "d200b89a-64c7-4f8d-a430-95a33b83047a";
const LINE_CENTRO = "line-centro";

type Row = Record<string, unknown>;

// Fake Supabase client in-memory con filtri eq/neq REALMENTE applicati
// (a differenza del builder "always-return-seed" di altri test in questo
// repo) — necessario perché la correttezza anti-duplicato dipende dai
// filtri (bus_line_id/direction/id esclusi correttamente).
function makeFakeAdmin(tables: Record<string, Row[]>) {
  let idCounter = 0;

  function builder(table: string) {
    let rows = [...(tables[table] ?? [])];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let insertPayload: Row | Row[] | null = null;
    let updatePayload: Row | null = null;
    let orderCol: string | null = null;
    let orderDesc = false;
    let limitN: number | null = null;
    let countRequested = false;

    const api: Record<string, (...args: never[]) => unknown> = {};

    api.select = (...args: unknown[]) => {
      const opts = args[1] as { count?: string; head?: boolean } | undefined;
      if (opts?.count) countRequested = true;
      return api;
    };
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
    api.order = (...args: unknown[]) => {
      const [col, opts] = args as [string, { ascending?: boolean } | undefined];
      orderCol = col;
      orderDesc = opts?.ascending === false;
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
    api.delete = () => {
      mode = "delete";
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
    // Selezione multi-riga / count / delete: risolto via `then` come nel
    // pattern già in uso in tests/unit/bus-network-loader.test.ts.
    api.then = (resolve: (v: unknown) => unknown) => {
      if (mode === "delete") {
        const toDelete = new Set(materialize().map((r) => r.id));
        tables[table] = (tables[table] ?? []).filter((r) => !toDelete.has(r.id));
        return Promise.resolve({ data: null, error: null }).then(resolve);
      }
      const result = materialize();
      if (countRequested) return Promise.resolve({ data: result, count: result.length, error: null }).then(resolve);
      return Promise.resolve({ data: result, error: null }).then(resolve);
    };

    return api;
  }

  return { from: (t: string) => builder(t) } as unknown as SupabaseClient;
}

describe("findNearDuplicateStopNames", () => {
  it("'ROMA - SAN CAMILLO' e 'SAN CAMILLO' si segnalano a vicenda come near-duplicate", () => {
    const result = findNearDuplicateStopNames("SAN CAMILLO", [{ id: "s1", stopName: "ROMA - SAN CAMILLO", city: "Roma" }]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("nomi completamente diversi non generano falsi positivi", () => {
    const result = findNearDuplicateStopNames("PERUGIA", [{ id: "s1", stopName: "TERNI", city: "Terni" }]);
    expect(result).toHaveLength(0);
  });

  it("match esatto NON è incluso tra i near-duplicate (è un caso separato, bloccante)", () => {
    const result = findNearDuplicateStopNames("TERNI", [{ id: "s1", stopName: "TERNI", city: "Terni" }]);
    expect(result).toHaveLength(0);
  });
});

describe("createBusLineStop — Fase 6/7/9/14", () => {
  it("6. crea una nuova fermata con stop_order proposto automaticamente (max+1)", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "TERNI", city: "Terni", stop_order: 7, pickup_note: "Terminal Bus Atc" },
      ],
    });
    const result = await createBusLineStop(admin, {
      tenantId: TENANT,
      busLineId: LINE_CENTRO,
      direction: "departure",
      stopName: "assisi",
      city: "Assisi",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stop.stop_name).toBe("ASSISI"); // Fase 4 — sempre uppercase salvato
      expect(result.stop.stop_order).toBe(8);
      expect(result.nearDuplicates).toHaveLength(0);
    }
  });

  it("7. duplicato esatto (stesso nome normalizzato, stessa linea+direzione) -> BLOCCATO", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "NARNI", city: "Narni", stop_order: 6, pickup_note: null },
      ],
    });
    const result = await createBusLineStop(admin, {
      tenantId: TENANT,
      busLineId: LINE_CENTRO,
      direction: "departure",
      stopName: "narni",
      city: "Narni",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("duplicate");
      if (result.reason === "duplicate") expect(result.existingStopId).toBe("s1");
    }
  });

  it("8. near-duplicate ('SAN CAMILLO' vs 'ROMA - SAN CAMILLO') -> creata comunque, ma con warning (mai unita automaticamente)", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "ROMA - SAN CAMILLO", city: "Roma", stop_order: 5, pickup_note: "SAN CAMILLO" },
      ],
    });
    const result = await createBusLineStop(admin, {
      tenantId: TENANT,
      busLineId: LINE_CENTRO,
      direction: "arrival",
      stopName: "San Camillo",
      city: "Roma",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nearDuplicates.map((d) => d.id)).toEqual(["s1"]);
    }
  });

  it("14. la stessa città su ANDATA e RITORNO non è considerata duplicata (direzioni indipendenti)", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "TERNI", city: "Terni", stop_order: 6, pickup_note: "Terminal Bus Atc" },
      ],
    });
    const result = await createBusLineStop(admin, {
      tenantId: TENANT,
      busLineId: LINE_CENTRO,
      direction: "departure",
      stopName: "Terni",
      city: "Terni",
      pickupNote: "Terminal Bus Atc",
      stopOrder: 7,
    });
    expect(result.ok).toBe(true);
  });

  it("15/16. la stessa funzione condivisa produce risultati identici sia chiamata come 'da UI manuale' sia come 'da import' — nessuna seconda business logic", async () => {
    const seedManual = { tenant_bus_line_stops: [] as Row[] };
    const seedImport = { tenant_bus_line_stops: [] as Row[] };
    const input = { tenantId: TENANT, busLineId: LINE_CENTRO, direction: "arrival" as const, stopName: "cascia", city: "Cascia" };

    const manualResult = await createBusLineStop(makeFakeAdmin(seedManual), input);
    const importResult = await createBusLineStop(makeFakeAdmin(seedImport), input);

    expect(manualResult.ok).toBe(true);
    expect(importResult.ok).toBe(true);
    if (manualResult.ok && importResult.ok) {
      expect(manualResult.stop.stop_name).toBe(importResult.stop.stop_name);
      expect(manualResult.stop.stop_order).toBe(importResult.stop.stop_order);
    }
  });
});

describe("updateBusLineStop — Fase 9/10", () => {
  it("9. modifica pickup_note su fermata esistente", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "NARNI", city: "Narni", stop_order: 6, pickup_note: null, active: true },
      ],
    });
    const result = await updateBusLineStop(admin, { tenantId: TENANT, stopId: "s1", pickupNote: "Piazzale stazione" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stop.pickup_note).toBe("Piazzale stazione");
  });

  it("10. modifica stop_order", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "NARNI", city: "Narni", stop_order: 6, pickup_note: null, active: true },
      ],
    });
    const result = await updateBusLineStop(admin, { tenantId: TENANT, stopId: "s1", stopOrder: 9 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stop.stop_order).toBe(9);
  });

  it("cambio linea/direzione su fermata SENZA allocazioni -> consentito", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "GUBBIO", city: "Gubbio", stop_order: 1, pickup_note: null, active: true },
      ],
      tenant_bus_allocations: [],
    });
    const result = await updateBusLineStop(admin, { tenantId: TENANT, stopId: "s1", direction: "departure" });
    expect(result.ok).toBe(true);
  });

  it("cambio linea/direzione su fermata CON allocazioni -> bloccato, mai silenzioso", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [
        { id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "arrival", stop_name: "PERUGIA", city: "Perugia", stop_order: 2, pickup_note: "Pian di Massiano", active: true },
      ],
      tenant_bus_allocations: [{ id: "a1", tenant_id: TENANT, stop_id: "s1", service_id: "svc-1" }],
    });
    const result = await updateBusLineStop(admin, { tenantId: TENANT, stopId: "s1", direction: "departure" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("line_direction_locked");
      if (result.reason === "line_direction_locked") expect(result.usageCount).toBe(1);
    }
  });
});

describe("deleteBusLineStop — Fase 12", () => {
  it("12. fermata referenziata da allocazioni -> NON eliminata, errore con conteggio servizi", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [{ id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "TERNI", city: "Terni", stop_order: 7 }],
      tenant_bus_allocations: [
        { id: "a1", tenant_id: TENANT, stop_id: "s1", service_id: "svc-1" },
        { id: "a2", tenant_id: TENANT, stop_id: "s1", service_id: "svc-2" },
      ],
    });
    const result = await deleteBusLineStop(admin, TENANT, "s1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("in_use");
      if (result.reason === "in_use") expect(result.usageCount).toBe(2);
    }
  });

  it("13. fermata mai utilizzata (0 allocazioni) -> eliminazione consentita", async () => {
    const admin = makeFakeAdmin({
      tenant_bus_line_stops: [{ id: "s1", tenant_id: TENANT, bus_line_id: LINE_CENTRO, direction: "departure", stop_name: "SARNICO", city: "Sarnico", stop_order: 100 }],
      tenant_bus_allocations: [],
    });
    const result = await deleteBusLineStop(admin, TENANT, "s1");
    expect(result.ok).toBe(true);
  });
});
