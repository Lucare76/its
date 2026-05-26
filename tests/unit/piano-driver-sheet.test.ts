/**
 * Test Regola 5: Foglio singolo autista
 *
 * Verifica la logica di formattazione del foglio autista.
 * La route GET è testata con typecheck; qui testiamo le utility pure esportate.
 */
import { describe, expect, it } from "vitest";
import { customerFullName } from "@/app/api/ops/piano-giorno/driver-sheet/route";

describe("customerFullName", () => {
  it("usa nome e cognome quando presenti", () => {
    expect(customerFullName({
      customer_name: "ROSSI MARIO",
      customer_first_name: "Mario",
      customer_last_name: "Rossi",
    })).toBe("Mario Rossi");
  });

  it("usa solo il nome se il cognome è null", () => {
    expect(customerFullName({
      customer_name: "MARIO",
      customer_first_name: "Mario",
      customer_last_name: null,
    })).toBe("Mario");
  });

  it("fallback a customer_name quando first/last sono entrambi null", () => {
    expect(customerFullName({
      customer_name: "FAMILIA ROSSI",
      customer_first_name: null,
      customer_last_name: null,
    })).toBe("FAMILIA ROSSI");
  });

  it("fallback a customer_name quando first/last sono assenti (undefined)", () => {
    expect(customerFullName({ customer_name: "BOOKING TEST" })).toBe("BOOKING TEST");
  });

  it("ignora stringa vuota come first_name (filter Boolean)", () => {
    expect(customerFullName({
      customer_name: "BIANCHI LUCA",
      customer_first_name: "",
      customer_last_name: "Bianchi",
    })).toBe("Bianchi");
  });
});
