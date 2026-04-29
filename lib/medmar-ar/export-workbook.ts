import ExcelJS from "exceljs";
import { LEG_STATUS_LABELS, ROUTE_LABELS, TICKET_MODE_LABELS, type MedmarRoute, type TicketMode } from "@/lib/medmar-ar/types";

export type ExportTicketRow = {
  id: string;
  voucher_number: string;
  travel_date: string;
  route: string;
  pax_count: number;
  ticket_mode: string;
  outbound_time: string | null;
  return_time: string | null;
  total_price_cents: number;
  unit_price_cents: number;
  notes: string | null;
  issuing_operator_id: string | null;
  created_at: string | null;
};

export type ExportLegRow = {
  id: string;
  ticket_id: string;
  leg_type: "outbound" | "return";
  leg_time: string | null;
  leg_route: string;
  price_per_pax_cents: number;
  status: string;
  reassigned_booking_id: string | null;
  status_changed_at: string | null;
};

export type MedmarExportKind = "full" | "lost" | "recovered";

function eur(cents: number) {
  return cents / 100;
}

type RouteSummaryRow = {
  route: string;
  tickets: number;
  value: number;
  lost: number;
  lost_pct: number;
};

type OperatorSummaryRow = {
  name: string;
  tickets: number;
  rt: number;
  rt_pct: number;
  value: number;
  lost: number;
};

type LegDetailRow = {
  voucher: string;
  travel_date: string;
  route: string;
  tariff: string;
  leg_type: string;
  leg_route: string;
  leg_time: string;
  pax: number;
  value: number;
  status_changed_at: string;
  booking_id: string;
  operator: string;
};

function buildLegDetails(
  ticketList: ExportTicketRow[],
  legList: ExportLegRow[],
  operatorNames: Record<string, string>,
  status: "lost" | "reassigned" | "used",
): LegDetailRow[] {
  const ticketById = new Map(ticketList.map((ticket) => [ticket.id, ticket]));

  return legList
    .filter((leg) => leg.status === status)
    .map((leg) => {
      const ticket = ticketById.get(leg.ticket_id);
      const pax = ticket?.pax_count ?? 0;
      return {
        voucher: ticket?.voucher_number ?? leg.ticket_id,
        travel_date: ticket?.travel_date ?? "",
        route: ROUTE_LABELS[ticket?.route as MedmarRoute] ?? ticket?.route ?? "",
        tariff: extractTaggedNote(ticket?.notes, "tariffa"),
        leg_type: leg.leg_type === "outbound" ? "Andata" : "Ritorno",
        leg_route: ROUTE_LABELS[leg.leg_route as MedmarRoute] ?? leg.leg_route,
        leg_time: leg.leg_time ? String(leg.leg_time).slice(0, 5) : "",
        pax,
        value: eur(leg.price_per_pax_cents * pax),
        status_changed_at: leg.status_changed_at ? new Date(leg.status_changed_at).toLocaleString("it-IT") : "",
        booking_id: leg.reassigned_booking_id ?? "",
        operator: inputOperatorName(ticket?.issuing_operator_id ?? null, operatorNames),
      };
    })
    .sort((a, b) => a.travel_date.localeCompare(b.travel_date) || a.voucher.localeCompare(b.voucher));
}

function inputOperatorName(
  operatorId: string | null,
  operatorNames: Record<string, string>,
) {
  if (!operatorId) return "";
  return operatorNames[operatorId] ?? operatorId;
}

function extractTaggedNote(notes: string | null | undefined, tag: string) {
  if (!notes) return "";
  const match = notes.match(new RegExp(`${tag}:([^|\\n]+)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function isRecoveredLeg(leg: ExportLegRow) {
  return leg.status === "reassigned" || (leg.status === "used" && Boolean(leg.status_changed_at));
}

export function summarizeRoutes(ticketList: ExportTicketRow[], legList: ExportLegRow[]): RouteSummaryRow[] {
  const routeMap: Record<string, { tickets: number; value: number; lost: number }> = {};
  const ticketById = new Map(ticketList.map((ticket) => [ticket.id, ticket]));

  for (const ticket of ticketList) {
    if (!routeMap[ticket.route]) routeMap[ticket.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[ticket.route].tickets += 1;
    routeMap[ticket.route].value += ticket.total_price_cents;
  }

  for (const leg of legList) {
    if (leg.status !== "lost") continue;
    const ticket = ticketById.get(leg.ticket_id);
    if (!ticket) continue;
    if (!routeMap[ticket.route]) routeMap[ticket.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[ticket.route].lost += leg.price_per_pax_cents * ticket.pax_count;
  }

  return Object.entries(routeMap).map(([route, data]) => ({
    route: ROUTE_LABELS[route as MedmarRoute] ?? route,
    tickets: data.tickets,
    value: eur(data.value),
    lost: eur(data.lost),
    lost_pct: data.value > 0 ? parseFloat(((data.lost / data.value) * 100).toFixed(1)) : 0,
  }));
}

export function summarizeOperators(
  ticketList: ExportTicketRow[],
  legList: ExportLegRow[],
  operatorNames: Record<string, string>,
): OperatorSummaryRow[] {
  const opMap: Record<string, { tickets: number; rt: number; value: number; lost: number }> = {};
  const ticketById = new Map(ticketList.map((ticket) => [ticket.id, ticket]));

  for (const ticket of ticketList) {
    const operatorId = ticket.issuing_operator_id ?? "unknown";
    if (!opMap[operatorId]) opMap[operatorId] = { tickets: 0, rt: 0, value: 0, lost: 0 };
    opMap[operatorId].tickets += 1;
    opMap[operatorId].value += ticket.total_price_cents;
    if (ticket.ticket_mode === "round_trip") opMap[operatorId].rt += 1;
  }

  for (const leg of legList) {
    if (leg.status !== "lost") continue;
    const ticket = ticketById.get(leg.ticket_id);
    if (!ticket) continue;
    const operatorId = ticket.issuing_operator_id ?? "unknown";
    if (!opMap[operatorId]) opMap[operatorId] = { tickets: 0, rt: 0, value: 0, lost: 0 };
    opMap[operatorId].lost += leg.price_per_pax_cents * ticket.pax_count;
  }

  return Object.entries(opMap).map(([operatorId, data]) => ({
    name: operatorNames[operatorId] ?? operatorId,
    tickets: data.tickets,
    rt: data.rt,
    rt_pct: data.tickets > 0 ? parseFloat(((data.rt / data.tickets) * 100).toFixed(1)) : 0,
    value: eur(data.value),
    lost: eur(data.lost),
  }));
}

export function buildMedmarExportWorkbook(input: {
  ticketList: ExportTicketRow[];
  legList: ExportLegRow[];
  operatorNames: Record<string, string>;
  kind?: MedmarExportKind;
}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ITS Medmar A/R";
  wb.created = new Date();
  const kind = input.kind ?? "full";

  if (kind === "lost") {
    const wsPerse = wb.addWorksheet("Perse");
    wsPerse.columns = [
      { header: "Voucher", key: "voucher", width: 16 },
      { header: "Data viaggio", key: "travel_date", width: 14 },
      { header: "Tratta ticket", key: "route", width: 28 },
      { header: "Tariffa", key: "tariff", width: 22 },
      { header: "Tipo tratta", key: "leg_type", width: 14 },
      { header: "Tratta persa", key: "leg_route", width: 28 },
      { header: "Orario", key: "leg_time", width: 10 },
      { header: "Pax", key: "pax", width: 8 },
      { header: "Valore €", key: "value", width: 12 },
      { header: "Aggiornata il", key: "status_changed_at", width: 20 },
      { header: "Operatore", key: "operator", width: 22 },
    ];
    styleHeader(wsPerse);
    for (const row of buildLegDetails(input.ticketList, input.legList, input.operatorNames, "lost")) {
      wsPerse.addRow(row);
    }
    formatCurrencyCols(wsPerse, ["value"]);
    return wb;
  }

  if (kind === "recovered") {
    const wsRecuperate = wb.addWorksheet("Recuperate");
    wsRecuperate.columns = [
      { header: "Voucher", key: "voucher", width: 16 },
      { header: "Data viaggio", key: "travel_date", width: 14 },
      { header: "Tratta ticket", key: "route", width: 28 },
      { header: "Tariffa", key: "tariff", width: 22 },
      { header: "Tipo tratta", key: "leg_type", width: 14 },
      { header: "Tratta recuperata", key: "leg_route", width: 28 },
      { header: "Orario", key: "leg_time", width: 10 },
      { header: "Pax", key: "pax", width: 8 },
      { header: "Valore €", key: "value", width: 12 },
      { header: "Prenotazione ass.", key: "booking_id", width: 36 },
      { header: "Aggiornata il", key: "status_changed_at", width: 20 },
      { header: "Operatore", key: "operator", width: 22 },
    ];
    styleHeader(wsRecuperate);
    const recoveredLegs = input.legList.filter((leg) => isRecoveredLeg(leg));
    for (const row of buildLegDetails(input.ticketList, recoveredLegs, input.operatorNames, "reassigned")) {
      wsRecuperate.addRow(row);
    }
    for (const row of buildLegDetails(input.ticketList, recoveredLegs, input.operatorNames, "used")) {
      wsRecuperate.addRow(row);
    }
    formatCurrencyCols(wsRecuperate, ["value"]);
    return wb;
  }

  const wsBiglietti = wb.addWorksheet("Biglietti");
  wsBiglietti.columns = [
    { header: "Voucher", key: "voucher", width: 16 },
    { header: "Data viaggio", key: "date", width: 14 },
    { header: "Tratta", key: "route", width: 28 },
    { header: "Modalità", key: "mode", width: 18 },
    { header: "Pax", key: "pax", width: 6 },
    { header: "Orario andata", key: "outbound", width: 14 },
    { header: "Orario ritorno", key: "return", width: 14 },
    { header: "Prezzo/tratta", key: "unit", width: 14 },
    { header: "Totale €", key: "total", width: 12 },
    { header: "Operatore", key: "operator", width: 22 },
    { header: "Note", key: "notes", width: 30 },
    { header: "Creato il", key: "created_at", width: 18 },
  ];
  styleHeader(wsBiglietti);

  for (const ticket of input.ticketList) {
    wsBiglietti.addRow({
      voucher: ticket.voucher_number,
      date: ticket.travel_date,
      route: ROUTE_LABELS[ticket.route as MedmarRoute] ?? ticket.route,
      mode: TICKET_MODE_LABELS[ticket.ticket_mode as TicketMode] ?? ticket.ticket_mode,
      pax: ticket.pax_count,
      outbound: ticket.outbound_time ? String(ticket.outbound_time).slice(0, 5) : "",
      return: ticket.return_time ? String(ticket.return_time).slice(0, 5) : "",
      unit: eur(ticket.unit_price_cents),
      total: eur(ticket.total_price_cents),
      operator: input.operatorNames[ticket.issuing_operator_id ?? ""] ?? ticket.issuing_operator_id ?? "",
      notes: ticket.notes ?? "",
      created_at: ticket.created_at ? new Date(ticket.created_at).toLocaleString("it-IT") : "",
    });
  }
  formatCurrencyCols(wsBiglietti, ["unit", "total"]);
  addTotalsRow(wsBiglietti, { total: input.ticketList.reduce((sum, ticket) => sum + ticket.total_price_cents, 0) / 100 });

  const wsTratte = wb.addWorksheet("Tratte");
  wsTratte.columns = [
    { header: "Biglietto", key: "voucher", width: 16 },
    { header: "Data viaggio", key: "date", width: 14 },
    { header: "Tipo tratta", key: "leg_type", width: 14 },
    { header: "Tratta leg", key: "leg_route", width: 28 },
    { header: "Orario", key: "leg_time", width: 10 },
    { header: "Prezzo/pax", key: "price", width: 12 },
    { header: "Stato", key: "status", width: 26 },
    { header: "Prenotazione ass.", key: "booking_id", width: 36 },
    { header: "Stato aggiornato", key: "changed_at", width: 18 },
  ];
  styleHeader(wsTratte);

  const ticketById = new Map(input.ticketList.map((ticket) => [ticket.id, ticket]));
  for (const leg of input.legList) {
    const ticket = ticketById.get(leg.ticket_id);
    wsTratte.addRow({
      voucher: ticket?.voucher_number ?? leg.ticket_id,
      date: ticket?.travel_date ?? "",
      leg_type: leg.leg_type === "outbound" ? "Andata" : "Ritorno",
      leg_route: leg.leg_route,
      leg_time: leg.leg_time ? String(leg.leg_time).slice(0, 5) : "",
      price: eur(leg.price_per_pax_cents),
      status: LEG_STATUS_LABELS[leg.status as keyof typeof LEG_STATUS_LABELS] ?? leg.status,
      booking_id: leg.reassigned_booking_id ?? "",
      changed_at: leg.status_changed_at ? new Date(leg.status_changed_at).toLocaleString("it-IT") : "",
    });
  }
  formatCurrencyCols(wsTratte, ["price"]);

  const wsRiepilogo = wb.addWorksheet("Riepilogo tratta");
  wsRiepilogo.columns = [
    { header: "Tratta", key: "route", width: 28 },
    { header: "Biglietti", key: "tickets", width: 12 },
    { header: "Valore totale", key: "value", width: 16 },
    { header: "Perso €", key: "lost", width: 14 },
    { header: "% perso", key: "lost_pct", width: 10 },
  ];
  styleHeader(wsRiepilogo);
  for (const row of summarizeRoutes(input.ticketList, input.legList)) wsRiepilogo.addRow(row);
  formatCurrencyCols(wsRiepilogo, ["value", "lost"]);

  const wsOperatori = wb.addWorksheet("Per operatore");
  wsOperatori.columns = [
    { header: "Operatore", key: "name", width: 24 },
    { header: "Biglietti", key: "tickets", width: 12 },
    { header: "A/R emessi", key: "rt", width: 12 },
    { header: "% A/R", key: "rt_pct", width: 10 },
    { header: "Valore €", key: "value", width: 14 },
    { header: "Perso €", key: "lost", width: 14 },
  ];
  styleHeader(wsOperatori);
  for (const row of summarizeOperators(input.ticketList, input.legList, input.operatorNames)) wsOperatori.addRow(row);
  formatCurrencyCols(wsOperatori, ["value", "lost"]);

  return wb;
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4338CA" } };
  row.alignment = { vertical: "middle" };
  row.height = 20;
  row.commit();
}

function formatCurrencyCols(ws: ExcelJS.Worksheet, keys: string[]) {
  const colIndexes = keys.map((key) => {
    const col = ws.columns.find((column) => column.key === key);
    return col ? ws.getColumn(key).number : null;
  }).filter(Boolean);

  ws.eachRow((row, index) => {
    if (index === 1) return;
    for (const colIndex of colIndexes) {
      row.getCell(colIndex!).numFmt = '#,##0.00 "€"';
    }
  });
}

function addTotalsRow(ws: ExcelJS.Worksheet, totals: Record<string, number>) {
  if (ws.rowCount < 2) return;
  const totalRow = ws.addRow({});
  totalRow.font = { bold: true };
  for (const [key, value] of Object.entries(totals)) {
    const col = ws.getColumn(key);
    if (!col) continue;
    const cell = totalRow.getCell(col.number);
    cell.value = value;
    cell.numFmt = '#,##0.00 "€"';
  }
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } };
  totalRow.commit();
}
