import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { buildInvoiceServiceDescription, formatInvoiceServiceDescription } from "@/lib/invoice-service-label";
import { buildInvoiceXlsx, generateInvoiceHtml, generateInvoicePrintHtml, type InvoiceData } from "@/lib/server/invoice-pdf";

describe("Descrizione servizio estratti conto", () => {
  it.each([
    ["transfer_train_hotel", "Transfer Stazione"],
    ["transfer_airport_hotel", "Transfer Aeroporto"],
    ["formula_snav", "Formula SNAV"],
    ["formula_medmar_pozzuoli", "Formula MEDMAR Pozzuoli"],
    ["transfer_port_hotel", "Transfer Porto / Hotel"],
  ])("mostra i pax anche per %s", (kind, label) => {
    expect(formatInvoiceServiceDescription({ tipo_servizio: kind, pax: 2 })).toBe(`${label} - 2 pax`);
  });

  it("bus: città salvata nella descrizione e pax della singola riga", () => {
    const description = buildInvoiceServiceDescription({ booking_service_kind: "bus_city_hotel", bus_stop_name: " Milano ", vessel: "MEDMAR" });
    expect(formatInvoiceServiceDescription({ tipo_servizio: "bus_city_hotel", descrizione_servizio: description, pax: 2 })).toBe("Transfer Bus Milano - 2 pax");
    expect(formatInvoiceServiceDescription({ tipo_servizio: "bus_city_hotel", descrizione_servizio: description, pax: 1 })).toBe("Transfer Bus Milano - 1 pax");
  });

  it.each([null, 0, -1, 1.5])("non inventa il numero di passeggeri quando è invalido (%s)", (pax) => {
    expect(formatInvoiceServiceDescription({ tipo_servizio: "transfer_train_hotel", pax })).toBe("Transfer Stazione - pax non indicati");
  });

  it.each([
    ["formula_snav", "Formula SNAV"],
    ["formula_medmar_napoli", "Formula MEDMAR Napoli"],
    ["formula_medmar_pozzuoli", "Formula MEDMAR Pozzuoli"],
    ["transfer_train_hotel", "Transfer Stazione"],
    ["transfer_station_hotel", "Transfer Stazione"],
    ["transfer_airport_hotel", "Transfer Aeroporto"],
    ["bus_city_hotel", "Transfer Bus"],
  ])("traduce %s senza perdere la formula", (kind, label) => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: kind })).toBe(label);
  });

  it.each(["SNAV", "MEDMAR"])("riconosce il pacchetto importato %s con biglietti inclusi", (carrier) => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_port_hotel", transport_code: `${carrier} / ${carrier}`, include_ferry_tickets: true }))
      .toBe(`Formula ${carrier}`);
  });

  it("legge la compagnia nei dati strutturati del PDF senza inventare il porto", () => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_port_hotel", include_ferry_tickets: true,
      ferry_details: { carrier_company: "Medmar", return_mainland_port: "pozzuoli" } })).toBe("Formula MEDMAR");
  });

  it.each([false, null, undefined])("la sola compagnia non prova l'acquisto della formula (%s)", (tickets) => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_port_hotel", vessel: "SNAV", include_ferry_tickets: tickets }))
      .toBe("Formula SNAV");
  });

  it("non attribuisce la formula se le compagnie sono discordanti", () => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_port_hotel", vessel: "SNAV", transport_code: "MEDMAR", include_ferry_tickets: true }))
      .toBe("Transfer Porto / Hotel · MEDMAR / SNAV");
  });

  it("una formula esplicita prevale sui riferimenti operativi discordanti", () => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "formula_snav", vessel: "MEDMAR", include_ferry_tickets: true })).toBe("Formula SNAV");
  });

  it("un transfer stazione con nave non diventa una formula porto", () => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_train_hotel", vessel: "MEDMAR", include_ferry_tickets: true }))
      .toBe("Transfer Stazione · MEDMAR");
  });

  it.each([null, [], "SNAV", { arbitrary_note: "MEDMAR" }])("ignora dati nave mancanti o non pertinenti (%s)", (details) => {
    expect(buildInvoiceServiceDescription({ booking_service_kind: "transfer_port_hotel", ferry_details: details, include_ferry_tickets: true }))
      .toBe("Transfer Porto / Hotel");
  });

  it("non legge importi o note libere per indovinare la formula", () => {
    const service = { booking_service_kind: "transfer_port_hotel", notes: "Formula SNAV oppure MEDMAR", source_total_amount_cents: 6600 };
    expect(buildInvoiceServiceDescription(service)).toBe("Transfer Porto / Hotel");
  });

  it("mantiene la descrizione salvata e rende leggibili gli estratti precedenti", () => {
    expect(formatInvoiceServiceDescription({ tipo_servizio: "transfer_port_hotel", descrizione_servizio: "Formula MEDMAR" })).toBe("Formula MEDMAR");
    expect(formatInvoiceServiceDescription({ tipo_servizio: "formula_snav" })).toBe("Formula SNAV");
    expect(formatInvoiceServiceDescription({ tipo_servizio: "transfer_port_hotel" })).toBe("Transfer Porto / Hotel");
  });

  it("email, stampa e vero Excel mostrano le stesse formule con importi invariati", () => {
    const data: InvoiceData = {
      agencyName: "AGENZIA TEST", periodFrom: "2026-10-01", periodTo: "2026-10-15", invoiceId: "invoice-test", createdAt: "2026-10-29T10:00:00Z",
      items: [
        { service_id: "a", numero_pratica: "TEST-1", cliente_nome: "CLIENTE TEST", data_servizio: "2026-10-01", tipo_servizio: "transfer_port_hotel", descrizione_servizio: "Formula SNAV", pax: 2, importo_cents: 1400 },
        { service_id: "b", numero_pratica: "TEST-2", cliente_nome: "CLIENTE TEST", data_servizio: "2026-10-02", tipo_servizio: "formula_medmar_napoli", pax: 3, importo_cents: 6600 },
      ], totalCents: 8000,
    };
    for (const html of [generateInvoiceHtml(data), generateInvoicePrintHtml(data)]) {
      expect(html).toContain("Formula SNAV - 2 pax");
      expect(html).toContain("Formula MEDMAR Napoli - 3 pax");
      expect(html).not.toContain("transfer_port_hotel");
      expect(html).not.toContain("formula_medmar_napoli");
      expect(html).toContain("80,00");
    }
    const book = XLSX.read(buildInvoiceXlsx(data), { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(book.Sheets["Estratto conto"], { header: 1 }) as unknown[][];
    expect(rows[1].slice(3)).toEqual(["Formula SNAV - 2 pax", 14]);
    expect(rows[2].slice(3)).toEqual(["Formula MEDMAR Napoli - 3 pax", 66]);
    expect(rows[3][4]).toBe(80);
    // Rendering must not modify the original saved snapshot.
    expect(data.items[0].tipo_servizio).toBe("transfer_port_hotel");
  });

  it("la descrizione non può inserire HTML nell'email o nella stampa", () => {
    const data: InvoiceData = { agencyName: "TEST", periodFrom: "2026-10-01", periodTo: "2026-10-01", invoiceId: "test", createdAt: "2026-10-29", totalCents: 0,
      items: [{ service_id: "a", numero_pratica: "T1", cliente_nome: "TEST", data_servizio: "2026-10-01", tipo_servizio: "transfer", descrizione_servizio: '<img src=x onerror="alert(1)">', importo_cents: 0 }] };
    for (const html of [generateInvoiceHtml(data), generateInvoicePrintHtml(data)]) {
      expect(html).not.toContain('<img src=x');
      expect(html).toContain("&lt;img src=x onerror=&quot;");
    }
  });
});
