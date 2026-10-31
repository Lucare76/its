import { expect, it } from "vitest";
import {
  statementData,
  statementItems,
  statementSchema,
} from "@/lib/server/agency-statements";
it("keeps the authoritative agreed amount, payment and residual inputs unchanged", () => {
  const row = {
    id: "test",
    agency_name: "Test",
    invoice_number: "EC-2026-00001",
    date_basis: "arrival",
    period_from: "2026-10-25",
    period_to: "2026-10-31",
    created_at: "2026-10-31",
    total_cents: 26200,
    paid_cents: 10000,
    waived_cents: 0,
    invoice_data: [
      {
        service_id: "s",
        numero_pratica: "26/014732",
        cliente_nome: "Synthetic",
        data_servizio: "2026-10-31",
        tipo_servizio: "formula_medmar_pozzuoli",
        importo_cents: 26200,
      },
    ],
  } as Parameters<typeof statementData>[0];
  const data = statementData(row);
  expect(data.totalCents).toBe(26200);
  expect(data.paidCents).toBe(10000);
  expect(data.items[0].numero_pratica).toBe("26/014732");
});
it("active cancellation penalty renders as a penalty, not a full transfer", () => {
  expect(
    statementItems([
      {
        service_id: "s",
        penalty_id: "p",
        numero_pratica: "n",
        cliente_nome: "Synthetic",
        data_servizio: "2026-10-31",
        tipo_servizio: "formula_medmar_pozzuoli",
        importo_cents: 3000,
      },
    ])[0].descrizione_servizio,
  ).toBe("Penale cancellazione");
});
it("rejects invalid calendar dates and reversed period", () => {
  expect(
    statementSchema.safeParse({
      agency_name: "Test",
      period_from: "2026-02-30",
      period_to: "2026-03-01",
    }).success,
  ).toBe(false);
  expect(
    statementSchema.safeParse({
      agency_name: "Test",
      period_from: "2026-11-01",
      period_to: "2026-10-31",
    }).success,
  ).toBe(false);
});
