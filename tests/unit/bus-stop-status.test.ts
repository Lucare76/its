import { describe, it, expect } from "vitest";
import { classifyBusStopStatus, isGenericPlaceholderStopName } from "@/lib/bus-stop-status";

/**
 * PROMPT "Fermate bus" — Fase 13/14.
 *
 * Caso reale di riferimento (audit sessione precedente, CENTRO departure):
 * VALMONTONE/ROMA/TERNI/FOLIGNO/PERUGIA hanno pickup_note valorizzato,
 * NARNI no pur avendo 2 servizi collegati -> deve risultare "da completare",
 * mai "attiva" e mai "mai utilizzata" (ha traffico reale).
 */
describe("classifyBusStopStatus", () => {
  it("NARNI (CENTRO departure): stop_id collegato, pickup_note vuoto, 2 servizi -> incomplete (Da completare)", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "NARNI",
      city: "Narni",
      pickupNote: null,
      serviceCount: 2,
    });
    expect(status).toBe("incomplete");
  });

  it("TERNI (CENTRO departure): pickup_note presente, servizi collegati -> active (Attiva)", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "TERNI",
      city: "Terni",
      pickupNote: "Terminal Bus Atc",
      serviceCount: 37,
    });
    expect(status).toBe("active");
  });

  it("fermata mai usata (0 servizi), pickup_note vuoto -> unused (Mai utilizzata), non incomplete", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "SARNICO",
      city: "Sarnico",
      pickupNote: null,
      serviceCount: 0,
    });
    expect(status).toBe("unused");
  });

  it("nome placeholder generico (es. 'CASELLO' da solo) -> review (Da verificare), anche se ha servizi", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "CASELLO",
      city: "CASELLO",
      pickupNote: "qualcosa",
      serviceCount: 3,
    });
    expect(status).toBe("review");
  });

  it("stop_order duplicato flag -> review, anche con dati altrimenti completi", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "ROMA - SAN CAMILLO",
      city: "Roma",
      pickupNote: "SAN CAMILLO",
      serviceCount: 1,
      hasDuplicateStopOrder: true,
    });
    expect(status).toBe("review");
  });

  it("near-duplicate sospetto flag -> review", () => {
    const status = classifyBusStopStatus({
      active: true,
      stopName: "SAN CAMILLO",
      city: "Roma",
      pickupNote: null,
      serviceCount: 0,
      hasNearDuplicateName: true,
    });
    expect(status).toBe("review");
  });

  it("fermata disattivata (active=false) -> inactive, priorità massima su tutti gli altri criteri", () => {
    const status = classifyBusStopStatus({
      active: false,
      stopName: "TERNI",
      city: "Terni",
      pickupNote: "Terminal Bus Atc",
      serviceCount: 37,
    });
    expect(status).toBe("inactive");
  });

  it("isGenericPlaceholderStopName riconosce solo il nome INTERO generico, non un nome descrittivo che lo contiene", () => {
    expect(isGenericPlaceholderStopName("CASELLO")).toBe(true);
    expect(isGenericPlaceholderStopName("Autostradale")).toBe(true);
    expect(isGenericPlaceholderStopName("Casello autostradale nord")).toBe(false);
    expect(isGenericPlaceholderStopName("TERNI")).toBe(false);
  });
});
