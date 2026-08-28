import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const STATUS_LABELS: Record<string, string> = {
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

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const batchId = request.nextUrl.searchParams.get("batchId");
  if (!batchId) {
    return NextResponse.json({ error: "batchId richiesto" }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;

  const { data: batch } = await auth.admin
    .from("snav_convocation_batches")
    .select("id, file_name, label, created_at")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!batch) {
    return NextResponse.json({ error: "Batch non trovato" }, { status: 404 });
  }

  const { data: rows } = await auth.admin
    .from("snav_convocation_rows")
    .select("*")
    .eq("batch_id", batchId)
    .eq("tenant_id", tenantId)
    .order("row_index", { ascending: true })
    .limit(5000);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report Convocazioni SNAV");

  ws.columns = [
    { header: "#", key: "row_index", width: 6 },
    { header: "Cliente", key: "customer_name", width: 25 },
    { header: "Telefono originale", key: "phone_raw", width: 18 },
    { header: "Telefono E.164", key: "phone_e164", width: 18 },
    { header: "Data partenza", key: "departure_date_label", width: 22 },
    { header: "Hotel", key: "hotel", width: 24 },
    { header: "Pax", key: "passengers", width: 8 },
    { header: "Prelevamento", key: "pickup_time", width: 14 },
    { header: "Aliscafo", key: "vessel_time", width: 12 },
    { header: "Stato", key: "status", width: 18 },
    { header: "Message ID", key: "provider_message_id", width: 30 },
    { header: "Errore", key: "error_message", width: 30 },
    { header: "Inviato alle", key: "sent_at", width: 20 },
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
      departure_date_label: row.departure_date_label,
      hotel: row.hotel ?? "",
      passengers: row.passengers ?? "",
      pickup_time: row.pickup_time ?? "",
      vessel_time: row.vessel_time ?? "",
      status: STATUS_LABELS[row.status as string] ?? row.status,
      provider_message_id: row.provider_message_id ?? "",
      error_message: row.error_message ?? "",
      sent_at: row.sent_at ? new Date(row.sent_at as string).toLocaleString("it-IT", { timeZone: "Europe/Rome" }) : "",
    });

    const bgColor = STATUS_COLORS[row.status as string];
    if (bgColor) {
      excelRow.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${bgColor}` } };
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
  const fileName = `convocazioni_snav_${dateStr}.xlsx`;

  return new NextResponse(buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
