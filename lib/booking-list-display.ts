import type { Service } from "@/lib/types";

type BookingListService = Partial<Pick<
  Service,
  "booking_service_kind" | "date" | "time" | "arrival_date" | "arrival_time" | "departure_date" | "departure_time" | "train_arrival_time" | "train_departure_time" | "orario_barca" | "bus_city_origin" | "meeting_point" | "transport_code" | "pickup_hotel"
>> & {
  pickup_time?: string | null;
  bus_outward_pickup_point?: string | null;
  outbound_ferry_departure_time?: string | null;
  outbound_ferry_arrival_time?: string | null;
  return_pickup_time?: string | null;
  return_ferry_departure_time?: string | null;
  outbound_ferry_company?: string | null;
  outbound_ferry_departure_port?: string | null;
  outbound_ferry_arrival_port?: string | null;
  return_ferry_company?: string | null;
  return_ferry_departure_port?: string | null;
  return_ferry_arrival_port?: string | null;
};

export type BookingListTransportTimes = {
  serviceLabel: string;
  outwardLabel: string;
  outwardDate: string | null;
  outwardTime: string | null;
  returnLabel: string;
  returnDate: string | null;
  returnTime: string | null;
  outwardArrivalTime?: string | null;
  returnPickupTime?: string | null;
  outwardCompany?: string | null;
  outwardRoute?: string | null;
  outwardArrivalPort?: string | null;
  returnCompany?: string | null;
  returnRoute?: string | null;
  returnDeparturePort?: string | null;
  outwardPickupPoint?: string | null;
};

export function bookingListTransportTimes(service: BookingListService): BookingListTransportTimes | null {
  const kind = service.booking_service_kind;
  if (!kind) return null;

  if (kind === "formula_medmar_napoli" || kind === "formula_medmar_pozzuoli" || kind === "formula_snav") {
    return {
      serviceLabel: kind === "formula_snav"
        ? "Formula SNAV"
        : kind === "formula_medmar_napoli"
          ? "Formula MEDMAR Napoli"
          : "Formula MEDMAR Pozzuoli",
      outwardLabel: "Traghetto/aliscafo dalla terraferma",
      outwardDate: cleanDate(service.arrival_date) ?? cleanDate(service.date),
      outwardTime: cleanTime(service.outbound_ferry_departure_time) ?? cleanTime(service.time),
      outwardArrivalTime: cleanTime(service.outbound_ferry_arrival_time) ?? cleanTime(service.arrival_time),
      outwardCompany: service.outbound_ferry_company ?? null,
      outwardRoute: routeLabel(service.outbound_ferry_departure_port, service.outbound_ferry_arrival_port),
      outwardArrivalPort: service.outbound_ferry_arrival_port ?? null,
      returnLabel: "Traghetto/aliscafo dall'isola",
      returnDate: cleanDate(service.departure_date),
      returnTime: cleanTime(service.return_ferry_departure_time) ?? cleanTime(service.orario_barca),
      returnPickupTime: cleanTime(service.return_pickup_time) ?? cleanTime(service.departure_time),
      returnCompany: service.return_ferry_company ?? null,
      returnRoute: routeLabel(service.return_ferry_departure_port, service.return_ferry_arrival_port),
      returnDeparturePort: service.return_ferry_departure_port ?? null,
    };
  }

  // transfer_port_hotel (import IMAP+Claude, es. Aleste Viaggi via SNAV/MEDMAR): a
  // differenza delle "formula_*" non ha quasi mai i campi ferry dedicati calcolati
  // (outbound_ferry_*/return_pickup_time), popolati solo se esiste una gamba di
  // ritorno collegata (linked_service_id) risolta da app/api/ops/search — per le
  // prenotazioni legacy a riga singola restano null, ed è corretto così.
  // departure_time è l'orario del traghetto/aliscafo di PARTENZA (mai il pickup
  // hotel: vedi fix del 2026-08-26, prima veniva mostrato erroneamente come tale).
  // Il vero orario di pickup in hotel va SOLO da return_pickup_time (calcolato,
  // stessa fonte usata da bus/treno/aeroporto) o da pickup_hotel (calcPickupTime,
  // supabase/migrations/0106_pickup_calc_fields.sql) — mai da departure_time.
  if (kind === "transfer_port_hotel") {
    const hasReturn = Boolean(cleanDate(service.departure_date));
    const [outwardCompany, returnCompanyCandidate] = splitTransportCode(service.transport_code);
    return {
      serviceLabel: "Trasferimento porto - hotel",
      outwardLabel: "Arrivo traghetto/aliscafo",
      outwardDate: cleanDate(service.arrival_date) ?? cleanDate(service.date),
      outwardTime: cleanTime(service.arrival_time) ?? cleanTime(service.time),
      outwardArrivalTime: cleanTime(service.outbound_ferry_arrival_time) ?? null,
      outwardPickupPoint: service.meeting_point ?? null,
      outwardCompany,
      returnLabel: "Partenza traghetto/aliscafo",
      returnDate: cleanDate(service.departure_date),
      returnTime: cleanTime(service.orario_barca) ?? cleanTime(service.departure_time),
      returnPickupTime: hasReturn ? (cleanTime(service.return_pickup_time) ?? cleanTime(service.pickup_hotel)) : null,
      returnCompany: hasReturn ? returnCompanyCandidate : null,
    };
  }

  const isAirport = kind === "transfer_airport_hotel"
    || kind === "transfer_airport_hotel_exclusive"
    || kind === "transfer_airport_hotel_aliscafo";
  const isStation = kind === "transfer_train_hotel"
    || kind === "transfer_train_hotel_exclusive"
    || kind === "transfer_train_hotel_aliscafo"
    || kind === "bus_city_hotel";
  if (!isAirport && !isStation) return null;

  const suffix = kind.endsWith("_exclusive") ? " (esclusivo)" : kind.endsWith("_aliscafo") ? " (aliscafo)" : "";
  const isBusLine = kind === "bus_city_hotel";
  const outwardTime = cleanTime(service.train_arrival_time) ?? cleanTime(service.arrival_time);
  const outwardArrivalTime = cleanTime(service.outbound_ferry_arrival_time) ?? cleanTime(service.time);
  // Per la linea bus l'orario "outward" è la partenza dalla città di origine
  // (es. Modena), non un arrivo: l'arrivo vero è già mostrato separatamente
  // in outwardArrivalTime ("Arrivo indicativo").
  const outwardLabel = isAirport
    ? "Arrivo volo"
    : isBusLine
      ? (service.bus_city_origin ? `Partenza da ${service.bus_city_origin}` : "Partenza bus")
      : "Arrivo treno";
  return {
    serviceLabel: `${isAirport ? "Trasferimento aeroporto - hotel" : isBusLine ? "Linea Bus" : "Trasferimento stazione - hotel"}${suffix}`,
    outwardLabel,
    outwardDate: cleanDate(service.arrival_date) ?? cleanDate(service.date),
    outwardTime,
    outwardArrivalTime: isBusLine && outwardArrivalTime === outwardTime ? null : outwardArrivalTime,
    outwardPickupPoint: isBusLine ? service.bus_outward_pickup_point ?? null : null,
    returnLabel: isAirport ? "Partenza volo" : isBusLine ? "Partenza bus" : "Partenza treno",
    returnDate: cleanDate(service.departure_date),
    returnTime: cleanTime(service.train_departure_time) ?? cleanTime(service.departure_time),
    returnPickupTime: cleanTime(service.return_pickup_time) ?? (isBusLine ? cleanTime(service.pickup_time) : null),
  };
}

function cleanDate(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : null;
}

function cleanTime(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function routeLabel(from: string | null | undefined, to: string | null | undefined) {
  return from && to ? `${from} → ${to}` : null;
}

/** "SNAV / MEDMAR" -> ["SNAV", "MEDMAR"]; "SNAV" -> ["SNAV", "SNAV"]; vuoto -> [null, null]. */
function splitTransportCode(value: string | null | undefined): [string | null, string | null] {
  const parts = String(value ?? "").split("/").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return [null, null];
  return [parts[0], parts[1] ?? parts[0]];
}
