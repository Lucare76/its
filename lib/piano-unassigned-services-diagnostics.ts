import { resolveAssignableService, type AssignableMacroCategory } from "@/lib/piano-assignable-service";
import type { AutoAssignPreviewHotel, AutoAssignPreviewService } from "@/lib/piano-assignable-preview";
import { mergeSameStops, type MergedStop, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";
import { detectShuttlePairs, type ShuttlePairGroup } from "@/lib/piano-shuttle-pair";

export type UnassignedDiagnosticsSuggestion = {
  suggestion_id: string;
  action: "MULTI_DROP" | "ACCORPARE_CON_CONFERMA";
  pickup_label: string;
  operational_time: string;
  suggested_order: string[];
  involved_services: Array<{
    service_id: string;
    customer_name: string | null;
    macro_category: AssignableMacroCategory;
    pickup_label: string | null;
    destination_label: string | null;
    pax: number | null;
  }>;
  total_pax: number;
  explanation: string[];
};

export type UnassignedDiagnosticsResult = {
  ok: true;
  date: string;
  mode: "unassigned_services";
  summary: {
    total_services: number;
    assignable_count: number;
    needs_review_count: number;
    continent_dispatch_count: number;
    navette_count: number;
    arrivi_count: number;
    partenze_count: number;
    escursioni_count: number;
    stop_count: number;
    same_stop_count: number;
    shuttle_pair_count: number;
    multi_drop_candidate_count: number;
    accorpamento_candidate_count: number;
  };
  needs_review: ResolvedServiceForSameStop[];
  continent_dispatch: ResolvedServiceForSameStop[];
  stops: MergedStop[];
  same_stop_groups: MergedStop[];
  shuttle_pairs: ShuttlePairGroup[];
  suggestions: UnassignedDiagnosticsSuggestion[];
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function rowToSameStopService(row: ResolvedServiceForSameStop) {
  return row;
}

function resolutionToSameStopService(
  service: AutoAssignPreviewService,
  resolution: ReturnType<typeof resolveAssignableService>
): ResolvedServiceForSameStop {
  return {
    service_id: service.id,
    customer_name: service.customer_name ?? null,
    macro_category: resolution.macro_category,
    assignable: resolution.assignable,
    needs_review: resolution.needs_review,
    review_reasons: resolution.review_reasons,
    operational_time: resolution.operational_time,
    pickup_label: resolution.pickup_label,
    pickup_zone: resolution.pickup_zone,
    destination_label: resolution.destination_label,
    destination_zone: resolution.destination_zone,
    pax: resolution.pax,
    ferry_company: resolution.ferry_company,
    ferry_departure_time: resolution.ferry_departure_time,
    ferry_arrival_time: resolution.ferry_arrival_time,
    port_departure: resolution.port_departure,
    port_arrival: resolution.port_arrival,
    booking_service_kind: resolution.booking_service_kind,
    service_type_code: resolution.service_type_code,
  };
}

function isContinentDispatch(service: AutoAssignPreviewService, row: ResolvedServiceForSameStop) {
  const text = [
    service.porto_bruno,
    service.place_type,
    service.origin_place_type,
    service.destination_place_type,
    service.booking_service_kind,
    service.service_type_code,
    service.meeting_point,
    service.vessel,
    row.pickup_label,
    row.destination_label,
  ].map(normalize).join(" ");

  return /\b(bruno|continente|napoli|pozzuoli|aeroporto|capodichino|stazione|metropark|beverello)\b/.test(text)
    && row.macro_category === "DA_VERIFICARE";
}

function destinationLabels(stops: MergedStop[]) {
  const labels = new Map<string, string>();
  for (const stop of stops) {
    for (const label of stop.destination_labels) {
      const cleaned = clean(label);
      if (!cleaned) continue;
      labels.set(normalize(cleaned), cleaned);
    }
  }
  return [...labels.values()];
}

function serviceRows(stops: MergedStop[]): UnassignedDiagnosticsSuggestion["involved_services"] {
  return stops.flatMap((stop) => stop.services.map((service) => ({
    service_id: service.service_id,
    customer_name: service.customer_name ?? null,
    macro_category: service.macro_category,
    pickup_label: service.pickup_label,
    destination_label: service.destination_label,
    pax: service.pax,
  })));
}

function destinationRank(label?: string | null) {
  const text = normalize(label);
  if (/(casamicciola|cristallo|lacco|forio|citara|panza|cuotto)/.test(text)) return 10;
  if (/(sant angelo|serrara|fontana)/.test(text)) return 20;
  if (/(ischia porto|ischia|re ferdinando|barano|testaccio|fiaiano|cartaromana)/.test(text)) return 30;
  return 99;
}

function buildSuggestions(stops: MergedStop[]): UnassignedDiagnosticsSuggestion[] {
  const buckets = new Map<string, MergedStop[]>();
  for (const stop of stops) {
    if (!stop.pickup_label || !stop.operational_time) continue;
    const key = `${normalize(stop.pickup_label)}|${stop.operational_time}`;
    const list = buckets.get(key) ?? [];
    list.push(stop);
    buckets.set(key, list);
  }

  const suggestions: UnassignedDiagnosticsSuggestion[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length < 2) continue;
    const pickup = clean(bucket[0]?.pickup_label) ?? "pickup";
    const time = bucket[0]?.operational_time ?? "00:00";
    const destinations = destinationLabels(bucket)
      .sort((left, right) => destinationRank(left) - destinationRank(right) || left.localeCompare(right));
    const services = serviceRows(bucket);
    const totalPax = services.reduce((sum, service) => sum + (service.pax ?? 0), 0);
    const action = destinations.length > 1 ? "MULTI_DROP" : "ACCORPARE_CON_CONFERMA";
    suggestions.push({
      suggestion_id: `${action.toLowerCase()}-${key}`,
      action,
      pickup_label: pickup,
      operational_time: time,
      suggested_order: action === "MULTI_DROP" ? destinations : [],
      involved_services: services,
      total_pax: totalPax,
      explanation: action === "MULTI_DROP"
        ? [`Pickup unico da ${pickup}. Possibile multi-drop: ${destinations.join(" -> ")}.`]
        : [`Stesso pickup e stessa destinazione da ${pickup}: possibile accorpamento con conferma operatore.`],
    });
  }

  return suggestions.sort((a, b) =>
    a.operational_time.localeCompare(b.operational_time) || a.pickup_label.localeCompare(b.pickup_label)
  );
}

export function buildUnassignedServicesDiagnostics(args: {
  date: string;
  services: AutoAssignPreviewService[];
  hotels: AutoAssignPreviewHotel[];
}): UnassignedDiagnosticsResult {
  const hotelMap = new Map(args.hotels.map((hotel) => [hotel.id, hotel]));
  const resolved = args.services.map((service) => {
    const resolution = resolveAssignableService(service, {
      hotel: service.hotel_id ? hotelMap.get(service.hotel_id) ?? null : null,
    });
    return { service, row: resolutionToSameStopService(service, resolution) };
  });

  const needsReview = resolved.filter(({ row }) => row.needs_review).map(({ row }) => row);
  const continentDispatch = resolved.filter(({ service, row }) => isContinentDispatch(service, row)).map(({ row }) => row);
  const assignable = resolved
    .filter(({ row }) => row.assignable && !row.needs_review)
    .map(({ row }) => rowToSameStopService(row));
  const stops = mergeSameStops(assignable);
  const shuttlePairResult = detectShuttlePairs(stops, {
    enabledHotelNames: ["hotel terme president"],
    maxDeltaMinutes: 10,
  });
  const suggestions = buildSuggestions(shuttlePairResult.remaining_stops as MergedStop[]);

  return {
    ok: true,
    date: args.date,
    mode: "unassigned_services",
    summary: {
      total_services: args.services.length,
      assignable_count: assignable.length,
      needs_review_count: needsReview.length,
      continent_dispatch_count: continentDispatch.length,
      navette_count: resolved.filter(({ row }) => row.macro_category === "NAVETTA").length,
      arrivi_count: resolved.filter(({ row }) => row.macro_category === "ARRIVO").length,
      partenze_count: resolved.filter(({ row }) => row.macro_category === "PARTENZA").length,
      escursioni_count: resolved.filter(({ row }) => row.macro_category === "ESCURSIONE").length,
      stop_count: stops.length,
      same_stop_count: stops.filter((stop) => stop.is_merged).length,
      shuttle_pair_count: shuttlePairResult.shuttle_pairs.length,
      multi_drop_candidate_count: suggestions.filter((suggestion) => suggestion.action === "MULTI_DROP").length,
      accorpamento_candidate_count: suggestions.filter((suggestion) => suggestion.action === "ACCORPARE_CON_CONFERMA").length,
    },
    needs_review: needsReview,
    continent_dispatch: continentDispatch,
    stops,
    same_stop_groups: stops.filter((stop) => stop.is_merged),
    shuttle_pairs: shuttlePairResult.shuttle_pairs,
    suggestions,
  };
}
