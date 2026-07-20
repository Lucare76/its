import { describe, expect, it } from "vitest";
import { latestStatus, normalizePricingCategory, recipientCountryCode } from "@/lib/server/whatsapp/costs";
import { parseMetaCsv } from "@/app/api/ops/whatsapp-costs/reconcile/route";

describe("whatsapp cost helpers", () => {
  it("determina il paese dal prefisso del destinatario", () => {
    expect(recipientCountryCode("+39 333 1234567")).toBe("IT");
    expect(recipientCountryCode("0044207946000")).toBe("GB");
    expect(recipientCountryCode("+1 212 555 0100")).toBe("US");
  });

  it("mantiene la progressione stato senza tornare indietro", () => {
    expect(latestStatus("sent", "delivered")).toBe("delivered");
    expect(latestStatus("delivered", "read")).toBe("read");
    expect(latestStatus("read", "delivered")).toBe("read");
  });

  it("normalizza categorie pricing Meta", () => {
    expect(normalizePricingCategory(" Utility ")).toBe("utility");
    expect(normalizePricingCategory("")).toBeNull();
  });
});

describe("parseMetaCsv", () => {
  it("gestisce report WhatsApp Manager con righe informative, euro e virgola decimale", () => {
    const csv = [
      "Report costi WhatsApp",
      "Data;Categoria di prezzo;Tipo di prezzo;Volume;Costi stimati",
      "01/07/2026;Utility;Paid;1.234;67,55 €",
      "01/07/2026;Utility;Paid;1.234;67,55 €",
      "02/07/2026;Servizio;Free;477;0,00 €",
    ].join("\n");

    const parsed = parseMetaCsv(csv);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.duplicates).toBe(1);
    expect(parsed.ignored.length).toBeGreaterThan(0);
    expect(parsed.rows[0]).toMatchObject({
      date: "2026-07-01",
      pricing_category: "utility",
      pricing_type: "paid",
      volume: 1234,
      cost: 67.55,
    });
  });
});
