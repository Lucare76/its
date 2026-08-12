import type { Service } from "@/lib/types";

type BookingListService = Partial<Pick<
  Service,
  "booking_service_kind" | "date" | "time" | "arrival_date" | "arrival_time" | "departure_date" | "departure_time" | "train_arrival_time" | "train_departure_time" | "orario_barca"
>> & {
  outbound_ferry_departure_time?: string | null;
  outbound_ferry_arrival_time?: string | null;
  return_pickup_time?: string | null;
  return_ferry_departure_time?: string | null;
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
      returnLabel: "Traghetto/aliscafo dall'isola",
      returnDate: cleanDate(service.departure_date),
      returnTime: cleanTime(service.return_ferry_departure_time) ?? cleanTime(service.orario_barca),
      returnPickupTime: cleanTime(service.return_pickup_time) ?? cleanTime(service.departure_time),
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
  return {
    serviceLabel: `${isAirport ? "Trasferimento aeroporto - hotel" : "Trasferimento stazione / bus - hotel"}${suffix}`,
    outwardLabel: isAirport ? "Arrivo volo" : "Arrivo treno/bus",
    outwardDate: cleanDate(service.arrival_date) ?? cleanDate(service.date),
    outwardTime: cleanTime(service.train_arrival_time) ?? cleanTime(service.arrival_time),
    returnLabel: isAirport ? "Partenza volo" : "Partenza treno/bus",
    returnDate: cleanDate(service.departure_date),
    returnTime: cleanTime(service.train_departure_time) ?? cleanTime(service.departure_time),
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
