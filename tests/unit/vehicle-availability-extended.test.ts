/**
 * Test estesi per lib/server/vehicle-availability.ts
 *
 * Copre i casi limite non presenti nel test base:
 * - blocco senza blocked_from (solo blocked_until)
 * - blocco senza blocked_until (solo blocked_from = da quel momento in poi)
 * - is_blocked_manual=false ma con blocked_until (schedulato automaticamente)
 * - durationMin custom in isVehicleManuallyBlockedAtTime
 * - manualVehicleBlockMessage senza motivazione
 */
import { describe, expect, it } from "vitest";
import {
  isVehicleManuallyBlockedAtTime,
  isVehicleManuallyBlockedOnDate,
  manualVehicleBlockMessage,
} from "@/lib/server/vehicle-availability";

describe("isVehicleManuallyBlockedOnDate — casi limite", () => {
  it("is_blocked_manual=false e blocked_until assente → mezzo libero", () => {
    expect(isVehicleManuallyBlockedOnDate({ is_blocked_manual: false }, "2026-05-13")).toBe(false);
  });

  it("blocco permanente senza scadenza (solo blocked_from) → bloccato dal giorno in poi", () => {
    const vehicle = { blocked_from: "2026-05-13T00:00:00.000Z", is_blocked_manual: true };
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-13")).toBe(true);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-20")).toBe(true);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-12")).toBe(false);
  });

  it("blocco senza blocked_from (solo blocked_until) → bloccato fino alla scadenza", () => {
    const vehicle = { blocked_until: "2026-05-15T23:59:59.000Z", is_blocked_manual: true };
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-10")).toBe(true);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-15")).toBe(true);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-16")).toBe(false);
  });

  it("is_blocked_manual=false con blocked_until presente → bloccato (blocco automatico da anomalia)", () => {
    // Un blocco da anomalia rilevata automaticamente ha is_blocked_manual=false ma ha blocked_until
    const vehicle = { blocked_until: "2026-05-13T23:59:59.000Z", is_blocked_manual: false };
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-13")).toBe(true);
  });

  it("blocco che inizia e finisce nello stesso istante della data → bloccato", () => {
    const vehicle = {
      blocked_from: "2026-05-13T12:00:00.000Z",
      blocked_until: "2026-05-13T12:00:00.000Z",
      is_blocked_manual: true,
    };
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-13")).toBe(true);
  });

  it("blocked_from dopo fine giornata → non bloccato quel giorno", () => {
    const vehicle = {
      blocked_from: "2026-05-14T00:00:00.001Z",
      blocked_until: "2026-05-15T00:00:00.000Z",
      is_blocked_manual: true,
    };
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-13")).toBe(false);
    expect(isVehicleManuallyBlockedOnDate(vehicle, "2026-05-14")).toBe(true);
  });
});

describe("isVehicleManuallyBlockedAtTime — sovrapposizione finestre", () => {
  const vehicle = {
    blocked_from: "2026-05-13T10:00:00.000Z",
    blocked_until: "2026-05-13T14:00:00.000Z",
    is_blocked_manual: true,
  };

  it("giro che termina esattamente all'inizio del blocco → non sovrapposto", () => {
    // giro 08:00 + 120min = termina 10:00 UTC → non sovrappone con blocco che parte 10:00
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "08:00", 120)).toBe(false);
  });

  it("giro che inizia esattamente alla fine del blocco → non sovrapposto", () => {
    // giro 14:00 → blocco finisce 14:00 → nessuna sovrapposizione
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "14:00", 90)).toBe(false);
  });

  it("giro che inizia nel mezzo del blocco → sovrapposto", () => {
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "12:00", 90)).toBe(true);
  });

  it("giro che avvolge interamente il blocco → sovrapposto", () => {
    // giro 07:00 + 480min (8h) copre l'intero blocco 10:00-14:00
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "07:00", 480)).toBe(true);
  });

  it("giro su data diversa → non sovrapposto", () => {
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-14", "10:30", 90)).toBe(false);
  });

  it("durationMin default = 90 minuti se non specificato", () => {
    // giro 09:00 + 90min = termina 10:30 → sovrappone con blocco 10:00-14:00
    expect(isVehicleManuallyBlockedAtTime(vehicle, "2026-05-13", "09:00")).toBe(true);
  });

  it("blocco senza blocked_from: il giro nel giorno è sempre sovrapposto", () => {
    const openBlock = { blocked_until: "2026-05-13T14:00:00.000Z", is_blocked_manual: true };
    expect(isVehicleManuallyBlockedAtTime(openBlock, "2026-05-13", "06:00", 60)).toBe(true);
  });
});

describe("manualVehicleBlockMessage", () => {
  it("senza motivazione → messaggio generico", () => {
    expect(manualVehicleBlockMessage({ is_blocked_manual: true }))
      .toBe("Mezzo bloccato in Flotta.");
  });

  it("con stringa vuota → messaggio generico (non espone stringa vuota)", () => {
    expect(manualVehicleBlockMessage({ blocked_reason: "", is_blocked_manual: true }))
      .toBe("Mezzo bloccato in Flotta.");
  });

  it("con motivazione → messaggio con motivazione", () => {
    expect(manualVehicleBlockMessage({ blocked_reason: "Guasto motore", is_blocked_manual: true }))
      .toBe("Mezzo bloccato in Flotta: Guasto motore.");
  });

  it("motivazione con spazi in eccesso → trimmed nel messaggio", () => {
    expect(manualVehicleBlockMessage({ blocked_reason: "  Revisione  ", is_blocked_manual: true }))
      .toBe("Mezzo bloccato in Flotta: Revisione.");
  });
});
