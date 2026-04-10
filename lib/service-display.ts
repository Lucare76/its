import type { Service, TransportMode } from "@/lib/types";

function clean(value?: string | null) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function formatIsoDateShort(value?: string | null) {
  const normalized = clean(value);
  if (!normalized) return "N/D";
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return normalized;
  return `${match[3]}/${match[2]}/${match[1].slice(-2)}`;
}

export function formatIsoDateTimeShort(value?: string | null) {
  if (!value) return "N/D";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}`;
}

export function getCustomerFullName(service: Pick<Service, "customer_name"> & Partial<Service>) {
  return clean(service.customer_name) ?? "Cliente da verificare";
}

export function getOutboundTime(service: Partial<Service>) {
  return clean(service.outbound_time) ?? clean(service.arrival_time) ?? clean(service.time) ?? null;
}

export function getReturnTime(service: Partial<Service>) {
  return clean(service.return_time) ?? clean(service.departure_time) ?? null;
}

export function getOutboundDate(service: Partial<Service>) {
  return clean(service.arrival_date) ?? clean(service.date) ?? null;
}

export function getReturnDate(service: Partial<Service>) {
  return clean(service.departure_date) ?? null;
}

export function getTransportMode(service: Partial<Service> & {
  transport_mode?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  include_ferry_tickets?: boolean | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
}) {
  const explicit = clean(service.transport_mode) as TransportMode | null;
  if (explicit) return explicit;
  if (clean(service.train_arrival_number) || clean(service.train_departure_number)) return "train";
  if (service.service_type_code === "bus_line") return "bus";
  if (service.service_type_code === "transfer_station_hotel") return "train";
  if (service.service_type_code === "ferry_transfer") return "ferry";
  if (service.include_ferry_tickets) return "ferry";
  if (service.booking_service_kind === "bus_city_hotel") return "bus";
  return "road_transfer";
}

export function getTransportReferenceOutward(service: Partial<Service> & {
  transport_reference_outward?: string | null;
  train_arrival_number?: string | null;
}) {
  return clean(service.transport_reference_outward) ?? clean(service.train_arrival_number) ?? null;
}

export function getTransportReferenceReturn(service: Partial<Service> & {
  transport_reference_return?: string | null;
  train_departure_number?: string | null;
}) {
  return clean(service.transport_reference_return) ?? clean(service.train_departure_number) ?? null;
}

function transportLabel(mode: TransportMode) {
  if (mode === "train") return "treno";
  if (mode === "hydrofoil") return "aliscafo";
  if (mode === "ferry") return "traghetto";
  if (mode === "bus") return "bus";
  return "servizio";
}

export function getOutwardTimeLabel(service: Partial<Service> & {
  transport_mode?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  include_ferry_tickets?: boolean | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
}) {
  const mode = getTransportMode(service);
  if (mode === "road_transfer") return "Orario andata";
  return `Orario ${transportLabel(mode)} andata`;
}

export function getReturnTimeLabel(service: Partial<Service> & {
  transport_mode?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  include_ferry_tickets?: boolean | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
}) {
  const mode = getTransportMode(service);
  if (mode === "road_transfer") return "Orario ritorno";
  return `Orario ${transportLabel(mode)} ritorno`;
}

export function getOutwardReferenceLabel(service: Partial<Service> & {
  transport_mode?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  include_ferry_tickets?: boolean | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
}) {
  const mode = getTransportMode(service);
  if (mode === "road_transfer") return "Riferimento mezzo andata";
  return `${transportLabel(mode).slice(0, 1).toUpperCase()}${transportLabel(mode).slice(1)} andata`;
}

export function getReturnReferenceLabel(service: Partial<Service> & {
  transport_mode?: string | null;
  service_type_code?: string | null;
  booking_service_kind?: string | null;
  include_ferry_tickets?: boolean | null;
  train_arrival_number?: string | null;
  train_departure_number?: string | null;
}) {
  const mode = getTransportMode(service);
  if (mode === "road_transfer") return "Riferimento mezzo ritorno";
  return `${transportLabel(mode).slice(0, 1).toUpperCase()}${transportLabel(mode).slice(1)} ritorno`;
}

export function formatServiceSlot(service: Partial<Service>) {
  const date = formatIsoDateShort(getOutboundDate(service));
  const outboundTime = getOutboundTime(service) ?? "N/D";
  const returnTime = getReturnTime(service);
  return returnTime ? `${date} ${outboundTime} / ${returnTime}` : `${date} ${outboundTime}`;
}
