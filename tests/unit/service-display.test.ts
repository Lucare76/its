import { describe, expect, it } from "vitest";
import { getDepartureTransportReference } from "@/lib/service-display";

describe("getDepartureTransportReference", () => {
  it("usa il numero treno di ritorno quando esiste", () => {
    expect(getDepartureTransportReference({
      train_arrival_number: "ITALO 8903",
      train_departure_number: "ITALO 8938",
      transport_code: "ITALO 8903 / ITALO 8938",
      vessel: "fallback",
    })).toBe("ITALO 8938");
  });

  it("se il campo legacy contiene andata e ritorno separati da slash mostra solo il ritorno", () => {
    expect(getDepartureTransportReference({ transport_code: "ITALO 8903 / ITALO 8938" })).toBe("ITALO 8938");
  });

  it("mantiene il riferimento singolo quando non e' una coppia andata/ritorno", () => {
    expect(getDepartureTransportReference({ transport_code: "ITALO 8938" })).toBe("ITALO 8938");
  });
});
