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
    expect(parsed.rows[1]).toMatchObject({
      pricing_category: "service",
    });
  });

  it("gestisce il CSV PMP esportato da Meta con mesi italiani", () => {
    const csv = [
      "\"I dati \\\"Volumi\\\" e \\\"Costi stimati\\\" sono approssimativi.\"",
      "\"\"",
      "\"Data  (Fuso orario di Vienna)\",\"Categoria di prezzo\",\"Tipo di prezzo\",\"Volume\",\"Costi stimati\"",
      "\"11 lug 2026\",\"Servizio\",\"Assistenza clienti gratis\",10,\"â‚¬ 0,00\"",
      "\"11 lug 2026\",\"Utility\",\"A pagamento\",67,\"â‚¬ 1,66\"",
    ].join("\n");

    const parsed = parseMetaCsv(csv);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({
      date: "2026-07-11",
      pricing_category: "service",
      pricing_type: "assistenza clienti gratis",
      volume: 10,
      cost: 0,
    });
    expect(parsed.rows[1]).toMatchObject({
      date: "2026-07-11",
      pricing_category: "utility",
      pricing_type: "a pagamento",
      volume: 67,
      cost: 1.66,
    });
  });
});
