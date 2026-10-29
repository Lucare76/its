import { describe, expect, it } from "vitest";
import { previousAgencyInvoicePeriod, scheduledAgencyInvoiceId } from "@/lib/server/agency-email-schedule";

describe("Periodi degli estratti conto automatici", () => {
  it.each([
    ["2026-02-01", "2026-01-01", "2026-01-31"],
    ["2026-03-01", "2026-02-01", "2026-02-28"],
    ["2028-03-01", "2028-02-01", "2028-02-29"],
    ["2026-05-01", "2026-04-01", "2026-04-30"],
    ["2027-01-01", "2026-12-01", "2026-12-31"],
  ])("il mensile eseguito il %s copre l'intero mese precedente", (today, from, to) => {
    expect(previousAgencyInvoicePeriod("monthly", today)).toEqual({ periodFrom: from, periodTo: to });
  });

  it.each([
    ["weekly", "2026-10-22"], ["biweekly", "2026-10-15"],
  ])("%s conserva la finestra prevista e non include il giorno corrente", (cadence, from) => {
    expect(previousAgencyInvoicePeriod(cadence, "2026-10-29")).toEqual({ periodFrom: from, periodTo: "2026-10-28" });
  });
});

describe("Identità persistente di un estratto automatico", () => {
  it("lo stesso tenant, agenzia e periodo producono sempre la stessa UUID", () => {
    const args = ["tenant-a", "agency-a", "2026-10-01", "2026-10-31"] as const;
    expect(scheduledAgencyInvoiceId(...args)).toBe(scheduledAgencyInvoiceId(...args));
    expect(scheduledAgencyInvoiceId(...args)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("separa tenant, agenzie e periodi senza collisioni da concatenazione", () => {
    const ids = [
      ["a", "bc", "2026-10-01", "2026-10-31"],
      ["ab", "c", "2026-10-01", "2026-10-31"],
      ["a", "bc", "2026-11-01", "2026-11-30"],
      ["a", "other", "2026-10-01", "2026-10-31"],
    ].map(([tenant, agency, from, to]) => scheduledAgencyInvoiceId(tenant, agency, from, to));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
