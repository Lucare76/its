import { describe, expect, it } from "vitest";
import { normalizeQuoteItems } from "@/lib/server/service-quote-items";

describe("service quote free-text casing", () => {
  it("preserves the operator casing while trimming only outer whitespace", () => {
    const [item] = normalizeQuoteItems([{
      item_type: "service",
      price_mode: "total",
      title: "  Transfer Mario Rossi  ",
      description: "  Cliente chiede camera vista mare e arrivo anticipato.  ",
      service_type: "custom",
      hotel_name: "  Hotel Terme President  ",
      hotel_address: "  Via Roma 10  ",
      luggage_notes: "  Bagaglio a Mano  ",
      special_requests: "  note cliente da verificare  ",
      price_notes: "  Prezzo Speciale  ",
      pax: 2,
      unit_price_cents: 10000,
    }]);

    expect(item.title).toBe("Transfer Mario Rossi");
    expect(item.description).toBe("Cliente chiede camera vista mare e arrivo anticipato.");
    expect(item.hotel_name).toBe("Hotel Terme President");
    expect(item.hotel_address).toBe("Via Roma 10");
    expect(item.luggage_notes).toBe("Bagaglio a Mano");
    expect(item.special_requests).toBe("note cliente da verificare");
    expect(item.price_notes).toBe("Prezzo Speciale");
  });
});
