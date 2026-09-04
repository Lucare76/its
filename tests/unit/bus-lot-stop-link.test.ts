import { describe, it, expect } from "vitest";
import { resolveBusLotStopId } from "@/lib/bus-lot-utils";

/**
 * PROMPT "Modificabile punto di carico da /bus-tours" — Fase 3/5.
 *
 * resolveBusLotStopId collega un lotto (/bus-tours) alla SUA fermata
 * canonica (tenant_bus_line_stops) tramite gli stop_id delle allocazioni
 * (tenant_bus_allocations) dei servizi del lotto — mai per nome. Se i
 * servizi del lotto non convergono su un unico stop_id, il lotto resta
 * "unlinked" e la UI blocca il salvataggio (nessuna associazione inventata).
 */
describe("resolveBusLotStopId", () => {
  it("tutti i servizi del lotto puntano allo stesso stop_id -> linked con quell'id", () => {
    const result = resolveBusLotStopId(["stop-narni", "stop-narni", "stop-narni"]);
    expect(result).toEqual({ status: "linked", stopId: "stop-narni" });
  });

  it("un solo servizio nel lotto, con stop_id valorizzato -> linked", () => {
    expect(resolveBusLotStopId(["stop-narni"])).toEqual({ status: "linked", stopId: "stop-narni" });
  });

  it("nessuna allocazione (lotto senza servizi/allocazioni) -> unlinked, nessuna scrittura", () => {
    expect(resolveBusLotStopId([])).toEqual({ status: "unlinked" });
  });

  it("tutte le allocazioni con stop_id null (mai allocate a una fermata) -> unlinked", () => {
    expect(resolveBusLotStopId([null, null, undefined])).toEqual({ status: "unlinked" });
  });

  it("servizi del lotto su fermate DIVERSE -> unlinked, mai una fermata scelta a caso", () => {
    expect(resolveBusLotStopId(["stop-narni", "stop-terni"])).toEqual({ status: "unlinked" });
  });

  it("mix di stop_id valorizzati e null, ma tutti quelli valorizzati coincidono -> linked", () => {
    expect(resolveBusLotStopId(["stop-narni", null, "stop-narni"])).toEqual({ status: "linked", stopId: "stop-narni" });
  });
});
