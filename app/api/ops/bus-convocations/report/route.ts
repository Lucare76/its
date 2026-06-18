import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const STATUS_LABELS: Record<string, string> = {
  da_validare: "Da validare",
  pronto: "Pronto",
  da_inviare: "Da inviare",
  inviato: "Inviato",
  errore: "Errore",
  numero_non_valido: "Numero non valido",
  duplicato: "Duplicato",
  escluso: "Escluso",
  da_reinviare: "Da reinviare",
};

const STATUS_COLORS: Record<string, string> = {
  inviato: "C6EFCE",
  errore: "FFC7CE",
  numero_non_valido: "FFC7CE",
  duplicato: "FFEB9C",
  escluso: "D9D9D9",
  pronto: "B4C6E7",
  da_inviare: "B4C6E7",
  da_reinviare: "FFEB9C",
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const batchId = request.nextUrl.searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "batchId richiesto" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;

  const { data: batch } = await auth.admin
    .from("bus_convocation_batches")
    .select("id, file_name, label, created_at")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!batch) {
    return NextResponse.json({ error: "Batch non trovato" }, { status: 404 });
  }

  const { data: rows } = await auth.admin
    .from("bus_convocation_rows")
    .select("*")
    .eq("batch_id", batchId)
    .eq("tenant_id", tenantId)
    .order("row_index", { ascending: true })
    .limit(5000);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report Convocazioni");

  ws.columns = [
    { header: "#", key: "row_index", width: 6 },
    { header: "Nome cliente", key: "customer_name", width: 25 },
    { header: "Telefono", key: "phone_raw", width: 18 },
    { header: "Telefono E164", key: "phone_e164", width: 18 },
    { header: "Data / Linea bus", key: "date_line", width: 22 },
    { header: "Punto partenza", key: "departure_point", width: 22 },
    { header: "Autista", key: "driver_name", width: 18 },
    { header: "Tel emergenza", key: "driver_emergency_phone", width: 16 },
    { header: "Stato", key: "status", width: 18 },
    { header: "Errore", key: "error_message", width: 30 },
    { header: "Message ID", key: "provider_message_id", width: 30 },
    { header: "Inviato alle", key: "sent_at", width: 20 },
    { header: "Note", key: "notes", width: 20 },
  ];

  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };

  for (const row of rows ?? []) {
    const excelRow = ws.addRow({
      row_index: row.row_index,
      customer_name: row.customer_name,
      phone_raw: row.phone_raw,
      phone_e164: row.phone_e164 ?? "",
      date_line: row.date_line,
      departure_point: row.departure_point,
      driver_name: row.driver_name,
      driver_emergency_phone: row.driver_emergency_phone,
      status: STATUS_LABELS[row.status as string] ?? row.status,
      error_message: row.error_message ?? "",
      provider_message_id: row.provider_message_id ?? "",
      sent_at: row.sent_at ? new Date(row.sent_at as string).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "",
      notes: row.notes ?? "",
    });

    const bgColor = STATUS_COLORS[row.status as string];
    if (bgColor) {
      excelRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${bgColor}` } };
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const dateStr = batch.created_at ? new Date(batch.created_at as string).toISOString().slice(0, 10) : "export";
  const fileName = `report_convocazioni_${dateStr}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
