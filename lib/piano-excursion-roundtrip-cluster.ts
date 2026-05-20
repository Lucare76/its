import { resolveAssignableService, type AssignableService } from "@/lib/piano-assignable-service";
import type { AutoAssignPreviewHotel } from "@/lib/piano-assignable-preview";

export type ExcursionRoundtripClusterService = {
  service_id: string;
  customer_name: string | null;
  operational_time: string | null;
  pickup_label: string | null;
  destination_label: string | null;
  pax: number | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
};

export type ExcursionRoundtripCluster = {
  type: "excursion_roundtrip_cluster";
  cluster_id: string;
  label: string;
  outbound_services: ExcursionRoundtripClusterService[];
  return_services: ExcursionRoundtripClusterService[];
  service_ids: string[];
  total_pax: number;
  outbound_route: string[];
  return_route: string[];
  start_time: string | null;
  end_time: string | null;
};

function clean(value?: string | number | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function normalize(value?: string | number | null) {
  return clean(value)
    ?.toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim() ?? "";
}

function serviceKey(row: ExcursionRoundtripClusterService) {
  return [
    row.service_id,
    row.operational_time ?? "",
    row.pickup_label ?? "",
    row.destination_label ?? "",
    row.pax ?? 0,
  ].join("|");
}

function publicService(row: ExcursionRoundtripClusterService): ExcursionRoundtripClusterService {
  return {
    service_id: row.service_id,
    customer_name: row.customer_name,
    operational_time: row.operational_time,
    pickup_label: row.pickup_label,
    destination_label: row.destination_label,
    pax: row.pax,
    booking_service_kind: row.booking_service_kind,
    service_type_code: row.service_type_code,
  };
}

function labelOrder(label: string | null, order: string[]) {
  const normalized = normalize(label);
  const index = order.findIndex((item) => normalize(item) === normalized);
  return index === -1 ? order.length : index;
}

function labelMatchesAny(label: string | null, allowed: string[]) {
  const normalized = normalize(label);
  return allowed.some((item) => normalized.includes(normalize(item)));
}

export function detectExcursionRoundtripClusters(args: {
  services: AssignableService[];
  hotels?: AutoAssignPreviewHotel[];
}): ExcursionRoundtripCluster[] {
  const hotelById = new Map((args.hotels ?? []).map((hotel) => [hotel.id, hotel]));
  const rows = args.services.map((service) => {
    const resolution = resolveAssignableService(service, {
      hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null,
    });
    return {
      service_id: service.id,
      customer_name: service.customer_name ?? null,
      operational_time: resolution.operational_time,
      pickup_label: resolution.pickup_label,
      destination_label: resolution.destination_label,
      pax: resolution.pax,
      booking_service_kind: resolution.booking_service_kind,
      service_type_code: resolution.service_type_code,
      macro_category: resolution.macro_category,
    };
  }).filter((row) => row.macro_category === "ESCURSIONE");

  const mortellaRows = rows.filter((row) =>
    normalize(row.pickup_label).includes("mortella") || normalize(row.destination_label).includes("mortella")
  );
  const outbound = mortellaRows
    .filter((row) =>
      normalize(row.destination_label).includes("mortella") &&
      labelMatchesAny(row.pickup_label, ["RE FERDINANDO", "CRISTALLO"])
    )
    .sort((a, b) =>
      String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")) ||
      labelOrder(a.pickup_label, ["RE FERDINANDO", "CRISTALLO"]) - labelOrder(b.pickup_label, ["RE FERDINANDO", "CRISTALLO"])
    );
  const inbound = mortellaRows
    .filter((row) =>
      normalize(row.pickup_label).includes("mortella") &&
      labelMatchesAny(row.destination_label, ["CRISTALLO", "RE FERDINANDO"])
    )
    .sort((a, b) =>
      String(a.operational_time ?? "").localeCompare(String(b.operational_time ?? "")) ||
      labelOrder(a.destination_label, ["CRISTALLO", "RE FERDINANDO"]) - labelOrder(b.destination_label, ["CRISTALLO", "RE FERDINANDO"])
    );

  const hasReFerdinandoOutbound = outbound.some((row) => normalize(row.pickup_label).includes("re ferdinando"));
  const hasCristalloOutbound = outbound.some((row) => normalize(row.pickup_label).includes("cristallo"));
  const hasReFerdinandoInbound = inbound.some((row) => normalize(row.destination_label).includes("re ferdinando"));
  const hasCristalloInbound = inbound.some((row) => normalize(row.destination_label).includes("cristallo"));
  if (!hasReFerdinandoOutbound || !hasCristalloOutbound || !hasReFerdinandoInbound || !hasCristalloInbound) {
    return [];
  }

  const outboundPax = outbound.reduce((sum, row) => sum + (Number(row.pax) || 0), 0);
  const inboundPax = inbound.reduce((sum, row) => sum + (Number(row.pax) || 0), 0);
  const outboundRoute = [
    ...outbound.map((row) => row.pickup_label).filter((value): value is string => Boolean(value)),
    "MORTELLA",
  ];
  const returnRoute = [
    "MORTELLA",
    ...inbound.map((row) => row.destination_label).filter((value): value is string => Boolean(value)),
  ];
  const services = [...outbound, ...inbound].map(publicService);

  const cluster: ExcursionRoundtripCluster = {
    type: "excursion_roundtrip_cluster",
    cluster_id: "excursion-mortella-roundtrip",
    label: "ESCURSIONE MORTELLA",
    outbound_services: outbound.map(publicService),
    return_services: inbound.map(publicService),
    service_ids: Array.from(new Set(services.map((row) => row.service_id))).sort(),
    total_pax: Math.max(outboundPax, inboundPax),
    outbound_route: Array.from(new Set(outboundRoute)),
    return_route: Array.from(new Set(returnRoute)),
    start_time: outbound[0]?.operational_time ?? null,
    end_time: inbound[inbound.length - 1]?.operational_time ?? null,
  };

  return new Set(services.map(serviceKey)).size >= 4 ? [cluster] : [];
}

export function serviceBelongsToExcursionRoundtripCluster(serviceId: string, clusters: ExcursionRoundtripCluster[]) {
  return clusters.some((cluster) => cluster.service_ids.includes(serviceId));
}
