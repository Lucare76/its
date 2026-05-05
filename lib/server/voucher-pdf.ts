import type { SupabaseClient } from "@supabase/supabase-js";

const KIND_LABELS: Record<string, string> = {
  transfer_port_hotel:               "Transfer Porto → Hotel",
  transfer_airport_hotel:            "Transfer Aeroporto → Hotel",
  transfer_airport_hotel_exclusive:  "Transfer Aeroporto → Hotel (esclusivo)",
  transfer_train_hotel:              "Transfer Stazione → Hotel",
  transfer_train_hotel_exclusive:    "Transfer Stazione → Hotel (esclusivo)",
  bus_city_hotel:                    "Bus Città → Hotel",
  excursion:                         "Escursione",
  formula_snav:                      "Formula SNAV",
  formula_medmar_napoli:             "Formula Medmar Napoli",
  formula_medmar_pozzuoli:           "Formula Medmar Pozzuoli",
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtTime(t?: string | null) {
  if (!t) return "";
  return t.slice(0, 5);
}

function shortId(id: string) {
  return id.toUpperCase().replace(/-/g, "").slice(0, 8);
}

export async function buildVoucherPdfHtml(
  admin: SupabaseClient,
  tenantId: string,
  serviceId: string
): Promise<string> {
  const { data: svc, error } = await admin
    .from("services")
    .select("id, customer_name, customer_first_name, customer_last_name, phone, pax, date, time, booking_service_kind, service_type_code, hotel_id, meeting_point, notes, arrival_date, arrival_time, departure_date, departure_time, transport_code, billing_party_name, status, vessel, direction")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (error || !svc) throw new Error("Servizio non trovato.");

  const [hotelRes, tenantRes] = await Promise.all([
    svc.hotel_id
      ? admin.from("hotels").select("name, address, zone").eq("id", svc.hotel_id).maybeSingle()
      : Promise.resolve({ data: null }),
    admin.from("tenants").select("name").eq("id", tenantId).maybeSingle(),
  ]);

  const hotelName = hotelRes.data?.name ?? null;
  const hotelAddress = hotelRes.data?.address ?? null;
  const companyName = tenantRes.data?.name ?? process.env.NEXT_PUBLIC_APP_NAME ?? "Ischia Transfer Service";

  const customerName = svc.customer_first_name && svc.customer_last_name
    ? `${svc.customer_first_name} ${svc.customer_last_name}`
    : (svc.customer_name ?? "—");

  const serviceLabel = KIND_LABELS[svc.booking_service_kind ?? ""] ?? (svc.booking_service_kind ?? "Servizio");

  // Data e orario principali
  const mainDate = svc.arrival_date ?? svc.date;
  const mainTime = svc.arrival_time ? fmtTime(svc.arrival_time) : fmtTime(svc.time);

  const printedAt = new Date().toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const rows: string[] = [];

  function row(label: string, value: string) {
    return `<tr>
      <td style="padding:8px 12px;font-size:12px;font-weight:600;color:#64748b;white-space:nowrap;width:38%;">${label}</td>
      <td style="padding:8px 12px;font-size:13px;color:#1e293b;font-weight:500;">${value}</td>
    </tr>`;
  }

  rows.push(row("Cliente", customerName));
  if (svc.phone) rows.push(row("Telefono", svc.phone));
  rows.push(row("Passeggeri", `${svc.pax ?? 1} pax`));
  rows.push(row("Tipo servizio", serviceLabel));
  rows.push(row("Data arrivo", fmtDate(mainDate) + (mainTime ? ` ore ${mainTime}` : "")));
  if (svc.departure_date) {
    rows.push(row("Data partenza", fmtDate(svc.departure_date) + (svc.departure_time ? ` ore ${fmtTime(svc.departure_time)}` : "")));
  }
  if (hotelName) {
    rows.push(row("Hotel", hotelName + (hotelAddress ? `<br><span style="font-size:11px;color:#94a3b8;">${hotelAddress}</span>` : "")));
  }
  if (svc.meeting_point) rows.push(row("Punto di ritrovo", svc.meeting_point));
  if (svc.transport_code) rows.push(row("Rif. trasporto", svc.transport_code));
  if (svc.vessel) rows.push(row("Mezzo", svc.vessel));
  if (svc.billing_party_name) rows.push(row("Agenzia", svc.billing_party_name));

  const notesHtml = svc.notes
    ? `<div style="margin-top:20px;border-top:1px solid #e2e8f0;padding-top:16px;">
        <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#94a3b8;margin:0 0 6px;">Note</p>
        <p style="font-size:13px;color:#475569;margin:0;white-space:pre-line;">${svc.notes}</p>
       </div>`
    : "";

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voucher ${shortId(serviceId)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; background: #f8fafc; color: #1e293b; }
  @page { size: A4 portrait; margin: 1.2cm; }
  @media print {
    body { background: #fff; }
    .no-print { display: none !important; }
    .card { box-shadow: none !important; border: 1px solid #e2e8f0 !important; }
    .page-break { page-break-before: always; }
  }
  .wrapper { max-width: 640px; margin: 32px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,.08); overflow: hidden; }
  .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: #fff; padding: 28px 32px 24px; }
  .company { font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.7; margin-bottom: 4px; }
  .title { font-size: 26px; font-weight: 900; letter-spacing: -0.03em; margin-bottom: 12px; }
  .badge-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .badge { display: inline-block; background: rgba(255,255,255,.15); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; }
  .badge-id { font-size: 14px; font-family: monospace; font-weight: 700; opacity: 0.9; }
  .body { padding: 24px 0 8px; }
  table { width: 100%; border-collapse: collapse; }
  tr:nth-child(even) td { background: #f8fafc; }
  .footer { border-top: 1px solid #e2e8f0; padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8; }
  .notes-area { padding: 0 32px; }
  .print-btn { display: block; margin: 20px auto 0; padding: 10px 28px; background: #0f172a; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; }
  .print-btn:hover { background: #1e293b; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="card">
    <div class="header">
      <div class="company">${companyName}</div>
      <div class="title">Voucher di prenotazione</div>
      <div class="badge-row">
        <span class="badge">N° <span class="badge-id">${shortId(serviceId)}</span></span>
        <span class="badge">${serviceLabel}</span>
      </div>
    </div>

    <div class="body">
      <table>
        <tbody>
          ${rows.join("\n")}
        </tbody>
      </table>
    </div>

    <div class="notes-area">${notesHtml}</div>

    <div class="footer">
      <span>Ref. completa: ${serviceId}</span>
      <span>Stampato il ${printedAt}</span>
    </div>
  </div>

  <button class="print-btn no-print" onclick="window.print()">Stampa / Salva PDF</button>
</div>
</body>
</html>`;
}
