/**
 * GET /api/ops/piano-giorno/export-excel?date=YYYY-MM-DD
 * Scarica un file .xlsx con 4 fogli:
 *   1. Piano Completo Giorno
 *   2. Autisti
 *   3. Lista Bruno
 *   4. Riepilogo
 */
import ExcelJS from "exceljs";
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import {
  isBrunoTarget,
  loadContinentDispatchServices,
  toBrunoArrival,
  toBrunoDeparture,
} from "@/lib/server/continent-dispatch";
import { getPianoServiceDisplay, type PianoDisplayService } from "@/lib/piano-service-display";

export const runtime = "nodejs";
export const maxDuration = 30;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt5(t: string | null | undefined) { return (t ?? "").slice(0, 5) || "—"; }

function customerFullName(r: { customer_name: string; customer_first_name?: string | null; customer_last_name?: string | null }) {
  return [r.customer_first_name, r.customer_last_name].filter(Boolean).join(" ") || r.customer_name;
}

function portLabel(p: string | null | undefined) {
  if (!p) return "";
  const l = p.toLowerCase();
  if (l.includes("casamicciola")) return "Casamicciola";
  if (l.includes("pozzuoli")) return "Pozzuoli";
  if (l.includes("beverello") || l.includes("napoli")) return "Napoli Beverello";
  if (l.includes("ischia porto") || l.includes("uscita arrivi") || l.includes("ischia")) return "Ischia Porto";
  return p;
}

function styleHeader(row: ExcelJS.Row, bgArgb = "FF1E3A5F") {
  row.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "medium", color: { argb: "FFCBD5E1" } } };
  });
  row.height = 22;
}

function styleDataRow(row: ExcelJS.Row, even: boolean) {
  row.eachCell({ includeEmpty: true }, cell => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: even ? "FFF0F4F8" : "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
  });
}

function setColWidths(ws: ExcelJS.Worksheet, widths: number[]) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function cleanNotes(raw: string | null): string {
  if (!raw) return "";
  return raw.includes("[pdf_import]") ? "" : raw;
}

const BASE_SERVICE_COLUMNS = [
  "id",
  "time",
  "direction",
  "customer_name",
  "customer_first_name",
  "customer_last_name",
  "pax",
  "hotel_id",
  "vessel",
  "notes",
  "status",
  "meeting_point",
  "pickup_hotel",
  "phone",
  "service_type",
  "booking_service_kind",
];

const OPTIONAL_SERVICE_COLUMNS = [
  "pickup_time",
  "service_type_code",
  "transport_code",
  "arrival_time",
  "departure_time",
  "train_arrival_number",
  "train_arrival_time",
  "train_departure_number",
  "train_departure_time",
  "place_type",
  "orario_barca",
  "porto_bruno",
  "barca_compagnia",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "origin_place_type",
  "destination_place_type",
  "origin_place_id",
  "destination_place_id",
];

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

type ExportServiceRow = PianoDisplayService & {
  id: string;
  time: string;
  direction: "arrival" | "departure";
  customer_name: string;
  customer_first_name?: string | null;
  customer_last_name?: string | null;
  pax: number;
  hotel_id: string | null;
  pickup_hotel: string | null;
  phone: string | null;
  notes: string | null;
};

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const date = req.nextUrl.searchParams.get("date")?.trim() || new Date().toISOString().slice(0, 10);

    // ─── Carica dati piano giorno + Bruno in parallelo ─────────────────────────

    let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
    let servicesRes: {
      data: ExportServiceRow[] | null;
      error: { message: string } | null;
    } = { data: null, error: null };
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await auth.admin
        .from("services")
        .select(serviceColumns.join(", "))
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time")
        .limit(2000);
      servicesRes = result as typeof servicesRes;
      if (!result.error) break;
      const missingColumn = missingSchemaColumn(result.error.message);
      if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
      serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
    }

    const [
      hotelsRes,
      membershipsRes,
      vehiclesRes,
      brunoData,
    ] = await Promise.all([
      auth.admin
        .from("hotels")
        .select("id, name, zone")
        .eq("tenant_id", tenantId),

      auth.admin
        .from("memberships")
        .select("user_id, full_name, role, max_vehicle_capacity")
        .eq("tenant_id", tenantId)
        .in("role", ["driver", "admin", "operator", "supervisor"]),

      auth.admin
        .from("vehicles")
        .select("id, label, capacity")
        .eq("tenant_id", tenantId)
        .eq("active", true),

      loadContinentDispatchServices(auth, date),
    ]);

    if (servicesRes.error) throw new Error(servicesRes.error.message);
    if (hotelsRes.error) throw new Error(hotelsRes.error.message);
    if (membershipsRes.error) throw new Error(membershipsRes.error.message);

    const services = servicesRes.data ?? [];
    const dayServiceIds = services.map(s => s.id as string);

    // Trip groups + assignments
    const tripGroupsRes = await auth.admin
      .from("trip_groups")
      .select("id, driver_user_id, vehicle_label, vehicle_capacity, notes, status")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("status", "active")
      .limit(2000);

    const tripGroups = tripGroupsRes.data ?? [];
    const todayGroupIds = tripGroups.map(g => g.id as string);

    const assignmentsRes = todayGroupIds.length > 0
      ? await auth.admin
          .from("assignments")
          .select("id, service_id, driver_user_id, vehicle_label, group_id")
          .eq("tenant_id", tenantId)
          .in("group_id", todayGroupIds)
          .limit(5000)
      : { data: [] as Array<{ id: string; service_id: string; driver_user_id: string | null; vehicle_label: string | null; group_id: string }>, error: null };

    const assignments = assignmentsRes.data ?? [];

    // ─── Lookup maps ──────────────────────────────────────────────────────────

    const hotelMap = new Map((hotelsRes.data ?? []).map(h => [h.id as string, h as { id: string; name: string; zone: string | null }]));
    const memberMap = new Map((membershipsRes.data ?? []).map(m => [m.user_id as string, m as { user_id: string; full_name: string; role: string; max_vehicle_capacity: number | null }]));
    const vehicleMap = new Map((vehiclesRes.data ?? []).map(v => [v.label as string, v as { id: string; label: string; capacity: number | null }]));

    // service_id → assignment
    const svcAssignment = new Map(assignments.map(a => [a.service_id, a]));
    // group_id → trip_group
    const groupMap = new Map(tripGroups.map(g => [g.id as string, g]));
    // group_id → services[]
    const groupServices = new Map<string, typeof services>();
    for (const a of assignments) {
      if (!a.group_id) continue;
      const list = groupServices.get(a.group_id) ?? [];
      const svc = services.find(s => s.id === a.service_id);
      if (svc) { list.push(svc); groupServices.set(a.group_id, list); }
    }

    // ─── Workbook ─────────────────────────────────────────────────────────────

    const wb = new ExcelJS.Workbook();
    wb.creator = "ITS - Ischia Transfer Service";
    wb.created = new Date();

    const fmtDateIt = (iso: string) => {
      const d = new Date(iso + "T12:00:00Z");
      return d.toLocaleDateString("it-IT", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
    };

    // ── FOGLIO 1: Piano Completo Giorno ───────────────────────────────────────

    const ws1 = wb.addWorksheet("Piano Completo Giorno");
    ws1.mergeCells("A1:L1");
    const t1 = ws1.getCell("A1");
    t1.value = `Piano del Giorno — ${fmtDateIt(date)}`;
    t1.font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
    t1.alignment = { horizontal: "center", vertical: "middle" };
    ws1.getRow(1).height = 28;
    ws1.addRow([]);

    const hdr1 = ws1.addRow(["Ora", "Macro", "Servizio", "Azione", "Pickup", "Destinazione", "Connessione/Nave", "Cliente", "Telefono", "Pax", "Autista", "Mezzo", "Note"]);
    styleHeader(hdr1, "FF1E3A5F");

    let r1 = 0;
    for (const svc of services) {
      const asgn = svcAssignment.get(svc.id);
      const grp = asgn?.group_id ? groupMap.get(asgn.group_id) : undefined;
      const hotel = hotelMap.get(svc.hotel_id ?? "");
      const driverName = (asgn?.driver_user_id ? memberMap.get(asgn.driver_user_id)?.full_name : null)
        ?? (grp?.driver_user_id ? memberMap.get(grp.driver_user_id)?.full_name : null)
        ?? "—";
      const vehicleLabel = asgn?.vehicle_label ?? grp?.vehicle_label ?? "—";
      const display = getPianoServiceDisplay(svc, hotel);
      const ora = display.primaryTime ?? (svc.direction === "departure" ? fmt5(svc.pickup_hotel ?? svc.time) : fmt5(svc.time));
      const note = [display.noteLabel, display.importTag, ...display.warnings].filter(Boolean).join(" | ");
      const row = ws1.addRow([
        ora,
        display.macroCategory,
        display.serviceLabel,
        display.actionLabel,
        display.pickupLabel ?? "—",
        display.destinationLabel ?? "—",
        [display.connectionLabel, display.transportRef, display.ferryLabel].filter(Boolean).join(" | ") || "—",
        display.clientLabel || customerFullName(svc),
        display.phoneLabel || svc.phone || "—",
        svc.pax,
        driverName,
        vehicleLabel,
        note,
      ]);
      styleDataRow(row, r1++ % 2 === 0);
    }

    setColWidths(ws1, [8, 12, 18, 24, 24, 28, 28, 26, 14, 8, 18, 12, 30]);
    ws1.views = [{ state: "frozen", ySplit: 3 }];

    // ── FOGLIO 2: Autisti ──────────────────────────────────────────────────────

    const ws2 = wb.addWorksheet("Autisti");
    ws2.mergeCells("A1:H1");
    const t2 = ws2.getCell("A1");
    t2.value = `Piano Autisti — ${fmtDateIt(date)}`;
    t2.font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
    t2.alignment = { horizontal: "center", vertical: "middle" };
    ws2.getRow(1).height = 28;
    ws2.addRow([]);

    const hdr2 = ws2.addRow(["Autista", "Mezzo", "Capienza", "Ora", "Clienti", "N° Persone", "Hotel / Destinazione", "Telefono"]);
    styleHeader(hdr2, "FF14532D");

    // Sort trip groups by driver name then earliest service time
    const sortedGroups = [...tripGroups].sort((a, b) => {
      const an = a.driver_user_id ? memberMap.get(a.driver_user_id)?.full_name ?? "" : "";
      const bn = b.driver_user_id ? memberMap.get(b.driver_user_id)?.full_name ?? "" : "";
      if (an !== bn) return an.localeCompare(bn);
      const at = (groupServices.get(a.id) ?? []).map(s => s.time).sort()[0] ?? "";
      const bt = (groupServices.get(b.id) ?? []).map(s => s.time).sort()[0] ?? "";
      return at.localeCompare(bt);
    });

    let r2 = 0;
    for (const grp of sortedGroups) {
      const svcs = (groupServices.get(grp.id) ?? []).sort((a, b) => (a.pickup_hotel ?? a.time).localeCompare(b.pickup_hotel ?? b.time));
      if (!svcs.length) continue;
      const driverName = grp.driver_user_id ? memberMap.get(grp.driver_user_id)?.full_name ?? "—" : "—";
      const vehicleLabel = grp.vehicle_label ?? "—";
      const capacity = grp.vehicle_capacity ?? vehicleMap.get(grp.vehicle_label ?? "")?.capacity ?? "—";
      const firstDisplay = svcs[0] ? getPianoServiceDisplay(svcs[0], hotelMap.get(svcs[0].hotel_id ?? "")) : null;
      const firstTime = firstDisplay?.primaryTime ?? fmt5(svcs[0]?.pickup_hotel ?? svcs[0]?.time);
      const clienti = svcs.map(s => getPianoServiceDisplay(s, hotelMap.get(s.hotel_id ?? "")).clientLabel || customerFullName(s)).join(", ");
      const totalPax = svcs.reduce((s, c) => s + (c.pax ?? 0), 0);
      const places = [...new Set(svcs.map(s => {
        const display = getPianoServiceDisplay(s, hotelMap.get(s.hotel_id ?? ""));
        return [display.macroCategory, display.pickupLabel, display.destinationLabel].filter(Boolean).join(": ");
      }).filter(Boolean))].join(", ") || "—";
      const firstPhone = firstDisplay?.phoneLabel ?? svcs[0]?.phone ?? "—";
      const row = ws2.addRow([driverName, vehicleLabel, capacity, firstTime, clienti, totalPax, places, firstPhone]);
      styleDataRow(row, r2++ % 2 === 0);
    }

    setColWidths(ws2, [22, 14, 9, 8, 40, 9, 30, 14]);
    ws2.views = [{ state: "frozen", ySplit: 3 }];

    // ── FOGLIO 3: Lista Bruno ──────────────────────────────────────────────────

    const ws3 = wb.addWorksheet("Lista Bruno");
    ws3.mergeCells("A1:I1");
    const t3 = ws3.getCell("A1");
    t3.value = `Lista Bruno — ${fmtDateIt(date)}`;
    t3.font = { bold: true, size: 14, color: { argb: "FF7C3AED" } };
    t3.alignment = { horizontal: "center", vertical: "middle" };
    ws3.getRow(1).height = 28;
    ws3.addRow([]);

    // Arrivi
    const arrHdr = ws3.addRow(["ARRIVI"]);
    arrHdr.getCell(1).font = { bold: true, size: 11, color: { argb: "FF1E40AF" } };
    arrHdr.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDBEAFE" } };
    ws3.addRow([]);

    const hdr3a = ws3.addRow(["Ora Arrivo", "Nome", "Cognome", "Telefono", "N° Persone", "Hotel", "Note speciali", "Numero volo", "Porto arrivo"]);
    styleHeader(hdr3a, "FF1E40AF");

    const brunoArrivals = brunoData.arrivals.filter(isBrunoTarget).map(toBrunoArrival);
    let r3 = 0;
    for (const r of brunoArrivals) {
      const arrivalTime = r.arrival_at_ischia ?? fmt5(r.time);
      const parts = r.customer_name.split(" ");
      const nome = parts[0] ?? "";
      const cognome = parts.slice(1).join(" ");
      const porto = portLabel(r.meeting_point);
      const row = ws3.addRow([arrivalTime, nome, cognome, r.phone ?? "—", r.pax, r.hotel_name ?? "—", cleanNotes(r.notes), r.flight_number ?? "", porto]);
      styleDataRow(row, r3++ % 2 === 0);
    }

    ws3.addRow([]);

    // Partenze
    const depHdr = ws3.addRow(["PARTENZE"]);
    depHdr.getCell(1).font = { bold: true, size: 11, color: { argb: "FF92400E" } };
    depHdr.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };
    ws3.addRow([]);

    const hdr3d = ws3.addRow(["Ora Arrivo Porto", "Nome", "Cognome", "Telefono", "N° Persone", "Hotel", "Note speciali", "Numero volo", "Porto imbarco"]);
    styleHeader(hdr3d, "FF92400E");

    const brunoDepartures = brunoData.departures.filter(isBrunoTarget).map(toBrunoDeparture);
    let r3d = 0;
    for (const r of brunoDepartures) {
      const parts = r.customer_name.split(" ");
      const nome = parts[0] ?? "";
      const cognome = parts.slice(1).join(" ");

      const row = ws3.addRow([
        r.arrival_at_porto ?? fmt5(r.time),
        nome,
        cognome,
        r.phone ?? "—",
        r.pax,
        r.hotel_name ?? "—",
        cleanNotes(r.notes),
        r.flight_number ?? "",
        r.porto_bruno ? portLabel(r.porto_bruno) : portLabel(r.meeting_point),
      ]);
      styleDataRow(row, r3d++ % 2 === 0);
    }

    setColWidths(ws3, [14, 16, 20, 14, 8, 22, 28, 14, 18]);

    // ── FOGLIO 4: Riepilogo ────────────────────────────────────────────────────

    const ws4 = wb.addWorksheet("Riepilogo");
    ws4.mergeCells("A1:B1");
    const t4 = ws4.getCell("A1");
    t4.value = `Riepilogo — ${fmtDateIt(date)}`;
    t4.font = { bold: true, size: 14, color: { argb: "FF1E3A5F" } };
    t4.alignment = { horizontal: "center", vertical: "middle" };
    ws4.getRow(1).height = 28;
    ws4.addRow([]);

    const totalServices = services.length;
    const totalArrivals = services.filter(s => s.direction === "arrival").length;
    const totalDepartures = services.filter(s => s.direction === "departure").length;
    const totalPax = services.reduce((s, c) => s + (c.pax ?? 0), 0);
    const assignedSvcIds = new Set(assignments.map(a => a.service_id));
    const assignedCount = services.filter(s => assignedSvcIds.has(s.id)).length;
    const unassignedCount = totalServices - assignedCount;
    const tripsWithDriver = tripGroups.filter(g => g.driver_user_id).length;
    const tripsWithoutDriver = tripGroups.filter(g => !g.driver_user_id).length;
    const activeDrivers = new Set(tripGroups.map(g => g.driver_user_id).filter(Boolean)).size;
    const activeVehicles = new Set(tripGroups.map(g => g.vehicle_label).filter(Boolean)).size;
    const brunoArrCount = brunoArrivals.length;
    const brunoDepCount = brunoDepartures.length;

    const summaryRows: [string, string | number][] = [
      ["SERVIZI", ""],
      ["Totale servizi", totalServices],
      ["Arrivi", totalArrivals],
      ["Partenze", totalDepartures],
      ["Totale passeggeri", totalPax],
      ["Servizi assegnati", assignedCount],
      ["Servizi non assegnati", unassignedCount],
      ["", ""],
      ["GIRI", ""],
      ["Totale giri", tripGroups.length],
      ["Giri con autista", tripsWithDriver],
      ["Giri senza autista", tripsWithoutDriver],
      ["", ""],
      ["RISORSE", ""],
      ["Autisti attivi oggi", activeDrivers],
      ["Mezzi attivi oggi", activeVehicles],
      ["", ""],
      ["LISTA BRUNO", ""],
      ["Arrivi Bruno", brunoArrCount],
      ["Partenze Bruno", brunoDepCount],
      ["Totale Bruno", brunoArrCount + brunoDepCount],
    ];

    let sumRow = 0;
    for (const [label, value] of summaryRows) {
      const row = ws4.addRow([label, value]);
      if (!label) { sumRow++; continue; }
      if (!value && typeof value !== "number") {
        // section header
        row.eachCell(cell => {
          cell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
          cell.alignment = { vertical: "middle" };
        });
        row.height = 20;
      } else {
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: sumRow++ % 2 === 0 ? "FFF8FAFC" : "FFFFFFFF" } };
          cell.alignment = { vertical: "middle" };
          if (col === 1) cell.font = { bold: false };
          if (col === 2) cell.font = { bold: true };
        });
        row.height = 18;
      }
    }

    ws4.getColumn(1).width = 32;
    ws4.getColumn(2).width = 14;

    // ─── Serializza e ritorna ──────────────────────────────────────────────────

    const buffer = await wb.xlsx.writeBuffer();
    const safeDateLabel = date.replace(/-/g, "");

    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="piano-giorno-${safeDateLabel}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
