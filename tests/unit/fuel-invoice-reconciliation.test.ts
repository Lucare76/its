import { describe, expect, it } from "vitest";
import { fuelCanLink, parseFuelInvoiceRows, proposeFuelMatch } from "@/lib/server/fuel-invoice-reconciliation";

describe("fuel invoice reconciliation", () => {
  it("parses ENI purchases but excludes invoice fees and totals", () => {
    expect(parseFuelInvoiceRows([
      ["22.01.26", "13:58", "00900121", "018131", "ISCHIA", "27102011 DIES", "373.225", "81,63", "1,764", "144,00", "SELF", "144,00"],
      ["FEE SICUREZZA", "8,54"],
    ], "ENI")).toEqual([{ date: "2026-01-22", station: "ISCHIA", liters: 81.63, amount: 144, reference: "00900121" }]);
  });

  it("parses UTA station details and excludes ICT commissions", () => {
    expect(parseFuelInvoiceRows([
      ["13.04.2026 Diesel ESSO,Scudillo Nord", "933179", "ITA", "00001875", "0", "61,61 LTR", "0,00 RC_N", "EUR", "1,8025", "111,05"],
      ["13.04.2026 Commissione ICT", "90501", "DEU", "1,00 PCE", "EUR", "0,09"],
    ], "UTA")).toEqual([{ date: "2026-04-13", station: "ESSO,Scudillo Nord", liters: 61.61, amount: 111.05, reference: "00001875" }]);
  });

  it("keeps supplier-specific one-euro discrepancy and rejects ambiguous candidates", () => {
    const line = { date: "2026-04-13", station: "ESSO,Scudillo Nord", liters: 61.61, amount: 62, reference: "00001875" };
    const manual = { id: "one", fuel_date: line.date, station: "Scudillo Nord", liters: 61.61, cost: 61, invoice_supplier: "UTA" };
    expect(proposeFuelMatch(line, [manual], "UTA")).toMatchObject({ status: "candidate", amountDifference: 1, litersDifference: 0 });
    expect(proposeFuelMatch(line, [{ ...manual, invoice_supplier: "ENI" }], "UTA")).toMatchObject({ status: "missing" });
    expect(proposeFuelMatch(line, [manual, { ...manual, id: "two" }], "UTA")).toMatchObject({ status: "ambiguous" });
    expect(proposeFuelMatch(line, [manual], "UTA", new Set(["one"]))).toMatchObject({ status: "missing" });
  });

  it("confronta il netto UTA a quattro decimali con i centesimi della fattura", () => {
    const invoice = { date: "2026-11-23", station: "Q8 Teano", liters: 25, amount: 40.98, reference: "12345678" };
    const manual = { id: "uta-1", fuel_date: invoice.date, station: invoice.station,
      liters: invoice.liters, cost: 40.9836, invoice_supplier: "UTA" };
    expect(proposeFuelMatch(invoice, [manual], "UTA")).toMatchObject({ status: "candidate", amountDifference: 0 });
  });

  it("propone i luoghi ENI descritti diversamente soltanto con data, litri e importo compatibili", () => {
    const line = { date: "2026-10-19", station: "DUE CARRARE", liters: 216.9, amount: 475.01, reference: "00914931" };
    const row = { id: "qr-1", fuel_date: line.date, station: "San pelagico Eni ovest", liters: 216.9, cost: 475, invoice_supplier: "ENI" };
    expect(proposeFuelMatch(line, [row], "ENI")).toMatchObject({ status: "candidate", stationMismatch: true, amountDifference: 0.01 });
    expect(fuelCanLink(line, row, "ENI")).toBe(true);
    expect(fuelCanLink(line, { ...row, invoice_supplier: "UTA" }, "ENI")).toBe(false);
    expect(fuelCanLink(line, { ...row, fuel_date: "2026-10-20" }, "ENI")).toBe(false);
    expect(fuelCanLink(line, { ...row, liters: 216.89 }, "ENI")).toBe(false);
    expect(fuelCanLink(line, { ...row, cost: 475.04 }, "ENI")).toBe(false);
    expect(proposeFuelMatch(line, [row, { ...row, id: "qr-2" }], "ENI")).toMatchObject({ status: "ambiguous" });
  });
});
