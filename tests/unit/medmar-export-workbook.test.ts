import { describe, expect, it } from "vitest";
import { buildMedmarExportWorkbook, summarizeOperators, summarizeRoutes, type ExportLegRow, type ExportTicketRow } from "@/lib/medmar-ar/export-workbook";

const tickets: ExportTicketRow[] = [
  {
    id: "t1",
    voucher_number: "V-001",
    travel_date: "2026-04-10",
    route: "pozzuoli_ischia",
    pax_count: 2,
    ticket_mode: "round_trip",
    outbound_time: "09:30",
    return_time: "18:00",
    total_price_cents: 4100,
    unit_price_cents: 1025,
    notes: "cliente vip",
    issuing_operator_id: "op-1",
    created_at: "2026-04-10T08:00:00.000Z",
  },
  {
    id: "t2",
    voucher_number: "V-002",
    travel_date: "2026-04-10",
    route: "napoli_ischia",
    pax_count: 1,
    ticket_mode: "single_outbound",
    outbound_time: "13:00",
    return_time: null,
    total_price_cents: 1370,
    unit_price_cents: 1370,
    notes: null,
    issuing_operator_id: "op-2",
    created_at: "2026-04-10T09:00:00.000Z",
  },
];

const legs: ExportLegRow[] = [
  {
    id: "l1",
    ticket_id: "t1",
    leg_type: "return",
    leg_time: "18:00",
    leg_route: "Ischia -> Pozzuoli",
    price_per_pax_cents: 1025,
    status: "lost",
    reassigned_booking_id: null,
    status_changed_at: "2026-04-10T20:00:00.000Z",
  },
  {
    id: "l2",
    ticket_id: "t2",
    leg_type: "outbound",
    leg_time: "13:00",
    leg_route: "Napoli -> Ischia",
    price_per_pax_cents: 1370,
    status: "used",
    reassigned_booking_id: null,
    status_changed_at: "2026-04-10T14:00:00.000Z",
  },
];

describe("summarizeRoutes", () => {
  it("calcola valore perso e percentuale per tratta", () => {
    const rows = summarizeRoutes(tickets, legs);
    const pozzuoli = rows.find((row) => row.route === "Pozzuoli → Ischia");

    expect(pozzuoli).toMatchObject({
      tickets: 1,
      value: 41,
      lost: 20.5,
      lost_pct: 50,
    });
  });
});

describe("summarizeOperators", () => {
  it("raggruppa per operatore con percentuale A/R e perso", () => {
    const rows = summarizeOperators(tickets, legs, { "op-1": "Mario", "op-2": "Lucia" });
    const mario = rows.find((row) => row.name === "Mario");
    const lucia = rows.find((row) => row.name === "Lucia");

    expect(mario).toMatchObject({ tickets: 1, rt: 1, rt_pct: 100, value: 41, lost: 20.5 });
    expect(lucia).toMatchObject({ tickets: 1, rt: 0, rt_pct: 0, value: 13.7, lost: 0 });
  });
});

describe("buildMedmarExportWorkbook", () => {
  it("crea i quattro fogli attesi con i totali principali", () => {
    const workbook = buildMedmarExportWorkbook({
      ticketList: tickets,
      legList: legs,
      operatorNames: { "op-1": "Mario", "op-2": "Lucia" },
    });

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "Biglietti",
      "Tratte",
      "Riepilogo tratta",
      "Per operatore",
    ]);

    const wsBiglietti = workbook.getWorksheet("Biglietti");
    const wsRiepilogo = workbook.getWorksheet("Riepilogo tratta");
    const wsOperatori = workbook.getWorksheet("Per operatore");

    expect(wsBiglietti.getRow(2).getCell(1).value).toBe("V-001");
    expect(wsBiglietti.getRow(wsBiglietti.rowCount).getCell(9).value).toBe(54.7);
    expect(wsRiepilogo.getRow(2).getCell(1).value).toBe("Pozzuoli → Ischia");
    expect(wsRiepilogo.getRow(2).getCell(5).value).toBe(50);
    expect(wsOperatori.getRow(2).getCell(1).value).toBe("Mario");
    expect(wsOperatori.getRow(2).getCell(6).value).toBe(20.5);
  });
});
