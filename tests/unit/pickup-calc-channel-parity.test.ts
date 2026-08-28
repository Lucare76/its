import { describe, it, expect } from "vitest";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";

/**
 * Test di PARITA' tra canali (manuale operatore, agenzia, Excel, email/inbox-
 * approve). Tutti e quattro i write-path ora chiamano la stessa funzione
 * (applyPickupCalc) con gli stessi parametri per uno scenario operativamente
 * equivalente — questi test lo dimostrano invocando direttamente la funzione
 * condivisa con le identiche forme di input che ciascun canale le passa,
 * anziche' ri-testare quattro handler HTTP separati (gia' coperti dai relativi
 * test di route: new-booking-pickup-hotel, inbox-approve-route).
 *
 * Se applyPickupCalc produce lo stesso risultato per lo stesso input, allora
 * qualunque canale che chiama questa funzione con quell'input produce lo
 * stesso dato persistito — e' esattamente cio' che la centralizzazione
 * garantisce (non serve piu' testare la logica di calcolo dentro ogni route).
 */

describe("Parita' canali — Caso 1: Aleste + treno + traghetto standard", () => {
  it("manuale/agenzia/Excel/email userebbero tutti gli stessi parametri -> stesso pickup", () => {
    const input = {
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    };
    const result = applyPickupCalc(input);
    expect(result.pickup_hotel).toBe("11:00");
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.pickup_alert).toBeNull();
  });
});

describe("Parita' canali — Caso 2: Aleste + treno + _aliscafo", () => {
  it("kind _aliscafo per Aleste: richiesta esplicita rispettata — nessuna tabella statica aliscafo per Aleste, quindi null + alert, MAI traghetto/Medmar", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel_aliscafo",
      time: "09:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.barca_compagnia).toBeNull();
    expect(result.pickup_hotel).toBeNull();
    expect(result.pickup_alert).toMatch(/[Aa]liscafo/);
  });
});

describe("Parita' canali — Caso 3: Aleste + volo standard", () => {
  it("stesso risultato per qualunque canale che passi kind=transfer_airport_hotel + stesso orario/agenzia", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_airport_hotel",
      time: "12:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.pickup_hotel).toBe("07:20");
  });
});

describe("Parita' canali — Caso 4: Aleste + volo _aliscafo", () => {
  it("stesso comportamento del caso treno: richiesta esplicita aliscafo rispettata, MAI traghetto/Medmar (nessuna tabella aliscafo Aleste in calc-pickup-time.ts)", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_airport_hotel_aliscafo",
      time: "12:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.barca_compagnia).toBeNull();
    expect(result.pickup_hotel).toBeNull();
    expect(result.pickup_alert).toMatch(/[Aa]liscafo/);
  });
});

describe("Parita' canali — Caso 5: Sosandra + treno + aliscafo", () => {
  it("agenzia Sosandra + aliscafo: comportamento gia' esistente, invariato dalla centralizzazione", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel_aliscafo",
      time: "09:00",
      billing_party_name: "sosandra",
      vessel: "qualunque testo senza nomi di compagnia",
    });
    expect(result.barca_compagnia).toBe("Alilauro");
  });
});

describe("Parita' canali — Caso 6: Formula SNAV diretta", () => {
  it("formula_snav (canale manuale/agenzia) e transfer_port_hotel+vessel SNAV (canale email) producono lo STESSO pickup per lo stesso orario/zona", () => {
    const shared = { direction: "departure", time: "14:00", billing_party_name: "ALESTE VIAGGI", hotel_zone: "Ischia Porto" };
    const viaFormula = applyPickupCalc({ ...shared, booking_service_kind: "formula_snav", vessel: null });
    const viaPortoPorto = applyPickupCalc({ ...shared, booking_service_kind: "transfer_port_hotel", vessel: "SNAV 14:00" });
    expect(viaFormula.pickup_hotel).toBe("12:30");
    expect(viaFormula.pickup_hotel).toBe(viaPortoPorto.pickup_hotel);
  });
});

describe("Parita' canali — Caso 7: Formula MEDMAR diretta", () => {
  it("formula_medmar_napoli e transfer_port_hotel+vessel MEDMAR producono lo STESSO pickup per lo stesso orario/zona", () => {
    const shared = { direction: "departure", time: "10:35", billing_party_name: "ALESTE VIAGGI", hotel_zone: "Ischia Porto" };
    const viaFormula = applyPickupCalc({ ...shared, booking_service_kind: "formula_medmar_napoli", vessel: null });
    const viaPortoPorto = applyPickupCalc({ ...shared, booking_service_kind: "transfer_port_hotel", vessel: "MEDMAR Napoli 10:35" });
    expect(viaFormula.pickup_hotel).toBe("08:40");
    expect(viaFormula.pickup_hotel).toBe(viaPortoPorto.pickup_hotel);
  });
});

describe("Parita' canali — Caso 8: porto-porto puro non forzato nel dominio treno/volo", () => {
  it("transfer_port_hotel non passa mai per calcPickupTime (dominio A) — solo per getPickupRule (dominio B)", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_port_hotel",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "SNAV 14:00",
      hotel_zone: "Ischia Porto",
    });
    // Dominio B non tocca orario_barca/porto_bruno (responsabilita' del chiamante) —
    // se fosse passato per errore nel dominio A (calcPickupTime), questi sarebbero valorizzati.
    expect(result.orario_barca).toBeUndefined();
    expect(result.porto_bruno).toBeUndefined();
    expect(result.pickup_hotel).toBe("12:30");
  });
});

describe("Parita' canali — Caso 9: dati insufficienti, nessun orario inventato in nessun canale", () => {
  it("Formula senza hotel_zone: null + alert, mai un pickup inventato, indipendentemente da quale canale chiama", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
      // hotel_zone assente: simula qualunque canale che non ha ancora questo dato
      // (es. Excel con hotel non riconosciuto, o email prima della risoluzione hotel).
    });
    expect(result.pickup_hotel).toBeUndefined();
    expect(result.pickup_hotel).not.toBe("00:00");
    expect(result.pickup_alert).toBeTruthy();
  });

  it("treno/volo senza time: nessun calcolo, mai 00:00", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    });
    expect(result.pickup_hotel).toBeUndefined();
  });
});
