/**
 * buildInvoiceXlsx (lib/server/invoice-pdf.ts) — allegato Excel dell'estratto
 * conto, stesse righe/colonne dell'HTML. Verifica che il buffer prodotto sia
 * un vero .xlsx leggibile (non solo che la funzione non lanci), con le righe
 * e il totale attesi.
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildInvoiceXlsx, type InvoiceData } from "@/lib/server/invoice-pdf";

function sampleData(): InvoiceData {
  return {
    agencyName: "ALESTE VIAGGI",
    agencyEmail: "biglietteria@alesteviaggi.it",
    periodFrom: "2026-08-16",
    periodTo: "2026-08-24",
    invoiceId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-24T10:00:00.000Z",
    items: [
      { service_id: "svc-1", numero_pratica: "AG1", cliente_nome: "GERARDO D'ADDIO", data_servizio: "2026-08-18", tipo_servizio: "formula_medmar_napoli", importo_cents: 6600 },
      { service_id: "svc-2", numero_pratica: "AG2", cliente_nome: "LUCIANO SENESE", data_servizio: "2026-08-23", tipo_servizio: "formula_medmar_pozzuoli", importo_cents: 6000 },
    ],
    totalCents: 12600,
  };
}

describe("buildInvoiceXlsx", () => {
  it("produce un buffer .xlsx leggibile con intestazione, righe e totale corretti", () => {
    const buffer = buildInvoiceXlsx(sampleData());
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);

    const workbook = XLSX.read(buffer, { type: "buffer" });
    expect(workbook.SheetNames).toContain("Estratto conto");
    const sheet = workbook.Sheets["Estratto conto"];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    expect(rows[0]).toEqual(["Numero pratica", "Cliente", "Data servizio", "Tipo servizio", "Importo EUR"]);
    expect(rows[1]).toEqual(["AG1", "GERARDO D'ADDIO", "18/08/2026", "formula_medmar_napoli", 66]);
    expect(rows[2]).toEqual(["AG2", "LUCIANO SENESE", "23/08/2026", "formula_medmar_pozzuoli", 60]);
    // Riga totale: ultima colonna deve riflettere totalCents, non la somma
    // "ricalcolata" delle righe — cosi' se in futuro le due divergono lo
    // scarto e' visibile qui, non solo nell'email.
    expect(rows[3][3]).toBe("Totale");
    expect(rows[3][4]).toBe(126);
  });

  it("estratto conto senza righe -> intestazione + sola riga totale a zero, nessun errore", () => {
    const data = sampleData();
    data.items = [];
    data.totalCents = 0;
    const buffer = buildInvoiceXlsx(data);
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets["Estratto conto"];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
    expect(rows).toHaveLength(2);
    expect(rows[1][4]).toBe(0);
  });
});
