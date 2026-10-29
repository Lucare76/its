import { buildServiceLabelShort, type AgencyBookingKind } from "@/lib/service-label";

/** Only structured booking fields: a carrier mentioned in free notes is not a formula. */
export type InvoiceServiceContext = {
  booking_service_kind?: string | null;
  service_type?: string | null;
  vessel?: string | null;
  transport_code?: string | null;
  include_ferry_tickets?: boolean | null;
  ferry_details?: unknown;
};

const PORT_KINDS = new Set(["transfer_port_hotel", "transfer_hotel_port"]);

function kindLabel(kind: string): string {
  switch (kind) {
    case "transfer_port_hotel": return "Transfer Porto / Hotel";
    case "transfer_hotel_port": return "Transfer Hotel / Porto";
    case "transfer_train_hotel":
    case "transfer_station_hotel": return "Transfer Stazione / Hotel";
    case "transfer_airport_hotel": return "Transfer Aeroporto / Hotel";
    case "transfer": return "Transfer";
    case "bus_tour": return "Bus";
    default:
      return buildServiceLabelShort({ kind: kind as AgencyBookingKind }) || kind || "Servizio non specificato";
  }
}

export function buildInvoiceServiceDescription(service: InvoiceServiceContext): string {
  const kind = service.booking_service_kind || service.service_type || "transfer";
  const label = kindLabel(kind);
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
  if (PORT_KINDS.has(kind) && service.include_ferry_tickets === true && carriers.size === 1
    && (carriers.has("SNAV") || carriers.has("MEDMAR"))) {
    return `Formula ${carrierLabel}`;
  }
  const carrierSuffix = carrierLabel ? ` · ${carrierLabel}` : "";
  return `${label}${carrierSuffix}${PORT_KINDS.has(kind) ? " (formula non specificata)" : ""}`;
}

/** The saved description is a snapshot: viewing/resending never re-reads live prices or bookings. */
export function formatInvoiceServiceDescription(item: { tipo_servizio: string; descrizione_servizio?: string | null }): string {
  return item.descrizione_servizio?.trim() || buildInvoiceServiceDescription({ booking_service_kind: item.tipo_servizio });
}

export function escapeInvoiceServiceDescription(item: { tipo_servizio: string; descrizione_servizio?: string | null }): string {
  return formatInvoiceServiceDescription(item).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}
