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

  it("formula_medmar_napoli / formula_snav / navetta / excursion non triggerano il calcolo (no-op)", () => {
    for (const kind of ["formula_medmar_napoli", "formula_medmar_pozzuoli", "formula_snav", "navetta", "shuttle_hotel", "excursion", "transfer_port_hotel", "transfer_hotel_hotel", "private_island"]) {
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
