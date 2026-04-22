/**
 * GET /api/medmar-ar/export?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 * Export Excel multi-foglio: Biglietti, Tratte, Statistiche
 */
import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ROUTE_LABELS, TICKET_MODE_LABELS, LEG_STATUS_LABELS, type MedmarRoute, type TicketMode } from "@/lib/medmar-ar/types";

export const runtime = "nodejs";

function eur(cents: number) {
  return cents / 100;
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request);
  if (auth instanceof NextResponse) return auth;
  const { admin, membership } = auth;
  const tenantId = membership.tenant_id;

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  const firstOfYear = `${today.slice(0, 4)}-01-01`;
  const dateFrom = url.searchParams.get("date_from") ?? firstOfYear;
  const dateTo = url.searchParams.get("date_to") ?? today;

  const { data: tickets } = await (admin as any)
    .from("medmar_ar_tickets")
    .select("id, voucher_number, travel_date, route, pax_count, ticket_mode, outbound_time, return_time, total_price_cents, unit_price_cents, notes, issuing_operator_id, created_at")
    .eq("tenant_id", tenantId)
    .gte("travel_date", dateFrom)
    .lte("travel_date", dateTo)
    .eq("is_test_data", false)
    .order("travel_date");

  const ticketList: any[] = tickets ?? [];
  const ticketIds = ticketList.map((t: any) => t.id);

  let legList: any[] = [];
  if (ticketIds.length > 0) {
    const { data: legs } = await (admin as any)
      .from("medmar_ar_ticket_legs")
      .select("id, ticket_id, leg_type, leg_time, leg_route, price_per_pax_cents, status, reassigned_booking_id, status_changed_at")
      .eq("tenant_id", tenantId)
      .in("ticket_id", ticketIds);
    legList = legs ?? [];
  }

  const operatorIds = [...new Set(ticketList.map((t: any) => t.issuing_operator_id).filter(Boolean))];
  let operatorNames: Record<string, string> = {};
  if (operatorIds.length > 0) {
    const { data: members } = await (admin as any)
      .from("memberships")
      .select("user_id, full_name")
      .eq("tenant_id", tenantId)
      .in("user_id", operatorIds);
    for (const m of members ?? []) operatorNames[m.user_id] = m.full_name ?? m.user_id;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = "ITS Medmar A/R";
  wb.created = new Date();

  // ── Foglio 1: Biglietti ──────────────────────────────────────────────────────
  const wsBiglietti = wb.addWorksheet("Biglietti");
  wsBiglietti.columns = [
    { header: "Voucher",         key: "voucher",    width: 16 },
    { header: "Data viaggio",    key: "date",       width: 14 },
    { header: "Tratta",          key: "route",      width: 28 },
    { header: "Modalità",        key: "mode",       width: 18 },
    { header: "Pax",             key: "pax",        width: 6 },
    { header: "Orario andata",   key: "outbound",   width: 14 },
    { header: "Orario ritorno",  key: "return",     width: 14 },
    { header: "Prezzo/tratta",   key: "unit",       width: 14 },
    { header: "Totale €",        key: "total",      width: 12 },
    { header: "Operatore",       key: "operator",   width: 22 },
    { header: "Note",            key: "notes",      width: 30 },
    { header: "Creato il",       key: "created_at", width: 18 },
  ];

  styleHeader(wsBiglietti);

  for (const t of ticketList) {
    wsBiglietti.addRow({
      voucher:    t.voucher_number,
      date:       t.travel_date,
      route:      ROUTE_LABELS[t.route as MedmarRoute] ?? t.route,
      mode:       TICKET_MODE_LABELS[t.ticket_mode as TicketMode] ?? t.ticket_mode,
      pax:        t.pax_count,
      outbound:   t.outbound_time ? String(t.outbound_time).slice(0, 5) : "",
      return:     t.return_time ? String(t.return_time).slice(0, 5) : "",
      unit:       eur(t.unit_price_cents),
      total:      eur(t.total_price_cents),
      operator:   operatorNames[t.issuing_operator_id] ?? t.issuing_operator_id ?? "",
      notes:      t.notes ?? "",
      created_at: t.created_at ? new Date(t.created_at).toLocaleString("it-IT") : "",
    });
  }

  formatCurrencyCols(wsBiglietti, ["unit", "total"]);
  addTotalsRow(wsBiglietti, { total: ticketList.reduce((s, t) => s + t.total_price_cents, 0) / 100 });

  // ── Foglio 2: Tratte ─────────────────────────────────────────────────────────
  const wsTrotte = wb.addWorksheet("Tratte");
  wsTrotte.columns = [
    { header: "Biglietto",        key: "voucher",    width: 16 },
    { header: "Data viaggio",     key: "date",       width: 14 },
    { header: "Tipo tratta",      key: "leg_type",   width: 14 },
    { header: "Tratta leg",       key: "leg_route",  width: 28 },
    { header: "Orario",           key: "leg_time",   width: 10 },
    { header: "Prezzo/pax",       key: "price",      width: 12 },
    { header: "Stato",            key: "status",     width: 26 },
    { header: "Prenotazione ass.", key: "booking_id", width: 36 },
    { header: "Stato aggiornato", key: "changed_at", width: 18 },
  ];

  styleHeader(wsTrotte);

  const ticketById = new Map(ticketList.map((t: any) => [t.id, t]));
  for (const l of legList) {
    const t = ticketById.get(l.ticket_id);
    wsTrotte.addRow({
      voucher:    t?.voucher_number ?? l.ticket_id,
      date:       t?.travel_date ?? "",
      leg_type:   l.leg_type === "outbound" ? "Andata" : "Ritorno",
      leg_route:  l.leg_route,
      leg_time:   l.leg_time ? String(l.leg_time).slice(0, 5) : "",
      price:      eur(l.price_per_pax_cents),
      status:     LEG_STATUS_LABELS[l.status as keyof typeof LEG_STATUS_LABELS] ?? l.status,
      booking_id: l.reassigned_booking_id ?? "",
      changed_at: l.status_changed_at ? new Date(l.status_changed_at).toLocaleString("it-IT") : "",
    });
  }

  formatCurrencyCols(wsTrotte, ["price"]);

  // ── Foglio 3: Riepilogo per tratta ────────────────────────────────────────────
  const wsRiepilogo = wb.addWorksheet("Riepilogo tratta");
  wsRiepilogo.columns = [
    { header: "Tratta",         key: "route",     width: 28 },
    { header: "Biglietti",      key: "tickets",   width: 12 },
    { header: "Valore totale",  key: "value",     width: 16 },
    { header: "Perso €",        key: "lost",      width: 14 },
    { header: "% perso",        key: "lost_pct",  width: 10 },
  ];

  styleHeader(wsRiepilogo);

  const routeMap: Record<string, { tickets: number; value: number; lost: number }> = {};
  for (const t of ticketList) {
    if (!routeMap[t.route]) routeMap[t.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[t.route].tickets++;
    routeMap[t.route].value += t.total_price_cents;
  }
  for (const l of legList) {
    if (l.status !== "lost") continue;
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    if (!routeMap[t.route]) routeMap[t.route] = { tickets: 0, value: 0, lost: 0 };
    routeMap[t.route].lost += l.price_per_pax_cents * t.pax_count;
  }

  for (const [route, d] of Object.entries(routeMap)) {
    wsRiepilogo.addRow({
      route:    ROUTE_LABELS[route as MedmarRoute] ?? route,
      tickets:  d.tickets,
      value:    eur(d.value),
      lost:     eur(d.lost),
      lost_pct: d.value > 0 ? parseFloat(((d.lost / d.value) * 100).toFixed(1)) : 0,
    });
  }

  formatCurrencyCols(wsRiepilogo, ["value", "lost"]);

  // ── Foglio 4: Riepilogo per operatore ────────────────────────────────────────
  const wsOp = wb.addWorksheet("Per operatore");
  wsOp.columns = [
    { header: "Operatore",    key: "name",    width: 24 },
    { header: "Biglietti",    key: "tickets", width: 12 },
    { header: "A/R emessi",   key: "rt",      width: 12 },
    { header: "% A/R",        key: "rt_pct",  width: 10 },
    { header: "Valore €",     key: "value",   width: 14 },
    { header: "Perso €",      key: "lost",    width: 14 },
  ];

  styleHeader(wsOp);

  const opMap: Record<string, { tickets: number; rt: number; value: number; lost: number }> = {};
  for (const t of ticketList) {
    const oid = t.issuing_operator_id ?? "unknown";
    if (!opMap[oid]) opMap[oid] = { tickets: 0, rt: 0, value: 0, lost: 0 };
    opMap[oid].tickets++;
    opMap[oid].value += t.total_price_cents;
    if (t.ticket_mode === "round_trip") opMap[oid].rt++;
  }
  for (const l of legList) {
    if (l.status !== "lost") continue;
    const t = ticketById.get(l.ticket_id);
    if (!t) continue;
    const oid = t.issuing_operator_id ?? "unknown";
    if (!opMap[oid]) opMap[oid] = { tickets: 0, rt: 0, value: 0, lost: 0 };
    opMap[oid].lost += l.price_per_pax_cents * t.pax_count;
  }

  for (const [oid, d] of Object.entries(opMap)) {
    wsOp.addRow({
      name:    operatorNames[oid] ?? oid,
      tickets: d.tickets,
      rt:      d.rt,
      rt_pct:  d.tickets > 0 ? parseFloat(((d.rt / d.tickets) * 100).toFixed(1)) : 0,
      value:   eur(d.value),
      lost:    eur(d.lost),
    });
  }

  formatCurrencyCols(wsOp, ["value", "lost"]);

  // ── Serializza e restituisce ─────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `medmar-ar_${dateFrom}_${dateTo}.xlsx`;

  return new NextResponse(buffer as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

// ── Helpers stile ─────────────────────────────────────────────────────────────

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4338CA" } };
  row.alignment = { vertical: "middle" };
  row.height = 20;
  row.commit();
}

function formatCurrencyCols(ws: ExcelJS.Worksheet, keys: string[]) {
  const colIndexes = keys.map((k) => {
    const col = ws.columns.find((c: any) => c.key === k);
    return col ? (col as any).number ?? ws.getColumn(k).number : null;
  }).filter(Boolean);

  ws.eachRow((row, i) => {
    if (i === 1) return;
    for (const idx of colIndexes) {
      const cell = row.getCell(idx!);
      cell.numFmt = '#,##0.00 "€"';
    }
  });
}

function addTotalsRow(ws: ExcelJS.Worksheet, totals: Record<string, number>) {
  const lastRow = ws.rowCount;
  if (lastRow < 2) return;
  const totalRow = ws.addRow({});
  totalRow.font = { bold: true };
  for (const [key, val] of Object.entries(totals)) {
    const col = ws.getColumn(key);
    if (col) {
      const cell = totalRow.getCell(col.number);
      cell.value = val;
      cell.numFmt = '#,##0.00 "€"';
    }
  }
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF6" } };
  totalRow.commit();
}
