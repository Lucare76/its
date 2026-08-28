/**
 * Test unitari — calcPickupTime
 *
 * Verifica le regole operative di calcolo orario prelevamento per i ritorni:
 *  - Alert per voli mattutini (≤ 09:30)
 *  - Aleste Viaggi: sempre traghetto Medmar indipendentemente da tipo_barca
 *  - Sosandra (Dimhotels): traghetto vs aliscafo, con tabelle orario_barca separate
 *  - Agenzie generiche: stessa logica Aleste
 *  - Fascia non trovata → alert appropriato
 */
import { describe, it, expect } from "vitest";
import { calcPickupTime } from "@/lib/server/calc-pickup-time";

// ─── Alert volo mattutino ─────────────────────────────────────────────────────

describe("calcPickupTime — alert volo mattutino", () => {
  it("orario <= 09:30 con aereo → alert partire giorno prima", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "aereo", tipo_barca: "traghetto", orario: "09:30" });
    expect(result.alert).toMatch(/PARTIRE GIORNO PRIMA/);
    expect(result.pickup_hotel).toBeNull();
    expect(result.barca_compagnia).toBeNull();
  });

  it("orario 09:00 con aereo → alert", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "aereo", tipo_barca: "aliscafo", orario: "09:00" });
    expect(result.alert).toMatch(/PARTIRE GIORNO PRIMA/);
  });

  it("orario 09:31 con aereo → nessun alert (fascia normale)", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "aereo", tipo_barca: "traghetto", orario: "10:00" });
    expect(result.alert).toBeNull();
  });

  it("orario <= 09:30 con treno → nessun alert (regola solo per aereo)", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "09:00" });
    expect(result.alert).toBeNull();
    expect(result.barca_compagnia).toBe("Medmar");
  });
});

// ─── Aleste Viaggi — sempre traghetto ────────────────────────────────────────

describe("calcPickupTime — Aleste Viaggi (sempre Medmar traghetto)", () => {
  it("treno 10:00 → pickup 07:20, Medmar, Napoli Beverello", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "10:00" });
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.pickup_hotel).toBe("07:20");
    expect(result.porto_bruno).toBe("Napoli Beverello");
    expect(result.alert).toBeNull();
  });

  it("tipo_barca aliscafo esplicito per Aleste → nessuna tabella statica, NON ricade su Medmar/traghetto", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "aliscafo", orario: "10:00" });
    expect(result.barca_compagnia).toBeNull();
    expect(result.pickup_hotel).toBeNull();
    expect(result.alert).toMatch(/[Aa]liscafo/);
  });

  it("treno 12:00 → pickup 09:00", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "12:00" });
    expect(result.pickup_hotel).toBe("09:00");
  });

  it("treno 17:00 → pickup 14:35", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "17:00" });
    expect(result.pickup_hotel).toBe("14:35");
  });

  it("treno 20:00 → pickup 16:00 (fascia serale)", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "20:00" });
    expect(result.pickup_hotel).toBe("16:00");
  });

  it("aereo 11:00 → pickup 07:20", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "aereo", tipo_barca: "traghetto", orario: "11:00" });
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.pickup_hotel).toBe("07:20");
  });

  it("aereo 14:00 → pickup 09:10", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "aereo", tipo_barca: "traghetto", orario: "14:00" });
    expect(result.pickup_hotel).toBe("09:10");
  });
});

// ─── Agenzie generiche (non Aleste, non Sosandra) ────────────────────────────

describe("calcPickupTime — agenzia generica", () => {
  it("holidayweb treno 10:00 → stesso risultato di Aleste", () => {
    const aleste = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "10:00" });
    const generic = calcPickupTime({ agency_key: "holidayweb", mezzo: "treno", tipo_barca: "traghetto", orario: "10:00" });
    expect(generic.pickup_hotel).toBe(aleste.pickup_hotel);
    expect(generic.barca_compagnia).toBe(aleste.barca_compagnia);
  });

  it("unknown agency aereo 15:00 → Medmar, pickup 11:10", () => {
    const result = calcPickupTime({ agency_key: "unknown", mezzo: "aereo", tipo_barca: "traghetto", orario: "15:00" });
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.pickup_hotel).toBe("11:10");
  });
});

// ─── Sosandra (Dimhotels) — traghetto ────────────────────────────────────────

describe("calcPickupTime — Sosandra traghetto", () => {
  it("treno 10:00 → orario_barca 06:20, Medmar, Napoli Beverello", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "traghetto", orario: "10:00" });
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.orario_barca).toBe("06:20");
    expect(result.porto_bruno).toBe("Napoli Beverello");
  });

  it("treno 12:00 → orario_barca 08:10", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "traghetto", orario: "12:00" });
    expect(result.orario_barca).toBe("08:10");
  });

  it("treno 17:00 → orario_barca 13:35", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "traghetto", orario: "17:00" });
    expect(result.orario_barca).toBe("13:35");
  });

  it("aereo 13:00 → orario_barca 08:10, Medmar", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "aereo", tipo_barca: "traghetto", orario: "13:00" });
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.orario_barca).toBe("08:10");
  });
});

// ─── Sosandra (Dimhotels) — aliscafo ─────────────────────────────────────────

describe("calcPickupTime — Sosandra aliscafo", () => {
  it("treno 09:00 → Alilauro, orario_barca 06:30, Napoli Beverello, pickup 07:15", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "aliscafo", orario: "09:00" });
    expect(result.barca_compagnia).toBe("Alilauro");
    expect(result.orario_barca).toBe("06:30");
    expect(result.porto_bruno).toBe("Napoli Beverello");
    expect(result.pickup_hotel).toBe("07:15");
  });

  it("treno 10:00 → Snav, Pozzuoli, pickup 09:10", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "aliscafo", orario: "10:00" });
    expect(result.barca_compagnia).toBe("Snav");
    expect(result.porto_bruno).toBe("Pozzuoli");
    expect(result.pickup_hotel).toBe("09:10");
  });

  it("treno 17:00 → Snav, orario_barca 14:00, Pozzuoli", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "treno", tipo_barca: "aliscafo", orario: "17:00" });
    expect(result.barca_compagnia).toBe("Snav");
    expect(result.orario_barca).toBe("14:00");
    expect(result.porto_bruno).toBe("Pozzuoli");
  });

  it("aereo 10:00 → Alilauro, orario_barca 06:30, pickup 07:15", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "aereo", tipo_barca: "aliscafo", orario: "10:00" });
    expect(result.barca_compagnia).toBe("Alilauro");
    expect(result.orario_barca).toBe("06:30");
    expect(result.pickup_hotel).toBe("07:15");
  });

  it("aereo 18:00 → Snav, Pozzuoli", () => {
    const result = calcPickupTime({ agency_key: "sosandra", mezzo: "aereo", tipo_barca: "aliscafo", orario: "18:00" });
    expect(result.barca_compagnia).toBe("Snav");
    expect(result.porto_bruno).toBe("Pozzuoli");
  });
});

// ─── Fascia non trovata ───────────────────────────────────────────────────────

describe("calcPickupTime — fascia non trovata", () => {
  it("orario fuori tabella → alert fascia non trovata", () => {
    const result = calcPickupTime({ agency_key: "aleste", mezzo: "treno", tipo_barca: "traghetto", orario: "07:00" });
    expect(result.alert).toMatch(/Fascia oraria non trovata/);
    expect(result.pickup_hotel).toBeNull();
  });
});
