import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { z } from "zod";

type Role = "admin" | "operator" | "driver" | "agency";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const querySchema = z
  .object({
    dateFrom: dateSchema.optional(),
    dateTo: dateSchema.optional()
  })
  .refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, {
    message: "Intervallo date non valido."
  });

type ServiceRow = {
  id: string;
  date: string;
  time: string;
  vessel: string;
  hotel_id: string;
  customer_name: string;
  status: string;
};

type HotelRow = {
  id: string;
  name: string;
  zone: string;
};

type StatusEventRow = {
  service_id: string;
  status: string;
  at: string;
};

type AssignmentRow = {
  service_id: string;
  driver_user_id: string | null;
};

type DriverMembershipRow = {
  user_id: string;
  full_name: string;
};

type AnalyticsContext = {
  admin: SupabaseClient;
  userId: string;
  tenantId: string;
};

type PunctualityRow = {
  service_id: string;
  date: string;
  time: string;
  customer_name: string;
  vessel: string;
  zone: string;
  hotel_name: string;
  scheduled_at: string;
  actual_at: string | null;
  delay_minutes: number | null;
  punctuality: "on_time" | "delayed" | "missing";
};

type CountItem = {
  label: string;
  count: number;
};

type DriverWeeklyLoadItem = {
  driver_user_id: string;
  driver_name: string;
  total_assigned: number;
  by_day: {
    lun: number;
    mar: number;
    mer: number;
    gio: number;
    ven: number;
    sab: number;
    dom: number;
  };
};

type AnalyticsPayload = {
  dateFrom: string;
  dateTo: string;
  punctualityThresholdMinutes: number;
  kpi: {
    totalServices: number;
    onTime: number;
    delayed: number;
    missing: number;
    evaluated: number;
    punctualityRate: number;
  };
  servicesByVessel: CountItem[];
  servicesByZone: CountItem[];
  driverWeeklyLoad: DriverWeeklyLoadItem[];
  punctualityTable: PunctualityRow[];
  weeklyWindow: {
    from: string;
    to: string;
  };
};

function formatDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function defaultDateRange() {
  const today = new Date();
  return {
    dateFrom: formatDate(addDays(today, -29)),
    dateTo: formatDate(today)
  };
}

function normalizeTime(raw: string) {
  if (!raw) return "00:00";
  return raw.length >= 5 ? raw.slice(0, 5) : raw.padEnd(5, ":00");
}

function toDateTime(date: string, time: string) {
  return new Date(`${date}T${normalizeTime(time)}:00`);
}

function getWeekdayKey(dateIso: string): keyof DriverWeeklyLoadItem["by_day"] {
  const keys: Array<keyof DriverWeeklyLoadItem["by_day"]> = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
  const date = new Date(`${dateIso}T12:00:00`);
  const jsDay = date.getDay();
  const mondayBased = (jsDay + 6) % 7;
  return keys[mondayBased] ?? "lun";
}

function weekRange(referenceIso: string) {
  const date = new Date(`${referenceIso}T12:00:00`);
  const mondayOffset = (date.getDay() + 6) % 7;
  const start = addDays(date, -mondayOffset);
  const end = addDays(start, 6);
  return {
    from: formatDate(start),
    to: formatDate(end)
  };
}

function asCountItems(map: Map<string, number>) {
  return Array.from(map.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

async function resolveContext(request: NextRequest): Promise<AnalyticsContext | NextResponse> {
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

  const { data: memberships, error: membershipsError } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id);

  if (membershipsError || !memberships || memberships.length === 0) {
    return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
  }

  const membership = memberships[0] as { tenant_id: string; role: Role };
  if (membership.role !== "admin" && membership.role !== "operator") {
    return NextResponse.json({ error: "Ruolo non autorizzato alle analytics." }, { status: 403 });
  }

  return {
    admin,
    userId: user.id,
    tenantId: membership.tenant_id
  };
}

async function computeAnalytics(
  admin: SupabaseClient,
  tenantId: string,
  dateFrom: string,
  dateTo: string,
  punctualityThresholdMinutes: number
): Promise<AnalyticsPayload> {
  const { data: servicesData, error: servicesError } = await admin
    .from("services")
    .select("id, date, time, vessel, hotel_id, customer_name, status")
    .eq("tenant_id", tenantId)
    .gte("date", dateFrom)
    .lte("date", dateTo)
    .order("date", { ascending: true })
    .order("time", { ascending: true });

  if (servicesError) throw new Error(`Servizi non disponibili: ${servicesError.message}`);

  const services = (servicesData ?? []) as ServiceRow[];
  const serviceIds = services.map((item) => item.id);
  const hotelIds = Array.from(new Set(services.map((item) => item.hotel_id)));

  const [{ data: hotelsData }, { data: eventsData }] = await Promise.all([
    hotelIds.length > 0
      ? admin.from("hotels").select("id, name, zone").eq("tenant_id", tenantId).in("id", hotelIds)
      : Promise.resolve({ data: [] }),
    serviceIds.length > 0
      ? admin
          .from("status_events")
          .select("service_id, status, at")
          .eq("tenant_id", tenantId)
          .in("service_id", serviceIds)
          .in("status", ["arrivato", "completato"])
          .order("at", { ascending: true })
      : Promise.resolve({ data: [] })
  ]);

  const hotelsById = new Map((hotelsData as HotelRow[] | null ?? []).map((hotel) => [hotel.id, hotel]));

  const firstActualByService = new Map<string, string>();
  for (const event of (eventsData as StatusEventRow[] | null ?? [])) {
    if (!firstActualByService.has(event.service_id)) {
      firstActualByService.set(event.service_id, event.at);
    }
  }

  const thresholdMs = Math.max(1, punctualityThresholdMinutes) * 60 * 1000;
  let onTime = 0;
  let delayed = 0;
  let missing = 0;

  const vesselMap = new Map<string, number>();
  const zoneMap = new Map<string, number>();
  const punctualityTable: PunctualityRow[] = [];

  for (const service of services) {
    const hotel = hotelsById.get(service.hotel_id);
    const vesselLabel = service.vessel || "N/D";
    const zoneLabel = hotel?.zone ?? "N/D";
    vesselMap.set(vesselLabel, (vesselMap.get(vesselLabel) ?? 0) + 1);
    zoneMap.set(zoneLabel, (zoneMap.get(zoneLabel) ?? 0) + 1);

    const scheduledAt = toDateTime(service.date, service.time);
    const actualAtIso = firstActualByService.get(service.id) ?? null;
    const actualAt = actualAtIso ? new Date(actualAtIso) : null;
    const delayMinutes = actualAt ? Math.round((actualAt.getTime() - scheduledAt.getTime()) / 60000) : null;

    let punctuality: PunctualityRow["punctuality"] = "missing";
    if (delayMinutes === null) {
      missing += 1;
    } else if (delayMinutes * 60000 <= thresholdMs) {
      punctuality = "on_time";
      onTime += 1;
    } else {
      punctuality = "delayed";
      delayed += 1;
    }

    punctualityTable.push({
      service_id: service.id,
      date: service.date,
      time: normalizeTime(service.time),
      customer_name: service.customer_name,
      vessel: vesselLabel,
      zone: zoneLabel,
      hotel_name: hotel?.name ?? "N/D",
      scheduled_at: `${service.date} ${normalizeTime(service.time)}`,
      actual_at: actualAtIso,
      delay_minutes: delayMinutes,
      punctuality
    });
  }

  const evaluated = onTime + delayed;
  const punctualityRate = evaluated > 0 ? Math.round((onTime / evaluated) * 1000) / 10 : 0;

  const weeklyWindow = weekRange(dateTo);
  const { data: weeklyServicesData, error: weeklyServicesError } = await admin
    .from("services")
    .select("id, date")
    .eq("tenant_id", tenantId)
    .gte("date", weeklyWindow.from)
    .lte("date", weeklyWindow.to);
  if (weeklyServicesError) throw new Error(`Servizi settimana non disponibili: ${weeklyServicesError.message}`);

  const weeklyServices = (weeklyServicesData ?? []) as Array<{ id: string; date: string }>;
  const weeklyServiceIds = weeklyServices.map((item) => item.id);
  const weeklyDateByServiceId = new Map(weeklyServices.map((item) => [item.id, item.date]));

  const [{ data: weeklyAssignmentsData }, { data: driversData }] = await Promise.all([
    weeklyServiceIds.length > 0
      ? admin
          .from("assignments")
          .select("service_id, driver_user_id")
          .eq("tenant_id", tenantId)
          .in("service_id", weeklyServiceIds)
      : Promise.resolve({ data: [] }),
    admin.from("memberships").select("user_id, full_name").eq("tenant_id", tenantId).eq("role", "driver")
  ]);

  const driversById = new Map((driversData as DriverMembershipRow[] | null ?? []).map((item) => [item.user_id, item.full_name]));
  const loadMap = new Map<string, DriverWeeklyLoadItem>();

  for (const assignment of (weeklyAssignmentsData as AssignmentRow[] | null ?? [])) {
    if (!assignment.driver_user_id) continue;
    const serviceDate = weeklyDateByServiceId.get(assignment.service_id);
    if (!serviceDate) continue;
    const weekday = getWeekdayKey(serviceDate);
    const current = loadMap.get(assignment.driver_user_id) ?? {
      driver_user_id: assignment.driver_user_id,
      driver_name: driversById.get(assignment.driver_user_id) ?? assignment.driver_user_id,
      total_assigned: 0,
      by_day: { lun: 0, mar: 0, mer: 0, gio: 0, ven: 0, sab: 0, dom: 0 }
    };

    current.total_assigned += 1;
    current.by_day[weekday] += 1;
    loadMap.set(assignment.driver_user_id, current);
  }

  const driverWeeklyLoad = Array.from(loadMap.values()).sort(
    (a, b) => b.total_assigned - a.total_assigned || a.driver_name.localeCompare(b.driver_name)
  );

  return {
    dateFrom,
    dateTo,
    punctualityThresholdMinutes,
    kpi: {
      totalServices: services.length,
      onTime,
      delayed,
      missing,
      evaluated,
      punctualityRate
    },
    servicesByVessel: asCountItems(vesselMap),
    servicesByZone: asCountItems(zoneMap),
    driverWeeklyLoad,
    punctualityTable,
    weeklyWindow
  };
}

function parseQueryParams(request: NextRequest) {
  const defaults = defaultDateRange();
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    dateFrom: url.searchParams.get("dateFrom") ?? undefined,
    dateTo: url.searchParams.get("dateTo") ?? undefined
  });

  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Filtri non validi." } as const;

  return {
    dateFrom: parsed.data.dateFrom ?? defaults.dateFrom,
    dateTo: parsed.data.dateTo ?? defaults.dateTo
  } as const;
}

function normalizeSheetName(value: string) {
  return value.replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
}

export async function buildAnalyticsSummaryResponse(request: NextRequest) {
  try {
    const context = await resolveContext(request);
    if (context instanceof NextResponse) return context;

    const parsed = parseQueryParams(request);
    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const threshold = Number(process.env.ANALYTICS_PUNCTUALITY_THRESHOLD_MINUTES ?? "15");
    const payload = await computeAnalytics(
      context.admin,
      context.tenantId,
      parsed.dateFrom,
      parsed.dateTo,
      Number.isFinite(threshold) ? threshold : 15
    );

    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("Analytics summary unexpected error", error);
    return NextResponse.json({ error: "Errore analytics. Riprova tra poco." }, { status: 500 });
  }
}

export async function buildAnalyticsExportXlsxResponse(request: NextRequest) {
  try {
    const context = await resolveContext(request);
    if (context instanceof NextResponse) return context;

    const body = querySchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: body.error.issues[0]?.message ?? "Filtri non validi." }, { status: 400 });
    }

    const defaults = defaultDateRange();
    const threshold = Number(process.env.ANALYTICS_PUNCTUALITY_THRESHOLD_MINUTES ?? "15");
    const payload = await computeAnalytics(
      context.admin,
      context.tenantId,
      body.data.dateFrom ?? defaults.dateFrom,
      body.data.dateTo ?? defaults.dateTo,
      Number.isFinite(threshold) ? threshold : 15
    );

    const workbook = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        { KPI: "Servizi periodo", Valore: payload.kpi.totalServices },
        { KPI: "Puntualita %", Valore: payload.kpi.punctualityRate },
        { KPI: "On time", Valore: payload.kpi.onTime },
        { KPI: "In ritardo", Valore: payload.kpi.delayed },
        { KPI: "Senza evento arrivo/completato", Valore: payload.kpi.missing },
        { KPI: "Soglia puntualita (min)", Valore: payload.punctualityThresholdMinutes }
      ]),
      "kpi"
    );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(payload.servicesByVessel.map((item) => ({ Nave: item.label, Servizi: item.count }))),
      normalizeSheetName("servizi_per_nave")
    );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(payload.servicesByZone.map((item) => ({ Zona: item.label, Servizi: item.count }))),
      normalizeSheetName("servizi_per_zona")
    );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        payload.driverWeeklyLoad.map((item) => ({
          Driver: item.driver_name,
          Totale: item.total_assigned,
          Lun: item.by_day.lun,
          Mar: item.by_day.mar,
          Mer: item.by_day.mer,
          Gio: item.by_day.gio,
          Ven: item.by_day.ven,
          Sab: item.by_day.sab,
          Dom: item.by_day.dom
        }))
      ),
      normalizeSheetName("carico_driver_settimanale")
    );

    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(
        payload.punctualityTable.map((item) => ({
          ID: item.service_id,
          Data: item.date,
          Ora: item.time,
          Cliente: item.customer_name,
          Nave: item.vessel,
          Zona: item.zone,
          Hotel: item.hotel_name,
          Programmato: item.scheduled_at,
          Effettivo: item.actual_at ?? "",
          "Ritardo min": item.delay_minutes ?? "",
          Esito: item.punctuality
        }))
      ),
      normalizeSheetName("puntualita_servizi")
    );

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    const filename = `analytics_report_${payload.dateFrom}_${payload.dateTo}.xlsx`;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    console.error("Analytics export unexpected error", error);
    return NextResponse.json({ error: "Errore export analytics. Riprova tra poco." }, { status: 500 });
  }
}
