import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    // ── Carica dati ───────────────────────────────────────────────────────────
    const unitIds = await auth.admin
      .from("excursion_units")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("excursion_date", date)
      .then((r) => (r.data ?? []).map((u: { id: string }) => u.id));

    const [linesRes, unitsRes, allocRes, vehiclesRes, driversRes] = await Promise.all([
      auth.admin.from("excursion_lines").select("*").eq("tenant_id", tenantId).eq("active", true).order("sort_order"),
      auth.admin.from("excursion_units").select("*").eq("tenant_id", tenantId).eq("excursion_date", date).order("label"),
      unitIds.length > 0
        ? auth.admin.from("excursion_allocations").select("*").in("excursion_unit_id", unitIds).order("pickup_time").order("customer_name")
        : Promise.resolve({ data: [], error: null }),
      auth.admin.from("vehicles").select("id,label,plate").eq("tenant_id", tenantId),
      auth.admin.from("driver_profiles").select("id,full_name,phone").eq("tenant_id", tenantId),
    ]);

    if (linesRes.error) throw new Error(linesRes.error.message);
    if (unitsRes.error) throw new Error(unitsRes.error.message);

    type Line = { id: string; name: string; icon: string };
    type Unit = { id: string; excursion_line_id: string; label: string; capacity: number; departure_time: string | null; vehicle_id: string | null; driver_profile_id: string | null; status: string; notes: string | null };
    type Alloc = { id: string; excursion_unit_id: string; customer_name: string; pax: number; hotel_name: string | null; pickup_time: string | null; phone: string | null; agency_name: string | null; notes: string | null };
    type VehicleRow = { id: string; label: string; plate: string };
    type DriverRow = { id: string; full_name: string; phone: string | null };

    const lines = (linesRes.data ?? []) as Line[];
    const units = (unitsRes.data ?? []) as Unit[];
    const allocs = (allocRes.data ?? []) as Alloc[];
    const vehicles = (vehiclesRes.data ?? []) as VehicleRow[];
    const drivers = (driversRes.data ?? []) as DriverRow[];

    const wb = XLSX.utils.book_new();
    const dateLabel = fmtDate(date);

    // ── Foglio riepilogo ──────────────────────────────────────────────────────
    const summaryRows: unknown[][] = [
      ["RIEPILOGO ESCURSIONI", dateLabel, "", "", "", ""],
      [""],
      ["Escursione", "Bus", "Autista", "Mezzo", "Partenza", "Cap.", "Pax", "Liberi", "Stato"],
    ];

    for (const line of lines) {
      const lineUnits = units.filter((u) => u.excursion_line_id === line.id);
      if (lineUnits.length === 0) continue;
      for (const unit of lineUnits) {
        const totalPax = allocs.filter((a) => a.excursion_unit_id === unit.id).reduce((s, a) => s + a.pax, 0);
        const driver = drivers.find((d) => d.id === unit.driver_profile_id);
        const vehicle = vehicles.find((v) => v.id === unit.vehicle_id);
        summaryRows.push([
          `${line.icon} ${line.name}`,
          unit.label,
          driver?.full_name ?? "—",
          vehicle ? `${vehicle.label} · ${vehicle.plate}` : "—",
          unit.departure_time?.slice(0, 5) ?? "—",
          unit.capacity,
          totalPax,
          unit.capacity - totalPax,
          unit.status === "open" ? "Aperto" : unit.status === "full" ? "Completo" : unit.status === "completed" ? "Completato" : "Annullato",
        ]);
      }
    }

    const wsSum = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSum["!cols"] = [{ wch: 22 }, { wch: 12 }, { wch: 18 }, { wch: 20 }, { wch: 10 }, { wch: 6 }, { wch: 6 }, { wch: 8 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, wsSum, "Riepilogo");

    // ── Un foglio per ogni escursione con passeggeri ──────────────────────────
    for (const line of lines) {
      const lineUnits = units.filter((u) => u.excursion_line_id === line.id);
      if (lineUnits.length === 0) continue;

      const rows: unknown[][] = [
        [`${line.icon} ${line.name} — ${dateLabel}`, "", "", "", "", "", "", ""],
        [""],
        ["Bus", "Cliente", "Pax", "Hotel", "Pickup", "Agenzia", "Telefono", "Note"],
      ];

      for (const unit of lineUnits) {
        const driver = drivers.find((d) => d.id === unit.driver_profile_id);
        const vehicle = vehicles.find((v) => v.id === unit.vehicle_id);
        const unitAllocs = allocs.filter((a) => a.excursion_unit_id === unit.id);
        const totalPax = unitAllocs.reduce((s, a) => s + a.pax, 0);

        // Riga intestazione bus
        rows.push([
          `▶ ${unit.label}${unit.departure_time ? ` (${unit.departure_time.slice(0, 5)})` : ""}`,
          driver ? `Autista: ${driver.full_name}` : "",
          `${totalPax}/${unit.capacity} pax`,
          vehicle ? `${vehicle.label} · ${vehicle.plate}` : "",
          "", "", "", "",
        ]);

        if (unitAllocs.length === 0) {
          rows.push(["", "(nessun passeggero)", "", "", "", "", "", ""]);
        } else {
          for (const alloc of unitAllocs) {
            rows.push([
              unit.label,
              alloc.customer_name,
              alloc.pax,
              alloc.hotel_name ?? "",
              alloc.pickup_time?.slice(0, 5) ?? "",
              alloc.agency_name ?? "",
              alloc.phone ?? "",
              alloc.notes ?? "",
            ]);
          }
        }
        rows.push([""]); // riga vuota separatore
      }

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws["!cols"] = [{ wch: 18 }, { wch: 22 }, { wch: 6 }, { wch: 20 }, { wch: 8 }, { wch: 16 }, { wch: 14 }, { wch: 20 }];

      // Nome foglio max 31 caratteri (limite Excel)
      const sheetName = line.name.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `escursioni_${date}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore export" },
      { status: 500 }
    );
  }
}
