import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildPrintSections, buildShuttlePrintGroups, type PrintService } from "@/lib/piano-giorno-print";
import { getLogoDataUri } from "@/lib/server/logo";

export const runtime = "nodejs";
export const maxDuration = 30;

const BASE_SERVICE_COLUMNS = [
  "id",
  "tenant_id",
  "agency_id",
  "date",
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
  "billing_party_name",
];

const OPTIONAL_SERVICE_COLUMNS = [
  "is_draft",
  "linked_service_id",
  "service_type_code",
  "transport_code",
  "arrival_date",
  "arrival_time",
  "departure_date",
  "departure_time",
  "train_arrival_number",
  "train_arrival_time",
  "train_departure_number",
  "train_departure_time",
  "pickup_time",
  "orario_barca",
  "porto_bruno",
  "barca_compagnia",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "origin_place_type",
  "destination_place_type",
];

function esc(value: string | number | null | undefined) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

function dateIt(date: string) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("it-IT", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

type TableSpec = {
  title: string;
  headers: string[];
  rows: string[][];
};

// Colonne con testo libero/variabile: restano allineate a sinistra per
// leggibilità. Tutte le altre (orari, pax, telefono, compagnia, porto,
// autista, mezzo, riferimenti) sono centrate di default.
const LEFT_ALIGN_HEADERS = new Set([
  "HOTEL",
  "DESTINAZIONE",
  "DESTINAZIONE/ATTIVITÀ",
  "NOTE",
  "CLIENTE",
  "CLIENTE/GRUPPO",
  "AGENZIA",
  "PARTENZA",
  "PUNTO PARTENZA",
  "ESCURSIONE",
]);

function renderTable(spec: TableSpec) {
  const alignments = spec.headers.map((header) => (LEFT_ALIGN_HEADERS.has(header) ? "left" : "center"));
  const body = spec.rows.length
    ? spec.rows.map((row) => `<tr>${row.map((cell, i) => `<td class="al-${alignments[i]}">${esc(cell)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${spec.headers.length}" class="empty">Nessun servizio</td></tr>`;
  return `
    <section class="print-section">
      <h2>${esc(spec.title)} <span>${spec.rows.length}</span></h2>
      <table>
        <thead><tr>${spec.headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </section>`;
}

const SHUTTLE_HEADERS = ["ORA", "PARTENZA", "DESTINAZIONE", "PAX", "AUTISTA", "MEZZO", "NOTE"];

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const date = req.nextUrl.searchParams.get("date")?.trim() || new Date().toISOString().slice(0, 10);

    let serviceColumns = [...BASE_SERVICE_COLUMNS, ...OPTIONAL_SERVICE_COLUMNS];
    let servicesRes: { data: PrintService[] | null; error: { message: string } | null } = { data: null, error: null };
    const omittedColumns: string[] = [];

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await auth.admin
        .from("services")
        .select(serviceColumns.join(", "))
        .eq("tenant_id", tenantId)
        .neq("status", "cancelled")
        .eq("date", date)
        .order("time")
        .limit(3000);
      servicesRes = result as typeof servicesRes;
      if (!result.error) break;
      const missingColumn = missingSchemaColumn(result.error.message);
      if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
      omittedColumns.push(missingColumn);
      serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
    }

    if (servicesRes.error) throw new Error(servicesRes.error.message);

    const services = (servicesRes.data ?? []).filter((service) => !service.is_draft);
    const serviceIds = services.map((service) => service.id);

    const [hotelsRes, agenciesRes, membersRes, assignmentsRes, tripGroupsRes] = await Promise.all([
      auth.admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId).limit(5000),
      auth.admin.from("agencies").select("id, name").eq("tenant_id", tenantId).limit(1000),
      auth.admin.from("memberships").select("user_id, full_name").eq("tenant_id", tenantId).limit(5000),
      serviceIds.length > 0
        ? auth.admin.from("assignments").select("service_id, driver_user_id, vehicle_label, group_id").eq("tenant_id", tenantId).in("service_id", serviceIds).limit(5000)
        : Promise.resolve({ data: [], error: null }),
      auth.admin.from("trip_groups").select("id, driver_user_id, vehicle_label").eq("tenant_id", tenantId).eq("date", date).eq("status", "active").limit(3000),
    ]);

    const errors = [hotelsRes.error, agenciesRes.error, membersRes.error, assignmentsRes.error, tripGroupsRes.error]
      .filter(Boolean)
      .map((error) => error?.message);
    if (errors.length > 0) throw new Error(errors.join("; "));

    const hotels = new Map((hotelsRes.data ?? []).map((hotel) => [hotel.id as string, hotel]));
    const agencies = new Map((agenciesRes.data ?? []).map((agency) => [agency.id as string, agency]));
    const members = new Map((membersRes.data ?? []).map((member) => [member.user_id as string, member]));
    const assignments = assignmentsRes.data ?? [];
    const tripGroups = tripGroupsRes.data ?? [];
    const tripGroupMap = new Map(tripGroups.map((group) => [group.id, group]));

    const sections = buildPrintSections({
      services,
      date,
      hotels,
      agencies,
      assignments,
      tripGroups,
      members,
    });

    const shuttleServiceIds = new Set(sections.NAVETTA.map((row) => row.serviceId));
    const shuttleServices = services.filter((service) => shuttleServiceIds.has(service.id));
    const shuttleGroups = buildShuttlePrintGroups({
      services: shuttleServices,
      hotels,
      assignments,
      tripGroups: tripGroupMap,
      members,
    });

    const tables: TableSpec[] = [
      {
        title: "ARRIVI",
        headers: ["ORA ARRIVO", "CLIENTE", "TELEFONO", "PAX", "HOTEL", "PORTO/PROVENIENZA", "COMPAGNIA/MEZZO", "ORA NAVE/VOLO/TRENO", "RIFERIMENTO", "AGENZIA", "AUTISTA", "MEZZO", "NOTE"],
        rows: sections.ARRIVO.map((row) => [row.time, row.customer, row.phone, row.pax, row.hotel, row.portOrOrigin, row.companyOrVehicle, row.ferryOrTransportTime, row.reference, row.agency, row.driver, row.vehicle, row.notes]),
      },
      {
        title: "PARTENZE",
        headers: ["PICKUP", "CLIENTE", "TELEFONO", "PAX", "HOTEL", "PORTO PARTENZA", "COMPAGNIA", "ORA NAVE", "DESTINAZIONE", "RIF. TRENO/VOLO", "AGENZIA", "AUTISTA", "MEZZO", "NOTE"],
        rows: sections.PARTENZA.map((row) => [row.pickup, row.customer, row.phone, row.pax, row.hotel, row.departurePort, row.companyOrVehicle, row.ferryOrTransportTime, row.destination, row.reference, row.agency, row.driver, row.vehicle, row.notes]),
      },
    ];

    const shuttleTables: TableSpec[] = shuttleGroups.map((group) => ({
      title: `NAVETTE — ${group.label}`,
      headers: SHUTTLE_HEADERS,
      rows: group.rows.map((row) => [row.time, row.origin, row.destination, row.pax, row.driver, row.vehicle, row.notes]),
    }));

    const excursionTable: TableSpec[] = sections.ESCURSIONE.length > 0
      ? [{
          title: "ESCURSIONI",
          headers: ["ORA", "CLIENTE/GRUPPO", "TELEFONO", "PAX", "ESCURSIONE", "PUNTO PARTENZA", "DESTINAZIONE/ATTIVITÀ", "AUTISTA", "MEZZO", "NOTE"],
          rows: sections.ESCURSIONE.map((row) => [row.time, row.customer, row.phone, row.pax, row.companyOrVehicle, row.portOrOrigin, row.destination, row.driver, row.vehicle, row.notes]),
        }]
      : [];

    const totals = `Arrivi ${sections.ARRIVO.length} · Partenze ${sections.PARTENZA.length} · Navette ${sections.NAVETTA.length}${sections.ESCURSIONE.length ? ` · Escursioni ${sections.ESCURSIONE.length}` : ""}`;
    const logoDataUri = getLogoDataUri();
    const logoHtml = logoDataUri
      ? `<img src="${logoDataUri}" alt="Ischia Transfer Service" class="logo" />`
      : `<div class="logo-fallback">ITS</div>`;
    const html = `<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>Stampa giornata ${esc(date)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 14px; color: #0f172a; font-family: Arial, Helvetica, sans-serif; font-size: 10px; background: #fff; }
    @page { size: A4 landscape; margin: 8mm; }
    header {
      display: grid;
      grid-template-columns: 130px 1fr 130px;
      align-items: center;
      gap: 16px;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 8px;
      margin-bottom: 10px;
    }
    .logo { display: block; width: 110px; max-width: 110px; height: auto; }
    .logo-fallback {
      display: inline-flex; align-items: center; justify-content: center;
      width: 64px; height: 44px; background: #172554; color: #fff;
      font-size: 16px; font-weight: 800; border-radius: 8px;
    }
    .header-title { text-align: center; }
    h1 { margin: 0; font-size: 20px; line-height: 1.1; }
    .header-title .date { font-size: 12px; color: #334155; margin-top: 2px; }
    .header-title .counts { font-size: 10px; color: #475569; margin-top: 4px; }
    .meta { text-align: right; font-size: 9px; color: #94a3b8; }
    .print-section { break-inside: avoid; margin: 0 0 12px; }
    h2 { margin: 0 0 5px; padding: 5px 7px; color: #fff; background: #172554; font-size: 12px; letter-spacing: .04em; text-align: center; }
    h2 span { float: right; font-size: 11px; opacity: .9; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    th { background: #e2e8f0; color: #0f172a; font-size: 8px; text-align: center; padding: 4px 5px; border: 1px solid #cbd5e1; }
    td { vertical-align: top; padding: 4px 5px; border: 1px solid #dbe3ef; line-height: 1.18; word-break: break-word; text-align: center; }
    td.al-left { text-align: left; }
    tr:nth-child(even) td { background: #f8fafc; }
    .empty { text-align: center; color: #64748b; padding: 12px; }
    .foot { margin-top: 10px; color: #64748b; font-size: 9px; }
    @media print { body { padding: 0; } .no-print { display: none; } }
  </style>
</head>
<body>
  <header>
    ${logoHtml}
    <div class="header-title">
      <h1>Stampa giornata</h1>
      <div class="date">${esc(dateIt(date))}</div>
      <div class="counts">${esc(totals)}</div>
    </div>
    <div class="meta">Generato ${esc(new Date().toLocaleString("it-IT"))}${omittedColumns.length ? `<br>Colonne opzionali assenti: ${esc(omittedColumns.join(", "))}` : ""}</div>
  </header>
  ${tables.map(renderTable).join("")}
  ${shuttleTables.map(renderTable).join("")}
  ${excursionTable.map(renderTable).join("")}
  <div class="foot">ITS · Lista operativa compatta · ogni servizio compare una sola volta nella propria sezione.</div>
  <script>window.addEventListener("load",()=>setTimeout(()=>window.print(),150));</script>
</body>
</html>`;

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("[print-giornata] error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore stampa giornata" }, { status: 500 });
  }
}
