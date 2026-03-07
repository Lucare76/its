import { createClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { z } from "zod";
import { buildServicesQuery } from "@/lib/server/services-filter-builder";

const statusEnum = z.enum(["new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled", "needs_review"]);

const payloadSchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    status: z.array(statusEnum).default([]),
    serviceType: z.enum(["all", "transfer", "bus_tour"]).default("all"),
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
    "Data/Ora",
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
      select: "id, tenant_id, date, time, service_type, direction, vessel, pax, hotel_id, customer_name, phone, notes, meeting_point, bus_plate, status"
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
        "Data/Ora": `${service.date} ${normalizeTime(service.time)}`,
        Cliente: service.customer_name,
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

    XLSX.utils.book_append_sheet(workbook, buildSheet(transferRows.map(normalizeServiceRow)), "Transfers");
    XLSX.utils.book_append_sheet(workbook, buildSheet(busTourRows.map(normalizeServiceRow)), "Bus Tours");

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

    const timelineHeader = ["service_id", "timestamp", "old_status", "new_status", "actor"];
    const timelineAoA = [timelineHeader, ...timelineRows.map((row) => timelineHeader.map((key) => row[key as keyof typeof row] ?? ""))];
    const timelineSheet = XLSX.utils.aoa_to_sheet(timelineAoA);
    applySheetFormatting(timelineSheet, timelineAoA);
    XLSX.utils.book_append_sheet(workbook, timelineSheet, "Status events");

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
    const filename = `services_export_${filters.dateFrom}_${filters.dateTo}.xlsx`;

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
