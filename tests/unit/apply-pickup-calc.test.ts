import { describe, it, expect } from "vitest";
import { applyPickupCalc } from "@/lib/server/apply-pickup-calc";

describe("applyPickupCalc — trigger basato su booking_service_kind", () => {
  it("transfer_train_hotel in departure genera pickup_hotel", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    });
    expect(result.pickup_hotel).toBe("11:00");
    expect(result.barca_compagnia).toBe("Medmar");
    expect(result.pickup_alert).toBeNull();
  });

  it("SUORATO: orario treno 14:00 usato esattamente come input del calcolo", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    });
    expect(result.pickup_hotel).toBe("11:00");
  });

  it("BIRAGO: orario treno 12:10 usato esattamente come input del calcolo (agenzia assente -> default aleste)", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "12:10",
      billing_party_name: null,
      vessel: "TRENO",
    });
    expect(result.pickup_hotel).toBe("09:00");
  });

  it("transfer_airport_hotel in departure genera pickup con mezzo aereo", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_airport_hotel",
      time: "12:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.pickup_hotel).toBe("07:20");
  });

  it("arrival non triggera mai il calcolo pickup, anche con kind treno/aereo", () => {
    for (const kind of ["transfer_train_hotel", "transfer_airport_hotel"]) {
      const result = applyPickupCalc({
        direction: "arrival",
        booking_service_kind: kind,
        time: "12:10",
        billing_party_name: "ALESTE VIAGGI",
        vessel: "TRENO",
      });
      expect(result).toEqual({});
    }
  });

  it("navetta / shuttle_hotel / excursion / transfer_hotel_hotel / private_island non triggerano il calcolo (no-op, davvero fuori scope)", () => {
    for (const kind of ["navetta", "shuttle_hotel", "excursion", "transfer_hotel_hotel", "private_island"]) {
      const result = applyPickupCalc({
        direction: "departure",
        booking_service_kind: kind,
        time: "12:10",
        billing_party_name: "ALESTE VIAGGI",
        vessel: null,
      });
      expect(result).toEqual({});
    }
  });

  it("transfer_port_hotel senza vessel/compagnia riconoscibile: NON e' un no-op silenzioso (e' nel dominio porto-porto), produce pickup_alert esplicito", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_port_hotel",
      time: "12:10",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.pickup_hotel).toBeUndefined();
    expect(result.pickup_alert).toMatch(/compagnia.*non riconosciuta/i);
  });

  it("formula_medmar_napoli / formula_snav SENZA hotel_zone: non e' piu' un no-op silenzioso, produce pickup_alert esplicito (mai un pickup inventato)", () => {
    for (const kind of ["formula_medmar_napoli", "formula_medmar_pozzuoli", "formula_snav"]) {
      const result = applyPickupCalc({
        direction: "departure",
        booking_service_kind: kind,
        time: "12:10",
        billing_party_name: "ALESTE VIAGGI",
        vessel: null,
      });
      expect(result.pickup_hotel).toBeUndefined();
      expect(result.pickup_alert).toMatch(/zona non impostata/);
    }
  });

  it("booking_service_kind assente -> no-op (nessun fallback su place_type o altro)", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: null,
      time: "12:10",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    });
    expect(result).toEqual({});
  });

  it("time vuoto -> no-op, nessun calcolo con orario mancante", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel",
      time: "",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "TRENO",
    });
    expect(result).toEqual({});
  });

  it("varianti _aliscafo usano tipo_barca aliscafo esplicito dal kind, non dal testo vessel", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_train_hotel_aliscafo",
      time: "09:00",
      billing_party_name: "sosandra",
      vessel: "qualunque testo senza nomi di compagnia",
    });
    // Con agency sosandra + treno + aliscafo, la tabella usata e' DIMHOTELS_TRENO_ALISCAFO
    expect(result.barca_compagnia).toBe("Alilauro");
  });
});

describe("applyPickupCalc — dominio B: Formula SNAV/MEDMAR diretta e porto-porto puro (centralizzazione)", () => {
  it("formula_snav con zona nota (ALESTE, non Sosandra): calcola pickup_hotel dalla tabella SNAV diretta", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
      hotel_zone: "Forio",
    });
    expect(result.pickup_hotel).toBe("12:30");
    expect(result.pickup_alert).toBeNull();
    // Dominio B non tocca barca_compagnia/orario_barca/porto_bruno/vessel: quei campi restano
    // responsabilita' del chiamante (es. ferry_dep_time/porto_partenza in new-booking).
    expect(result.barca_compagnia).toBeUndefined();
  });

  it("formula_medmar_napoli con zona nota: calcola pickup_hotel dalla tabella MEDMAR diretta", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_medmar_napoli",
      time: "10:35",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
      hotel_zone: "Ischia Porto",
    });
    expect(result.pickup_hotel).toBe("08:40");
  });

  it("transfer_port_hotel (porto-porto puro) con vessel che nomina SNAV: stessa tabella, stesso risultato di formula_snav per lo stesso orario/zona", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "transfer_port_hotel",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: "SNAV 14:00",
      hotel_zone: "Forio",
    });
    expect(result.pickup_hotel).toBe("12:30");
  });

  it("Formula SNAV/MEDMAR senza hotel_zone: pickup_alert esplicito, mai un pickup inventato", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "14:00",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
    });
    expect(result.pickup_hotel).toBeUndefined();
    expect(result.pickup_alert).toMatch(/zona non impostata/);
  });

  it("Formula con orario senza regola corrispondente: pickup_alert esplicito, mai un orario inventato", () => {
    const result = applyPickupCalc({
      direction: "departure",
      booking_service_kind: "formula_snav",
      time: "03:17",
      billing_party_name: "ALESTE VIAGGI",
      vessel: null,
      hotel_zone: "Forio",
    });
    expect(result.pickup_hotel).toBeUndefined();
    expect(result.pickup_alert).toMatch(/nessuna regola/i);
  });
});
