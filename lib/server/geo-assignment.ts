import type { SupabaseClient } from "@supabase/supabase-js";

export type GeoArea = "nord_ovest" | "est_sud" | null;
export type GeoSeverity = "ok" | "warning" | "block";

export type GeographicCompatibilityResult = {
  compatible: boolean;
  severity: GeoSeverity;
  requiredMinutes: number;
  availableMinutes: number;
  marginMinutes: number;
  fromZone: string | null;
  toZone: string | null;
  fromArea: GeoArea;
  toArea: GeoArea;
  reason: string;
};

export type GeographicCompatibilityService = {
  id?: string | null;
  label?: string | null;
  startTime: string;
  endTime?: string | null;
  startZone?: string | null;
  endZone?: string | null;
  startArea?: GeoArea;
  endArea?: GeoArea;
};

export type GeographicCompatibilityConfig = {
  sameAreaMinutes?: number;
  crossAreaMinutes?: number;
  unknownZoneMinutes?: number;
  warningMarginMinutes?: number;
};

const DEFAULT_CONFIG = {
  sameAreaMinutes: 10,
  crossAreaMinutes: 20,
  unknownZoneMinutes: 15,
  warningMarginMinutes: 5,
};

const NORTH_WEST_ZONE_PATTERNS = [
  "casamicciola",
  "lacco",
  "forio",
  "sant'angelo",
  "sant angelo",
  "panza",
  "serrara",
  "fontana",
  "cuotto",
  "citara",
];

const EAST_SOUTH_ZONE_PATTERNS = [
  "ischia porto",
  "porto ischia",
  "ischia ponte",
  "barano",
  "fiaiano",
  "cartaromana",
  "testaccio",
  "ischia",
];

export function minutesFromTime(value: string | null | undefined): number {
  const [hourRaw = "0", minuteRaw = "0"] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number.parseInt(hourRaw, 10);
  const minute = Number.parseInt(minuteRaw, 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

export function formatMinutesAsTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

export function normalizeGeoZone(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "—" || raw.toLowerCase() === "sconosciuto") return null;
  const lower = raw.toLowerCase();
  if (lower.includes("casamicciola")) return "Casamicciola";
  if (lower.includes("lacco")) return "Lacco Ameno";
  if (lower.includes("forio")) return "Forio";
  if (lower.includes("sant") || lower.includes("angelo")) return "Sant'Angelo";
  if (lower.includes("panza")) return "Panza";
  if (lower.includes("serrara") || lower.includes("fontana")) return "Serrara Fontana";
  if (lower.includes("ischia ponte")) return "Ischia Ponte";
  if (lower.includes("ischia porto") || lower.includes("porto ischia") || lower.includes("uscita arrivi")) return "Ischia Porto";
  if (lower === "ischia") return "Ischia Porto";
  if (lower.includes("barano")) return "Barano";
  if (lower.includes("fiaiano")) return "Fiaiano";
  if (lower.includes("cartaromana")) return "Cartaromana";
  return raw;
}

export function zoneToGeoArea(zone: string | null | undefined): GeoArea {
  const normalized = normalizeGeoZone(zone);
  const lower = normalized?.toLowerCase() ?? "";
  if (!lower) return null;
  if (NORTH_WEST_ZONE_PATTERNS.some((pattern) => lower.includes(pattern))) return "nord_ovest";
  if (EAST_SOUTH_ZONE_PATTERNS.some((pattern) => lower.includes(pattern))) return "est_sud";
  return null;
}

export function requiredTransferMinutes(fromArea: GeoArea, toArea: GeoArea, config: GeographicCompatibilityConfig = {}): number {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!fromArea || !toArea) return cfg.unknownZoneMinutes;
  return fromArea === toArea ? cfg.sameAreaMinutes : cfg.crossAreaMinutes;
}

export function validateGeographicCompatibility(
  previousService: GeographicCompatibilityService,
  nextService: GeographicCompatibilityService,
  config: GeographicCompatibilityConfig = {}
): GeographicCompatibilityResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const fromZone = normalizeGeoZone(previousService.endZone ?? previousService.startZone);
  const toZone = normalizeGeoZone(nextService.startZone ?? nextService.endZone);
  const fromArea = previousService.endArea ?? zoneToGeoArea(fromZone);
  const toArea = nextService.startArea ?? zoneToGeoArea(toZone);
  const previousEnd = minutesFromTime(previousService.endTime ?? previousService.startTime);
  const nextStart = minutesFromTime(nextService.startTime);
  const availableMinutes = nextStart - previousEnd;
  const requiredMinutes = requiredTransferMinutes(fromArea, toArea, cfg);
  const marginMinutes = availableMinutes - requiredMinutes;

  if (availableMinutes < requiredMinutes) {
    return {
      compatible: false,
      severity: "block",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Trasferimento geografico insufficiente: ${availableMinutes} minuti disponibili, ${requiredMinutes} richiesti da ${fromZone ?? "zona sconosciuta"} a ${toZone ?? "zona sconosciuta"}.`,
    };
  }

  if (!fromArea || !toArea) {
    return {
      compatible: true,
      severity: "warning",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Zona non completa: verifica manualmente il trasferimento da ${fromZone ?? "zona sconosciuta"} a ${toZone ?? "zona sconosciuta"}.`,
    };
  }

  if (marginMinutes < cfg.warningMarginMinutes) {
    return {
      compatible: true,
      severity: "warning",
      requiredMinutes,
      availableMinutes,
      marginMinutes,
      fromZone,
      toZone,
      fromArea,
      toArea,
      reason: `Margine geografico stretto: ${availableMinutes} minuti disponibili, ${requiredMinutes} richiesti.`,
    };
  }

  return {
    compatible: true,
    severity: "ok",
    requiredMinutes,
    availableMinutes,
    marginMinutes,
    fromZone,
    toZone,
    fromArea,
    toArea,
    reason: "Compatibile.",
  };
}

export function strongestGeographicResult(results: GeographicCompatibilityResult[]): GeographicCompatibilityResult | null {
  if (!results.length) return null;
  return [...results].sort((a, b) => {
    const severityScore: Record<GeoSeverity, number> = { block: 0, warning: 1, ok: 2 };
    return severityScore[a.severity] - severityScore[b.severity] || a.marginMinutes - b.marginMinutes;
  })[0] ?? null;
}

export function geographicBlockMessage(driverName: string, result: GeographicCompatibilityResult): string {
  return [
    "ASSEGNAZIONE IMPOSSIBILE",
    "",
    `L'autista ${driverName} ha gia un servizio in zona ${result.fromZone ?? "sconosciuta"}.`,
    `Il nuovo servizio richiede presenza in zona ${result.toZone ?? "sconosciuta"}.`,
    "",
    `Tempo disponibile: ${result.availableMinutes} minuti.`,
    `Tempo minimo richiesto: ${result.requiredMinutes} minuti.`,
    "",
    "Scegli un altro autista o riassegna uno dei servizi.",
  ].join("\n");
}

// ─── Validazione geografica di un batch driver (FUNC-01) ─────────────────────
// Usata da assign-service (batch di un solo servizio) e da departure-bus-assign
// (batch di più service_ids che compongono un unico giro bus). Il batch è
// sempre trattato come un'unica finestra operativa (dal primo pickup al
// servizio più tardo), mai validato servizio per servizio: un giro con più
// tappe non deve generare falsi conflitti tra le proprie tappe interne.

export type TripGeoServiceRow = {
  id: string;
  date: string;
  time: string;
  pickup_hotel: string | null;
  direction: "arrival" | "departure";
  hotel_id: string | null;
  meeting_point: string | null;
};

export type TripGeoHotelRow = {
  id: string;
  zone: string | null;
};

export type DriverGeographicBatchResult =
  | { ok: true }
  | { ok: false; kind: "query_error"; error: string }
  | { ok: false; kind: "block"; error: string };

export function tripServiceOperationalTime(service: TripGeoServiceRow): string {
  return service.direction === "departure"
    ? (service.pickup_hotel ?? service.time).slice(0, 5)
    : service.time.slice(0, 5);
}

export function tripOperationalMinutes(value: string): number {
  const [h, m] = value.slice(0, 5).split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function tripServiceToGeographicWindow(
  service: TripGeoServiceRow,
  hotels: Map<string, TripGeoHotelRow>
): GeographicCompatibilityService {
  const hotelZone = service.hotel_id ? hotels.get(service.hotel_id)?.zone ?? null : null;
  const startTime = tripServiceOperationalTime(service);
  if (service.direction === "departure") {
    return { id: service.id, startTime, startZone: hotelZone, endZone: service.meeting_point };
  }
  return { id: service.id, startTime, startZone: service.meeting_point, endZone: hotelZone };
}

export function tripServicesToGeographicWindow(
  services: TripGeoServiceRow[],
  hotels: Map<string, TripGeoHotelRow>
): GeographicCompatibilityService {
  const windows = [...services]
    .sort((a, b) => tripOperationalMinutes(tripServiceOperationalTime(a)) - tripOperationalMinutes(tripServiceOperationalTime(b)))
    .map((service) => tripServiceToGeographicWindow(service, hotels));
  const first = windows[0];
  const last = windows[windows.length - 1] ?? first;
  return {
    id: services.map((service) => service.id).join(","),
    startTime: first?.startTime ?? "00:00",
    startZone: first?.startZone ?? null,
    startArea: first?.startArea ?? null,
    endZone: last?.endZone ?? first?.endZone ?? null,
    endArea: last?.endArea ?? first?.endArea ?? null,
  };
}

// Valida un batch di servizi (un nuovo giro) contro gli altri giri già
// assegnati allo stesso driver. I service_id del batch sono sempre esclusi
// dagli "altri giri" del driver, anche se già presenti in assignments (caso
// di riassegnazione dello stesso giro allo stesso driver).
//
// FUNC-01 (group_id=null residuo): la query non filtra più su
// group_id IS NOT NULL. Le assegnazioni scritte da departure-bus-assign hanno
// sempre group_id=null per design (quella route non usa trip_groups — vedi
// commento RACE-01 in app/api/ops/departure-bus-assign/route.ts), quindi
// erano finora invisibili a questo controllo: un giro bus già assegnato allo
// stesso driver non veniva mai confrontato geograficamente con un nuovo
// batch, né via departure-bus-assign né via assign-service. Includerle
// richiede due accorgimenti, entrambi implementati sotto:
//   1. raggruppamento — senza un batch id persistito, il segnale reale più
//      affidabile per capire quali service_id appartengono allo stesso giro
//      bus è assigned_at: ogni upsert di assign_driver scrive lo stesso
//      timestamp (calcolato una sola volta) su tutte le righe del batch in
//      un solo statement, quindi righe con lo stesso assigned_at sono sempre
//      lo stesso giro. Righe storiche prive di assigned_at (precedenti alla
//      colonna, migrazione 0198) restano finestre singole per service_id:
//      nessuna aggregazione presunta, mai un'omissione, al più un confronto
//      pairwise in più tra tappe dello stesso giro storico.
//   2. filtro data — la finestra geografica confronta solo l'orario (HH:MM),
//      senza mai considerare la data. Finché "altri giri" erano solo quelli
//      con group_id valorizzato (pochi, tipicamente dello stesso giorno) il
//      rischio era marginale; includendo anche i giri departure-bus-assign
//      (che si accumulano su molte date per lo stesso driver, spesso con
//      orari ricorrenti) va escluso esplicitamente ogni confronto tra date
//      diverse, altrimenti un giro di un altro giorno genererebbe un falso
//      conflitto sulla sola coincidenza dell'orario.
export async function validateDriverGeographicBatch(
  admin: SupabaseClient,
  tenantId: string,
  driverUserId: string,
  batchServices: TripGeoServiceRow[]
): Promise<DriverGeographicBatchResult> {
  const batchIds = new Set(batchServices.map((service) => service.id));
  const batchDates = new Set(batchServices.map((service) => service.date));

  const { data: otherAssignments, error } = await admin
    .from("assignments")
    .select("group_id, assigned_at, services!inner(id, date, time, pickup_hotel, direction, hotel_id, meeting_point)")
    .eq("tenant_id", tenantId)
    .eq("driver_user_id", driverUserId);

  if (error) {
    return { ok: false, kind: "query_error", error: `Errore validazione geografica autista: ${error.message}` };
  }

  const otherAssignmentsForGeo = (otherAssignments ?? [])
    .filter((assignment) => {
      const otherService = (assignment.services as unknown) as TripGeoServiceRow;
      return !batchIds.has(otherService.id) && batchDates.has(otherService.date);
    });
  const otherServices = otherAssignmentsForGeo.map((assignment) => (assignment.services as unknown) as TripGeoServiceRow);

  const hotelIds = [...otherServices, ...batchServices]
    .map((row) => row.hotel_id)
    .filter((id): id is string => Boolean(id));
  const { data: hotelsData } = hotelIds.length > 0
    ? await admin.from("hotels").select("id, zone").eq("tenant_id", tenantId).in("id", [...new Set(hotelIds)])
    : { data: [] as TripGeoHotelRow[] };
  const hotelMap = new Map((hotelsData ?? []).map((hotel) => [hotel.id as string, hotel as TripGeoHotelRow]));

  const otherServicesByGroup = new Map<string, TripGeoServiceRow[]>();
  for (const assignment of otherAssignmentsForGeo) {
    const service = (assignment.services as unknown) as TripGeoServiceRow;
    const assignedAt = assignment.assigned_at as string | null | undefined;
    const groupKey = (assignment.group_id as string | null) ?? (assignedAt ? `null_group_batch:${assignedAt}` : `service:${service.id}`);
    otherServicesByGroup.set(groupKey, [...(otherServicesByGroup.get(groupKey) ?? []), service]);
  }

  const windows = [
    ...Array.from(otherServicesByGroup.values()).map((groupServices) => tripServicesToGeographicWindow(groupServices, hotelMap)),
    tripServicesToGeographicWindow(batchServices, hotelMap),
  ].sort((a, b) => tripOperationalMinutes(a.startTime) - tripOperationalMinutes(b.startTime));

  const issues: GeographicCompatibilityResult[] = [];
  for (let i = 1; i < windows.length; i++) {
    issues.push(validateGeographicCompatibility(windows[i - 1]!, windows[i]!));
  }
  const strongest = strongestGeographicResult(issues.filter((issue) => issue.severity !== "ok"));
  if (strongest?.severity === "block") {
    const { data: driver } = await admin
      .from("memberships")
      .select("full_name")
      .eq("tenant_id", tenantId)
      .eq("user_id", driverUserId)
      .maybeSingle();
    return {
      ok: false,
      kind: "block",
      error: geographicBlockMessage((driver?.full_name as string | null) ?? "selezionato", strongest),
    };
  }
  return { ok: true };
}
