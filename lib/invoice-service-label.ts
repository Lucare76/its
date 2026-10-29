import { buildServiceLabelShort, type AgencyBookingKind } from "@/lib/service-label";

/** Only structured booking fields: a carrier mentioned in free notes is not a formula. */
export type InvoiceServiceContext = {
  booking_service_kind?: string | null;
  service_type?: string | null;
  vessel?: string | null;
  meeting_point?: string | null;
  transport_code?: string | null;
  include_ferry_tickets?: boolean | null;
  ferry_details?: unknown;
  bus_city_origin?: string | null;
  bus_stop_name?: string | null;
};

const PORT_KINDS = new Set(["transfer_port_hotel", "transfer_hotel_port"]);

function kindLabel(kind: string): string {
  switch (kind) {
    case "transfer_port_hotel": return "Transfer Porto / Hotel";
    case "transfer_hotel_port": return "Transfer Hotel / Porto";
    case "transfer_train_hotel":
    case "transfer_station_hotel": return "Transfer Stazione";
    case "transfer_airport_hotel": return "Transfer Aeroporto";
    case "transfer": return "Transfer";
    case "bus_city_hotel":
    case "bus_tour": return "Transfer Bus";
    default:
      return buildServiceLabelShort({ kind: kind as AgencyBookingKind }) || kind || "Servizio non specificato";
  }
}

export function buildInvoiceServiceDescription(service: InvoiceServiceContext): string {
  const kind = service.booking_service_kind || service.service_type || "transfer";
  const label = kindLabel(kind);
  if (kind === "bus_city_hotel" || kind === "bus_tour") {
    const city = service.bus_stop_name?.trim();
    return city ? `${label} ${city}` : label;
  }
  // An explicit booking formula is authoritative, including its mainland port.
  if (kind.startsWith("formula_")) return label;

  const details = service.ferry_details && typeof service.ferry_details === "object" && !Array.isArray(service.ferry_details)
    ? service.ferry_details as Record<string, unknown> : {};
  const references = [service.vessel, service.transport_code, details.carrier_company,
    details.transport_reference_outward, details.transport_reference_return,
    details.arrival_transport_code, details.departure_transport_code];
  const carriers = new Set<string>();
  for (const reference of references) {
    if (typeof reference !== "string") continue;
    for (const carrier of ["SNAV", "MEDMAR", "CAREMAR", "ALILAURO"]) {
      if (new RegExp(`\\b${carrier}\\b`, "i").test(reference)) carriers.add(carrier);
    }
  }
  const carrierLabel = [...carriers].sort().join(" / ");
  // Imported port transfers may use the generic kind. Tickets + one known
  // carrier identify the package; never infer it from an amount or notes.
  if (PORT_KINDS.has(kind) && carriers.size === 1
    && (carriers.has("SNAV") || carriers.has("MEDMAR"))) {
    return `Formula ${carrierLabel}`;
  }
  const carrierSuffix = carrierLabel ? ` · ${carrierLabel}` : "";
  return `${label}${carrierSuffix}`;
}

/** The saved description is a snapshot: viewing/resending never re-reads live prices or bookings. */
type InvoiceServiceSnapshot = { tipo_servizio: string; descrizione_servizio?: string | null; pax?: number | null };

export function formatInvoiceServiceDescription(item: InvoiceServiceSnapshot): string {
  const description = item.descrizione_servizio?.trim() || buildInvoiceServiceDescription({ booking_service_kind: item.tipo_servizio });
  // Legacy statements did not save pax. New statements save the count (or
  // null when unavailable), without reconstructing it from current bookings.
  if (item.pax === undefined) return description;
  return Number.isSafeInteger(item.pax) && item.pax! > 0
    ? `${description} - ${item.pax} pax`
    : `${description} - pax non indicati`;
}

export function escapeInvoiceServiceDescription(item: InvoiceServiceSnapshot): string {
  return formatInvoiceServiceDescription(item).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}
