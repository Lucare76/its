import type { Service } from "@/lib/types";

type BookingListService = Partial<Pick<
  Service,
  "booking_service_kind" | "time" | "arrival_time" | "departure_time" | "train_arrival_time" | "train_departure_time" | "orario_barca"
>>;

export type BookingListTransportTimes = {
  serviceLabel: string;
  outwardLabel: string;
  outwardTime: string | null;
  returnLabel: string;
  returnTime: string | null;
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
      outwardLabel: "Partenza andata",
      outwardTime: cleanTime(service.time),
      returnLabel: "Partenza ritorno",
      returnTime: cleanTime(service.orario_barca),
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
    outwardTime: cleanTime(service.train_arrival_time) ?? cleanTime(service.arrival_time),
    returnLabel: isAirport ? "Partenza volo" : "Partenza treno/bus",
    returnTime: cleanTime(service.train_departure_time) ?? cleanTime(service.departure_time),
  };
}

function cleanTime(value: string | null | undefined) {
  const match = String(value ?? "").match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : null;
}
