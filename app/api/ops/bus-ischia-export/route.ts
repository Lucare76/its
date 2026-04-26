import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import ExcelJS from "exceljs";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(request.url);
    const distBusId = searchParams.get("dist_bus_id");
    if (!distBusId) return NextResponse.json({ error: "dist_bus_id mancante." }, { status: 400 });

    const tenantId = auth.membership.tenant_id;

    // Dati bus
    const { data: bus, error: busErr } = await auth.admin
      .from("bus_ischia_dist_buses")
      .select("id, label, zone, date, capacity, driver_name, driver_phone, vehicles(label, plate)")
      .eq("id", distBusId)
      .eq("tenant_id", tenantId)
      .single();
    if (busErr || !bus) return NextResponse.json({ error: "Bus non trovato." }, { status: 404 });

    // Passeggeri ordinati per stop_order
    const { data: allocs } = await auth.admin
      .from("bus_ischia_dist_allocations")
      .select("customer_name, hotel_name, pax_assigned, stop_order")
      .eq("dist_bus_id", distBusId)
      .eq("tenant_id", tenantId)
      .order("stop_order");

    const passengers = (allocs ?? []) as Array<{
      customer_name: string;
      hotel_name: string;
      pax_assigned: number;
      stop_order: number;
    }>;

    const vehicleRaw = bus.vehicles;
    const vehicle = vehicleRaw && !Array.isArray(vehicleRaw) ? vehicleRaw as { label: string; plate: string } : Array.isArray(vehicleRaw) ? (vehicleRaw[0] as { label: string; plate: string } | undefined) ?? null : null;
    const totalPax = passengers.reduce((s, p) => s + p.pax_assigned, 0);

    // ── Costruzione workbook ExcelJS ────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "ITS - Ischia Transfer Service";
    const ws = wb.addWorksheet("Lista Autista");

    // Intestazione
    ws.mergeCells("A1:D1");
    const titleCell = ws.getCell("A1");
    titleCell.value = bus.label;
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { horizontal: "center" };

    ws.mergeCells("A2:D2");
    const dateCell = ws.getCell("A2");
    dateCell.value = `Data: ${bus.date}`;
    dateCell.font = { size: 11 };
    dateCell.alignment = { horizontal: "center" };

    ws.addRow([]);

    // Info autista / veicolo
    const infoRows: [string, string][] = [];
    if (bus.driver_name) infoRows.push(["Autista:", bus.driver_name + (bus.driver_phone ? `  •  ${bus.driver_phone}` : "")]);
    if (vehicle) infoRows.push(["Veicolo:", `${vehicle.label}${vehicle.plate ? ` (${vehicle.plate})` : ""}`]);
    infoRows.push(["Capienza:", `${bus.capacity} posti`]);
    infoRows.push(["Totale passeggeri:", String(totalPax)]);
    for (const [k, v] of infoRows) {
      const row = ws.addRow([k, v]);
      row.getCell(1).font = { bold: true };
    }

    ws.addRow([]);

    // Intestazione tabella passeggeri
    const headerRow = ws.addRow(["#", "Cognome / Nome", "Hotel / Fermata", "Pax"]);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
      cell.alignment = { horizontal: "center" };
      cell.border = { bottom: { style: "thin", color: { argb: "FFCBD5E1" } } };
    });

    // Righe passeggeri raggruppate per hotel (stesso stop_order = stessa fermata)
    const stopGroups = new Map<number, typeof passengers>();
    for (const p of passengers) {
      const g = stopGroups.get(p.stop_order) ?? [];
      g.push(p);
      stopGroups.set(p.stop_order, g);
    }

    let rowNum = 1;
    const sortedStops = [...stopGroups.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, group] of sortedStops) {
      const isEven = rowNum % 2 === 0;
      const bg = isEven ? "FFF8FAFC" : "FFFFFFFF";
      for (const p of group) {
        const dataRow = ws.addRow([rowNum, p.customer_name, p.hotel_name, p.pax_assigned]);
        dataRow.eachCell(cell => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } };
          cell.border = { bottom: { style: "hair", color: { argb: "FFE2E8F0" } } };
          cell.alignment = { horizontal: "left" };
        });
        dataRow.getCell(1).alignment = { horizontal: "center" };
        dataRow.getCell(4).alignment = { horizontal: "center" };
        rowNum++;
      }
      // Separatore visivo tra fermate diverse
      ws.addRow([]); rowNum++;
    }

    // Colonne larghezze
    ws.getColumn(1).width = 6;
    ws.getColumn(2).width = 30;
    ws.getColumn(3).width = 28;
    ws.getColumn(4).width = 8;

    // Genera buffer
    const buffer = await wb.xlsx.writeBuffer();

    const safeName = bus.label.replace(/[^a-z0-9]/gi, "_");
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="lista_autista_${safeName}_${bus.date}.xlsx"`,
      },
    });
  } catch (error) {
    console.error("bus-ischia-export error", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Errore generazione export." }, { status: 500 });
  }
}
