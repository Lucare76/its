import { getPickupRule, getPickupRuleByRange, normalizeZonaIschia } from "@/lib/departure-pickup-rules";
import { ferryPortLabel, findArrivalScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";
import { parseOperationalV2Rows, type OperationalV2PreviewRow, type RawOperationalExcelRow } from "@/lib/operational-excel-normalize";
import { resolveFerrySbarco } from "@/lib/server/resolve-ferry-sbarco";
import { resolveHotelMatch, type HotelMatchRow } from "@/lib/server/hotel-matching";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

type AgencyRow = { id: string; name: string };
type OperationalHotelRow = HotelMatchRow & { zone?: string | null };

export type OperationalV2ServerPreviewRow = {
  row_number: number;
  status: "ready" | "needs_review" | "blocking_error";
  hotel_match: { id: string; name: string } | null;
  agency_match: { id: string; name: string } | null;
  duplicate_service_ids: string[];
  computed: Record<string, string | null>;
  warnings: string[];
  errors: string[];
};

export type OperationalV2ServerPreviewResult = {
  ok: true;
  template_kind: "operational_v2";
  parser_preview: ReturnType<typeof parseOperationalV2Rows>;
  summary: {
    total_rows: number;
    service_rows: number;
    ready_count: number;
    needs_review_count: number;
    blocking_error_count: number;
    duplicate_count: number;
  };
  rows: OperationalV2ServerPreviewRow[];
};

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function resolveAgency(agencies: AgencyRow[], rawName: string | null) {
  const wanted = normalizeText(rawName);
  if (!wanted) return null;
  return agencies.find((agency) => {
    const normalized = normalizeText(agency.name);
    return normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized);
  }) ?? null;
}

function isIslandPort(value: string | null) {
  const normalized = normalizeText(value);
  return normalized === "casamicciola"
    || normalized === "ischia porto"
    || normalized === "porto ischia"
    || normalized === "ischia";
}

function hotelCandidateForRow(row: OperationalV2PreviewRow) {
  const direction = row.classification.direction;
  const category = row.classification.category;
  if (category === "FORMULA_NAVE") {
    if (isIslandPort(row.normalized.from)) return row.normalized.to;
    if (isIslandPort(row.normalized.to)) return row.normalized.from;
    return row.normalized.trip_type === "ANDATA" ? row.normalized.from : row.normalized.to;
  }
  if (category === "TRANSFER") {
    return direction === "departure" ? row.normalized.from : row.normalized.to;
  }
  return null;
}

function duplicateKey(row: OperationalV2PreviewRow) {
  const n = row.normalized;
  const operativeTime = n.ferry_time ?? n.departure_time ?? n.arrival_time ?? "";
  return [n.date, n.customer_name, n.service, n.trip_type, n.from, n.to, operativeTime, n.agency, n.pax]
    .map(normalizeText)
    .join("|");
}

function placeTypeForBookingKind(kind: string | null) {
  if (!kind) return null;
  if (kind.includes("airport")) return "airport";
  if (kind.includes("train")) return "station";
  return null;
}

function transferDepartureTransportType(kind: string | null) {
  if (!kind) return null;
  const boatType = kind.endsWith("_aliscafo") ? "aliscafo" : "traghetto";
  if (kind.includes("airport")) return boatType === "aliscafo" ? "volo_aliscafo" : "volo_traghetto";
  if (kind.includes("train")) return boatType === "aliscafo" ? "treno_aliscafo" : "treno_traghetto";
  return null;
}

function formulaTransportType(kind: string | null) {
  if (!kind) return null;
  if (kind === "formula_snav") return "snav";
  if (kind.startsWith("formula_medmar")) return "medmar";
  return null;
}

function warningRequiresManualReview(warning: string) {
  return warning.includes("Regola")
    || warning.includes("Tipo transfer")
    || warning.includes("Formula nave non riconosciuta")
    || warning.includes("Tratta Formula Nave")
    || warning.includes("Agenzia non trovata")
    || warning.includes("richiede verifica")
    || warning.includes("non riconosciut")
    || warning.includes("Possibile duplicato");
}

export function operationalV2DbRowStatus(row: OperationalV2ServerPreviewRow, previewRow?: OperationalV2PreviewRow) {
  const warnings = [...(previewRow?.warnings ?? []), ...row.warnings];
  const errors = [...(previewRow?.errors ?? []), ...row.errors];
  if (errors.length > 0 || row.status === "blocking_error") return "blocking_error" as const;
  if (warnings.some(warningRequiresManualReview)) return "needs_review" as const;
  if (warnings.length > 0) return "light_warning" as const;
  return "ready" as const;
}

export async function buildOperationalV2ServerPreview(
  auth: PricingAuthContext,
  rawRows: RawOperationalExcelRow[]
): Promise<OperationalV2ServerPreviewResult> {
  const preview = parseOperationalV2Rows(rawRows);
  const tenantId = auth.membership.tenant_id;

  const [hotelsRes, aliasesRes, agenciesRes, ferrySchedulesRes] = await Promise.all([
    auth.admin.from("hotels").select("id, name, normalized_name, zone").eq("tenant_id", tenantId).order("name"),
    auth.admin.from("hotel_aliases").select("hotel_id, alias").eq("tenant_id", tenantId).limit(5000),
    auth.admin.from("agencies").select("id, name").eq("tenant_id", tenantId).order("name"),
    auth.admin.from("ferry_schedules").select("*").in("company", ["snav", "medmar", "alilauro", "caremar"]).order("departure_time"),
  ]);

  if (hotelsRes.error) throw new Error(hotelsRes.error.message);
  if (aliasesRes.error) throw new Error(aliasesRes.error.message);
  if (agenciesRes.error) throw new Error(agenciesRes.error.message);
  if (ferrySchedulesRes.error) throw new Error(ferrySchedulesRes.error.message);

  const aliasesByHotel = new Map<string, string[]>();
  for (const row of (aliasesRes.data ?? []) as Array<{ hotel_id: string; alias: string }>) {
    const bucket = aliasesByHotel.get(row.hotel_id) ?? [];
    bucket.push(row.alias);
    aliasesByHotel.set(row.hotel_id, bucket);
  }

  const hotels = ((hotelsRes.data ?? []) as OperationalHotelRow[]).map((hotel) => ({
    ...hotel,
    aliases: aliasesByHotel.get(hotel.id) ?? [],
  }));
  const agencies = (agenciesRes.data ?? []) as AgencyRow[];
  const ferrySchedules = (ferrySchedulesRes.data ?? []) as FerryScheduleRow[];
  const serviceRows = preview.rows.filter((row) => row.status !== "blocking_error");
  const dates = [...new Set(serviceRows.map((row) => row.normalized.date).filter((date): date is string => Boolean(date)))];

  const existingByDate = new Map<string, Array<Record<string, unknown>>>();
  await Promise.all(dates.map(async (date) => {
    const { data } = await auth.admin
      .from("services")
      .select("id,date,customer_name,pax,booking_service_kind,billing_party_name,time,arrival_time,departure_time,orario_barca,status")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled")
      .limit(2000);
    existingByDate.set(date, data ?? []);
  }));

  const rows: OperationalV2ServerPreviewRow[] = await Promise.all(preview.rows.map(async (row) => {
    const warnings: string[] = [];
    const errors: string[] = [...row.errors];
    const hotelCandidate = hotelCandidateForRow(row);
    const hotelId = hotelCandidate ? resolveHotelMatch(hotels, hotelCandidate, null) : null;
    const hotel = hotelId ? hotels.find((item) => item.id === hotelId) ?? null : null;
    const agency = resolveAgency(agencies, row.normalized.agency);
    const bookingKind = row.classification.booking_service_kind;
    const placeType = placeTypeForBookingKind(bookingKind);
    const computed: Record<string, string | null> = {
      arrival_at_ischia: null,
      pickup_hotel: null,
      barca_compagnia: null,
      orario_barca: null,
      porto_bruno: null,
      nave_db: null,
    };

    if (hotelCandidate && !hotelId) warnings.push(`Hotel/alias da risolvere: ${hotelCandidate}`);
    if (row.normalized.agency && !agency) warnings.push(`Agenzia non trovata: ${row.normalized.agency}`);

    if (row.classification.category === "TRANSFER" && row.classification.direction === "arrival" && bookingKind && row.normalized.arrival_time && row.normalized.date) {
      const ferry = await resolveFerrySbarco({
        admin: auth.admin,
        bookingKind,
        transportArrivalTime: row.normalized.arrival_time,
        bookingDate: row.normalized.date,
        agencyId: agency?.id ?? null,
      });
      computed.arrival_at_ischia = ferry?.arrival_time ?? null;
      computed.barca_compagnia = ferry?.company ?? null;
      computed.orario_barca = ferry?.departure_time ?? null;
      computed.porto_bruno = ferry?.arrival_port ?? null;
      computed.nave_db = [ferry?.company, ferry?.departure_time, ferry?.arrival_port].filter(Boolean).join(" - ") || null;
      if (!computed.arrival_at_ischia) warnings.push("Regola DB sbarco/arrivo Ischia non trovata");
    }

    if (row.classification.direction === "departure" && placeType && row.normalized.departure_time) {
      const transportType = transferDepartureTransportType(bookingKind);
      const zona = normalizeZonaIschia(hotel?.zone ?? hotelCandidate);
      const pickupRule = transportType
        ? getPickupRule(row.normalized.agency ?? "", transportType, row.normalized.departure_time, zona)
          ?? getPickupRuleByRange(row.normalized.agency ?? "", transportType, row.normalized.departure_time, zona)
        : null;
      computed.pickup_hotel = pickupRule?.pickup ?? null;
      computed.barca_compagnia = pickupRule?.boat_co ?? null;
      computed.orario_barca = pickupRule?.boat_t ?? null;
      computed.porto_bruno = pickupRule?.porto_p ?? null;
      computed.nave_db = [pickupRule?.boat_co, pickupRule?.boat_t, pickupRule?.porto_p, pickupRule?.porto_a].filter(Boolean).join(" - ") || null;
      if (!transportType) warnings.push("Tipo transfer partenza non riconosciuto per regole pickup");
      if (!computed.pickup_hotel) warnings.push("Regola pickup partenza non trovata");
    }

    if (row.classification.category === "FORMULA_NAVE" && row.normalized.ferry_time && row.normalized.date) {
      const transportType = formulaTransportType(bookingKind);
      const isHotelToPort = !isIslandPort(row.normalized.from) && isIslandPort(row.normalized.to);
      const isPortToHotel = isIslandPort(row.normalized.from) && !isIslandPort(row.normalized.to);

      if (isHotelToPort) {
        const zona = normalizeZonaIschia(hotel?.zone ?? hotelCandidate);
        const pickupRule = transportType
          ? getPickupRule(row.normalized.agency ?? "", transportType, row.normalized.ferry_time, zona)
          : null;
        computed.pickup_hotel = pickupRule?.pickup ?? null;
        computed.barca_compagnia = pickupRule?.boat_co ?? row.normalized.ferry_company ?? row.normalized.service ?? null;
        computed.orario_barca = pickupRule?.boat_t ?? row.normalized.ferry_time;
        computed.porto_bruno = pickupRule?.porto_p ?? row.normalized.to ?? null;
        computed.nave_db = [computed.barca_compagnia, computed.orario_barca, computed.porto_bruno, pickupRule?.porto_a].filter(Boolean).join(" - ") || null;
        if (!transportType) warnings.push("Formula nave non riconosciuta per regole pickup");
        if (!computed.pickup_hotel) warnings.push("Regola pickup Formula Nave non trovata");
      }

      if (isPortToHotel) {
        const arrival = findArrivalScheduleForService(ferrySchedules, row.normalized.date, row.normalized.ferry_time, bookingKind);
        computed.arrival_at_ischia = arrival?.arrivalTime ?? null;
        computed.barca_compagnia = arrival?.company?.toUpperCase() ?? row.normalized.ferry_company ?? row.normalized.service ?? null;
        computed.orario_barca = arrival?.departureTime ?? row.normalized.ferry_time;
        computed.porto_bruno = arrival ? ferryPortLabel(arrival.arrivalPort) : row.normalized.from ?? null;
        computed.nave_db = [computed.barca_compagnia, computed.orario_barca, computed.porto_bruno].filter(Boolean).join(" - ") || null;
        if (!computed.arrival_at_ischia) warnings.push("Regola arrivo Formula Nave non trovata");
      }

      if (!isHotelToPort && !isPortToHotel) {
        warnings.push("Tratta Formula Nave da verificare: porto/hotel non riconosciuti");
      }
    }

    if (row.classification.category === "ESCURSIONE" && row.normalized.departure_time) {
      computed.pickup_hotel = row.normalized.departure_time;
    }

    const existing = row.normalized.date ? existingByDate.get(row.normalized.date) ?? [] : [];
    const key = duplicateKey(row);
    const duplicateMatches = existing.filter((service) => {
      const serviceTime = String(service.orario_barca ?? service.departure_time ?? service.arrival_time ?? service.time ?? "");
      const existingKey = [
        service.date,
        service.customer_name,
        service.booking_service_kind,
        row.normalized.trip_type,
        row.normalized.from,
        row.normalized.to,
        serviceTime.slice(0, 5),
        service.billing_party_name,
        service.pax,
      ].map((value) => normalizeText(String(value ?? ""))).join("|");
      return existingKey === key
        || (
          normalizeText(String(service.customer_name ?? "")) === normalizeText(row.normalized.customer_name)
          && Number(service.pax) === row.normalized.pax
          && serviceTime.slice(0, 5) === (row.normalized.ferry_time ?? row.normalized.departure_time ?? row.normalized.arrival_time ?? "")
        );
    });
    if (duplicateMatches.length > 0) warnings.push("Possibile duplicato gia presente nel DB");
    const requiresManualReview = warnings.some(warningRequiresManualReview);

    const status: OperationalV2ServerPreviewRow["status"] = errors.length > 0
      ? "blocking_error"
      : requiresManualReview
        ? "needs_review"
        : "ready";

    return {
      row_number: row.row_number,
      status,
      hotel_match: hotel ? { id: hotel.id, name: hotel.name } : null,
      agency_match: agency ? { id: agency.id, name: agency.name } : null,
      duplicate_service_ids: duplicateMatches.map((service) => String(service.id)),
      computed,
      warnings,
      errors,
    };
  }));

  return {
    ok: true,
    template_kind: "operational_v2",
    parser_preview: preview,
    summary: {
      total_rows: preview.summary.total_rows,
      service_rows: preview.summary.service_rows,
      ready_count: rows.filter((row, index) => operationalV2DbRowStatus(row, preview.rows[index]) === "ready").length,
      needs_review_count: rows.filter((row, index) => operationalV2DbRowStatus(row, preview.rows[index]) === "needs_review").length,
      blocking_error_count: rows.filter((row, index) => operationalV2DbRowStatus(row, preview.rows[index]) === "blocking_error").length,
      duplicate_count: rows.filter((row) => row.duplicate_service_ids.length > 0).length,
    },
    rows,
  };
}
