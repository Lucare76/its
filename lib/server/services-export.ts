import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { z } from "zod";
import { formatIsoDateShort } from "@/lib/service-display";
import { buildServicesQuery } from "@/lib/server/services-filter-builder";

const statusEnum = z.enum(["new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled", "needs_review"]);

const payloadSchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.array(statusEnum).default([]),
    serviceType: z.enum(["all", "transfer", "bus_tour"]).default("all"),
    exportPreset: z
      .enum(["standard", "arrivals_bus_line", "arrivals_other_services", "departures_bus_line", "departures_other_services"])
      .default("standard"),
    ship: z.string().max(80).optional().default(""),
    zone: z.string().max(80).optional().default(""),
    hotel_id: z.string().uuid().optional(),
    search: z.string().max(200).optional().default("")
  })
  .refine((value) => value.dateFrom <= value.dateTo, {
    message: "Intervallo date non valido",
    path: ["dateFrom"]
  });

type Role = "admin" | "operator" | "driver" | "agency";

type ServiceRow = {
  id: string;
  tenant_id: string;
  date: string;
  time: string;
  service_type: "transfer" | "bus_tour";
  direction: "arrival" | "departure";
  vessel: string;
  pax: number;
  hotel_id: string;
  customer_name: string;
  billing_party_name: string | null;
  outbound_time: string | null;
  return_time: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  transport_mode: string | null;
  transport_code: string | null;
  train_arrival_number: string | null;
  train_departure_number: string | null;
  source_total_amount_cents: number | null;
  source_price_per_pax_cents: number | null;
  source_amount_currency: string | null;
  phone: string;
  notes: string;
  meeting_point: string | null;
  bus_plate: string | null;
  status: "needs_review" | "new" | "assigned" | "partito" | "arrivato" | "completato" | "problema" | "cancelled";
};

type HotelRow = {
  id: string;
  name: string;
  address: string;
  zone: string;
};

type AssignmentRow = {
  service_id: string;
  driver_user_id: string | null;
  vehicle_label: string;
};

type MembershipRow = {
  user_id: string;
  role: Role;
  full_name: string;
};

type StatusEventRow = {
  service_id: string;
  status: string;
  at: string;
  by_user_id: string | null;
};

function normalizeTime(raw: string) {
  if (!raw) return "";
  return raw.length >= 5 ? raw.slice(0, 5) : raw;
}

function parseStatuses(input: string[]) {
  const expanded = input.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  const parsed = z.array(statusEnum).safeParse(expanded);
  if (!parsed.success) {
    return { ok: false as const, error: "Status non valido." };
  }
  return { ok: true as const, value: parsed.data };
}

async function parseExportPayload(request: NextRequest) {
  if (request.method === "GET") {
    const params = request.nextUrl.searchParams;
    const parsedStatuses = parseStatuses(params.getAll("status"));
    if (!parsedStatuses.ok) {
      return { ok: false as const, status: 400, error: parsedStatuses.error };
    }

    const parsed = payloadSchema.safeParse({
      dateFrom: params.get("dateFrom") ?? "",
      dateTo: params.get("dateTo") ?? "",
      status: parsedStatuses.value,
      serviceType: params.get("serviceType") ?? "all",
      exportPreset: params.get("exportPreset") ?? "standard",
      ship: params.get("ship") ?? "",
      zone: params.get("zone") ?? "",
      hotel_id: params.get("hotel_id") ?? undefined,
      search: params.get("search") ?? ""
    });
    if (!parsed.success) {
      return { ok: false as const, status: 400, error: parsed.error.issues[0]?.message ?? "Filtri non validi." };
    }
    return { ok: true as const, value: parsed.data };
  }

  const body = await request.json().catch(() => null);
  if (!body) {
    return { ok: false as const, status: 400, error: "Payload non valido." };
  }

  const parsed = payloadSchema.safeParse({
    ...body,
    ship: typeof body.ship === "string" ? body.ship : typeof body.vessel === "string" ? body.vessel : "",
    exportPreset: typeof body.exportPreset === "string" ? body.exportPreset : "standard",
    status: Array.isArray(body.status) ? body.status : []
  });
  if (!parsed.success) {
    return { ok: false as const, status: 400, error: parsed.error.issues[0]?.message ?? "Filtri non validi." };
  }
  return { ok: true as const, value: parsed.data };
}

function applySheetFormatting(sheet: XLSX.WorkSheet, rows: unknown[][]) {
  if (rows.length > 0 && rows[0].length > 0) {
    for (let col = 0; col < rows[0].length; col += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: 0, c: col });
      const cell = sheet[cellAddress];
      if (!cell) continue;
      (cell as any).s = {
        font: { bold: true }
      };
    }
  }
  (sheet as any)["!freeze"] = { xSplit: 0, ySplit: 1 };
  sheet["!cols"] = rows[0]?.map((_, col) => {
    const widest = rows.reduce((max, row) => {
      const value = row[col];
      const length = value === null || value === undefined ? 0 : String(value).length;
      return Math.max(max, length);
    }, 10);
    return { wch: Math.min(42, widest + 2) };
  });
}

function buildSheet(rows: Array<Record<string, string | number>>) {
  const header = [
    "ID",
    "Data andata",
    "Ora andata",
    "Data ritorno",
    "Ora ritorno",
    "Costo PDF",
    "Costo PDF/pax",
    "Valuta PDF",
    "Cliente",
    "Telefono",
    "Pax",
    "Hotel",
    "Porto",
    "Zona",
    "Nave",
    "Stato",
    "Driver",
    "Mezzo",
    "Note"
  ];
  const dataRows = rows.map((row) => header.map((key) => row[key] ?? ""));
  const sheetRows = [header, ...dataRows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  applySheetFormatting(sheet, sheetRows);
  return sheet;
}

function isBusLineArrival(service: ServiceRow) {
  return service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel";
}

function operationalCategory(service: ServiceRow) {
  if (isBusLineArrival(service)) return "Linea bus";
  if (service.service_type_code === "transfer_airport_hotel" || service.booking_service_kind === "transfer_airport_hotel") {
    return "Transfer aeroporto";
  }
  if (service.service_type_code === "transfer_station_hotel" || service.booking_service_kind === "transfer_train_hotel") {
    return "Transfer stazione";
  }
  if (
    service.service_type_code === "transfer_port_hotel" ||
    service.booking_service_kind === "transfer_port_hotel" ||
    service.transport_mode === "hydrofoil" ||
    service.transport_mode === "ferry"
  ) {
    const transportReference = `${service.transport_code ?? ""} ${service.vessel ?? ""}`.toLowerCase();
    if (transportReference.includes("medmar")) return "Formula Medmar";
    if (transportReference.includes("snav")) return "Formula SNAV";
    return "Transfer porto";
  }
  return "Altri servizi";
}

function buildOperationalArrivalsSheet(
  services: ServiceRow[],
  hotelsById: Map<string, HotelRow>,
  assignmentsByServiceId: Map<string, AssignmentRow>,
  membershipsByUserId: Map<string, MembershipRow>
) {
  const header = [
    "Categoria",
    "Data arrivo",
    "Ora arrivo",
    "Cliente",
    "Pax",
    "Hotel / destinazione",
    "Meeting point",
    "Riferimento mezzo",
    "Telefono",
    "Agenzia fatturazione",
    "Driver",
    "Mezzo",
    "Costo PDF",
    "Valuta",
    "Numero pratica",
    "ID servizio",
    "Note"
  ];

  const rows = services.map((service) => {
    const hotel = hotelsById.get(service.hotel_id);
    const assignment = assignmentsByServiceId.get(service.id);
    const driverName = assignment?.driver_user_id
      ? membershipsByUserId.get(assignment.driver_user_id)?.full_name ?? assignment.driver_user_id
      : "";
    const vehicleLabel = assignment?.vehicle_label ?? service.bus_plate ?? "";
    const transportReference =
      service.transport_code ??
      service.train_arrival_number ??
      service.train_departure_number ??
      service.vessel ??
      "";

    return [
      operationalCategory(service),
      formatIsoDateShort(service.arrival_date ?? service.date),
      normalizeTime(service.arrival_time ?? service.outbound_time ?? service.time),
      service.customer_name,
      service.pax,
      hotel?.name ?? "",
      service.meeting_point ?? "",
      transportReference,
      service.phone ?? "",
      service.billing_party_name ?? "",
      driverName,
      vehicleLabel,
      service.source_total_amount_cents === null ? "" : (service.source_total_amount_cents / 100).toFixed(2),
      service.source_amount_currency ?? "",
      service.notes.match(/\[practice:([^\]]+)\]/i)?.[1] ?? "",
      service.id,
      service.notes ?? ""
    ];
  });

  const sheetRows = [header, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  applySheetFormatting(sheet, sheetRows);
  return sheet;
}

function buildOperationalDeparturesSheet(
  services: ServiceRow[],
  hotelsById: Map<string, HotelRow>,
  assignmentsByServiceId: Map<string, AssignmentRow>,
  membershipsByUserId: Map<string, MembershipRow>
) {
  const header = [
    "Categoria",
    "Data partenza",
    "Ora partenza",
    "Cliente",
    "Pax",
    "Origine / hotel",
    "Meeting point",
    "Riferimento mezzo",
    "Telefono",
    "Agenzia fatturazione",
    "Driver",
    "Mezzo",
    "Costo PDF",
    "Valuta",
    "Numero pratica",
    "ID servizio",
    "Note"
  ];

  const rows = services.map((service) => {
    const hotel = hotelsById.get(service.hotel_id);
    const assignment = assignmentsByServiceId.get(service.id);
    const driverName = assignment?.driver_user_id
      ? membershipsByUserId.get(assignment.driver_user_id)?.full_name ?? assignment.driver_user_id
      : "";
    const vehicleLabel = assignment?.vehicle_label ?? service.bus_plate ?? "";
    const transportReference =
      service.transport_code ??
      service.train_departure_number ??
      service.train_arrival_number ??
      service.vessel ??
      "";

    return [
      operationalCategory(service),
      formatIsoDateShort(service.departure_date ?? ""),
      normalizeTime(service.departure_time ?? service.return_time ?? ""),
      service.customer_name,
      service.pax,
      hotel?.name ?? "",
      service.meeting_point ?? "",
      transportReference,
      service.phone ?? "",
      service.billing_party_name ?? "",
      driverName,
      vehicleLabel,
      service.source_total_amount_cents === null ? "" : (service.source_total_amount_cents / 100).toFixed(2),
      service.source_amount_currency ?? "",
      service.notes.match(/\[practice:([^\]]+)\]/i)?.[1] ?? "",
      service.id,
      service.notes ?? ""
    ];
  });

  const sheetRows = [header, ...rows];
  const sheet = XLSX.utils.aoa_to_sheet(sheetRows);
  applySheetFormatting(sheet, sheetRows);
  return sheet;
}

export async function buildServicesExportXlsx(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = request.headers.get("authorization");

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    }
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Sessione non valida. Effettua di nuovo il login." }, { status: 401 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const token = authHeader.slice("Bearer ".length);
    const {
      data: { user },
      error: authError
    } = await admin.auth.getUser(token);

    if (authError || !user) {
      return NextResponse.json({ error: "Sessione non valida. Effettua di nuovo il login." }, { status: 401 });
    }

    const parsed = await parseExportPayload(request);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: parsed.status });
    }
    const filters = parsed.value;

    const { data: memberships, error: membershipsError } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", user.id);

    if (membershipsError || !memberships || memberships.length === 0) {
      return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
    }

    const membership = memberships[0] as { tenant_id: string; role: Role };
    const { tenant_id: tenantId, role } = membership;

    if (role === "driver") {
      return NextResponse.json({ error: "Ruolo driver non autorizzato all'export." }, { status: 403 });
    }

    const builtBaseQuery = (await buildServicesQuery({
      admin,
      filters: {
        tenant_id: tenantId,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        status: filters.status,
        ship: filters.ship,
        zone: filters.zone,
        hotel_id: filters.hotel_id,
        search: filters.search,
        agency_id: role === "agency" ? user.id : undefined
      },
      select:
        "id, tenant_id, date, time, service_type, direction, vessel, pax, hotel_id, customer_name, billing_party_name, outbound_time, return_time, arrival_date, arrival_time, departure_date, departure_time, booking_service_kind, service_type_code, transport_mode, transport_code, train_arrival_number, train_departure_number, source_total_amount_cents, source_price_per_pax_cents, source_amount_currency, phone, notes, meeting_point, bus_plate, status"
    })) as any;

    let servicesQuery = builtBaseQuery.order("date", { ascending: true }).order("time", { ascending: true });

    if (filters.serviceType !== "all") {
      servicesQuery = servicesQuery.eq("service_type", filters.serviceType);
    }

    const { data: servicesData, error: servicesError } = await servicesQuery;
    if (servicesError) {
      console.error("Export services read error", servicesError.message);
      return NextResponse.json({ error: "Errore nel caricamento servizi." }, { status: 500 });
    }

    const services = (servicesData ?? []) as ServiceRow[];
    const serviceIds = services.map((service) => service.id);
    const hotelIds = Array.from(new Set(services.map((service) => service.hotel_id)));

    const [{ data: hotelsData }, { data: assignmentsData }, { data: tenantMembershipsData }, { data: statusEventsData }] =
      await Promise.all([
        hotelIds.length > 0
          ? admin.from("hotels").select("id, name, address, zone").eq("tenant_id", tenantId).in("id", hotelIds)
          : Promise.resolve({ data: [] }),
        serviceIds.length > 0
          ? admin
              .from("assignments")
              .select("service_id, driver_user_id, vehicle_label")
              .eq("tenant_id", tenantId)
              .in("service_id", serviceIds)
          : Promise.resolve({ data: [] }),
        admin.from("memberships").select("user_id, role, full_name").eq("tenant_id", tenantId),
        serviceIds.length > 0
          ? admin
              .from("status_events")
              .select("service_id, status, at, by_user_id")
              .eq("tenant_id", tenantId)
              .in("service_id", serviceIds)
              .order("at", { ascending: true })
          : Promise.resolve({ data: [] })
      ]);

    const hotelsById = new Map((hotelsData as HotelRow[] | null ?? []).map((hotel) => [hotel.id, hotel]));
    const assignmentsByServiceId = new Map(
      (assignmentsData as AssignmentRow[] | null ?? []).map((assignment) => [assignment.service_id, assignment])
    );
    const membershipsByUserId = new Map(
      (tenantMembershipsData as MembershipRow[] | null ?? []).map((member) => [member.user_id, member])
    );

    const filteredServices = services;

    const workbook = XLSX.utils.book_new();
    const transferRows = filteredServices.filter((service) => (service.service_type ?? "transfer") === "transfer");
    const busTourRows = filteredServices.filter((service) => (service.service_type ?? "transfer") === "bus_tour");

    const normalizeServiceRow = (service: ServiceRow) => {
      const hotel = hotelsById.get(service.hotel_id);
      const assignment = assignmentsByServiceId.get(service.id);
      const driverName = assignment?.driver_user_id
        ? membershipsByUserId.get(assignment.driver_user_id)?.full_name ?? assignment.driver_user_id
        : "";
      const vehicleLabel = assignment?.vehicle_label ?? service.bus_plate ?? "";
      const porto = service.meeting_point ?? service.vessel ?? "";

      return {
        ID: service.id,
        "Data andata": formatIsoDateShort(service.date),
        "Ora andata": normalizeTime(service.outbound_time ?? service.time),
        "Data ritorno": service.departure_date ? formatIsoDateShort(service.departure_date) : "",
        "Ora ritorno": normalizeTime(service.return_time ?? ""),
        "Costo PDF": service.source_total_amount_cents === null ? "" : (service.source_total_amount_cents / 100).toFixed(2),
        "Costo PDF/pax": service.source_price_per_pax_cents === null ? "" : (service.source_price_per_pax_cents / 100).toFixed(2),
        "Valuta PDF": service.source_amount_currency ?? "",
        Cliente: service.customer_name,
        "Agenzia fatturazione": service.billing_party_name ?? "",
        Telefono: service.phone ?? "",
        Pax: service.pax,
        Hotel: hotel?.name ?? "",
        Porto: porto,
        Zona: hotel?.zone ?? "",
        Nave: service.vessel ?? "",
        Stato: service.status,
        Driver: driverName,
        Mezzo: vehicleLabel,
        Note: service.notes ?? ""
      };
    };

    if (
      filters.exportPreset === "arrivals_bus_line" ||
      filters.exportPreset === "arrivals_other_services" ||
      filters.exportPreset === "departures_bus_line" ||
      filters.exportPreset === "departures_other_services"
    ) {
      const arrivalsForDate = filteredServices.filter((service) => (service.arrival_date ?? service.date) >= filters.dateFrom && (service.arrival_date ?? service.date) <= filters.dateTo);
      const departuresForDate = filteredServices.filter(
        (service) => Boolean(service.departure_date) && (service.departure_date ?? "") >= filters.dateFrom && (service.departure_date ?? "") <= filters.dateTo
      );
      const presetRows =
        filters.exportPreset === "arrivals_bus_line"
          ? arrivalsForDate.filter((service) => isBusLineArrival(service))
          : filters.exportPreset === "arrivals_other_services"
            ? arrivalsForDate.filter((service) => !isBusLineArrival(service))
            : filters.exportPreset === "departures_bus_line"
              ? departuresForDate.filter((service) => isBusLineArrival(service))
              : departuresForDate.filter((service) => !isBusLineArrival(service));

      const isDeparturePreset = filters.exportPreset.startsWith("departures_");
      XLSX.utils.book_append_sheet(
        workbook,
        isDeparturePreset
          ? buildOperationalDeparturesSheet(presetRows, hotelsById, assignmentsByServiceId, membershipsByUserId)
          : buildOperationalArrivalsSheet(presetRows, hotelsById, assignmentsByServiceId, membershipsByUserId),
        filters.exportPreset === "arrivals_bus_line"
          ? "Arrivi Linea Bus"
          : filters.exportPreset === "arrivals_other_services"
            ? "Arrivi Altri Servizi"
            : filters.exportPreset === "departures_bus_line"
              ? "Partenze Linea Bus"
              : "Partenze Altri Servizi"
      );
    } else {
      XLSX.utils.book_append_sheet(workbook, buildSheet(transferRows.map(normalizeServiceRow)), "Transfers");
      XLSX.utils.book_append_sheet(workbook, buildSheet(busTourRows.map(normalizeServiceRow)), "Bus Tours");
    }

    const timelineRows: Array<{
      service_id: string;
      timestamp: string;
      old_status: string;
      new_status: string;
      actor: string;
    }> = [];

    const eventsByService = new Map<string, StatusEventRow[]>();
    for (const event of (statusEventsData as StatusEventRow[] | null ?? [])) {
      const existing = eventsByService.get(event.service_id) ?? [];
      existing.push(event);
      eventsByService.set(event.service_id, existing);
    }

    for (const [serviceId, events] of eventsByService.entries()) {
      let previousStatus = "";
      for (const event of events) {
        const actor = event.by_user_id
          ? membershipsByUserId.get(event.by_user_id)?.full_name ?? event.by_user_id
          : "system";

        timelineRows.push({
          service_id: serviceId,
          timestamp: event.at,
          old_status: previousStatus,
          new_status: event.status,
          actor
        });
        previousStatus = event.status;
      }
    }

    if (filters.exportPreset === "standard") {
      const timelineHeader = ["service_id", "timestamp", "old_status", "new_status", "actor"];
      const timelineAoA = [timelineHeader, ...timelineRows.map((row) => timelineHeader.map((key) => row[key as keyof typeof row] ?? ""))];
      const timelineSheet = XLSX.utils.aoa_to_sheet(timelineAoA);
      applySheetFormatting(timelineSheet, timelineAoA);
      XLSX.utils.book_append_sheet(workbook, timelineSheet, "Status events");
    }

    if (filteredServices.length > 0) {
      const { error: auditError } = await admin.from("export_audits").insert({
        tenant_id: tenantId,
        user_id: user.id,
        date_from: filters.dateFrom,
        date_to: filters.dateTo,
        service_type: filters.serviceType,
        exported_count: filteredServices.length
      });
      if (auditError) {
        console.error("Export audit insert error", auditError.message);
      }
    }

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename =
      filters.exportPreset === "arrivals_bus_line"
        ? `arrivi_linea_bus_${filters.dateFrom}_${filters.dateTo}.xlsx`
        : filters.exportPreset === "arrivals_other_services"
          ? `arrivi_altri_servizi_${filters.dateFrom}_${filters.dateTo}.xlsx`
          : filters.exportPreset === "departures_bus_line"
            ? `partenze_linea_bus_${filters.dateFrom}_${filters.dateTo}.xlsx`
            : filters.exportPreset === "departures_other_services"
              ? `partenze_altri_servizi_${filters.dateFrom}_${filters.dateTo}.xlsx`
          : `services_export_${filters.dateFrom}_${filters.dateTo}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Export endpoint unexpected error", error);
    return NextResponse.json({ error: "Errore export. Riprova tra poco." }, { status: 500 });
  }
}
