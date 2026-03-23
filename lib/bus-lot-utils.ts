import { findNearestBusStop } from "@/lib/bus-lines-catalog";
import type { BusLotConfig, Service } from "@/lib/types";

export function isBusLineService(service: Service) {
  return service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel";
}

export function isTrueBusTour(service: Service) {
  return (service.service_type ?? "transfer") === "bus_tour" && !isBusLineService(service);
}

export function buildBusLotKey(service: Service) {
  const busLineIdentity = deriveBusLineIdentity({
    busCityOrigin: service.bus_city_origin,
    time: service.outbound_time ?? service.time,
    transportCode: service.transport_code,
    title: service.tour_name,
    meetingPoint: service.meeting_point
  });

  return [
    service.date,
    service.direction,
    busLineIdentity.lineCode?.trim().toLowerCase() || service.bus_city_origin?.trim().toLowerCase() || "n-d"
  ].join("|");
}

function cleanBusLotLabelPart(value?: string | null) {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function deriveBusLotTitle(input: {
  title?: string | null;
  transportCode?: string | null;
  busCityOrigin?: string | null;
  time?: string | null;
  meetingPoint?: string | null;
}) {
  const busLineIdentity = deriveBusLineIdentity({
    title: input.title,
    transportCode: input.transportCode,
    busCityOrigin: input.busCityOrigin,
    time: input.time,
    meetingPoint: input.meetingPoint
  });
  if (busLineIdentity.lineName) return busLineIdentity.lineName;

  const explicitTitle = cleanBusLotLabelPart(input.title);
  if (explicitTitle) return explicitTitle;

  const transportCode = cleanBusLotLabelPart(input.transportCode);
  const busCityOrigin = cleanBusLotLabelPart(input.busCityOrigin);
  const meetingPoint = cleanBusLotLabelPart(input.meetingPoint);

  if (transportCode && busCityOrigin) return `${transportCode} - ${busCityOrigin}`;
  if (transportCode) return `Linea bus ${transportCode}`;
  if (busCityOrigin) return `Linea bus ${busCityOrigin}`;
  if (meetingPoint) return `Linea bus ${meetingPoint}`;
  return "Linea bus";
}

export function deriveBusLineIdentity(input: {
  title?: string | null;
  transportCode?: string | null;
  busCityOrigin?: string | null;
  time?: string | null;
  meetingPoint?: string | null;
}) {
  const directCode = cleanBusLotLabelPart(input.transportCode);
  if (directCode?.toUpperCase().startsWith("LINEA_")) {
    const readableName = directCode
      .toLowerCase()
      .replace(/^linea_/, "Linea ")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
    return { lineCode: directCode, lineName: readableName };
  }

  const nearest = findNearestBusStop(input.busCityOrigin, input.time);
  if (nearest) {
    return { lineCode: nearest.lineCode, lineName: nearest.lineName };
  }

  return { lineCode: null, lineName: null };
}

export type BusLotAggregate = {
  key: string;
  date: string;
  direction: "arrival" | "departure";
  billing_party_name: string | null;
  bus_city_origin: string | null;
  transport_code: string | null;
  meeting_point: string | null;
  title: string | null;
  services: Service[];
  service_count: number;
  pax_total: number;
  config: BusLotConfig | null;
  capacity: number | null;
  remaining_seats: number | null;
  alerts: Array<{ label: string; severity: "high" | "medium" | "low" }>;
};

export function buildBusLotAggregates(services: Service[], configs: BusLotConfig[]) {
  const configByKey = new Map(configs.map((item) => [item.lot_key, item]));
  const groups = services.reduce<Map<string, Service[]>>((acc, service) => {
    const key = buildBusLotKey(service);
    acc.set(key, [...(acc.get(key) ?? []), service]);
    return acc;
  }, new Map());

  return Array.from(groups.entries())
    .map(([key, lotServices]) => {
      const first = lotServices[0];
      const lineIdentity = deriveBusLineIdentity({
        title: first.tour_name,
        transportCode: first.transport_code,
        busCityOrigin: first.bus_city_origin,
        time: first.outbound_time ?? first.time,
        meetingPoint: first.meeting_point
      });
      const config = configByKey.get(key) ?? null;
      const paxTotal = lotServices.reduce((sum, item) => sum + item.pax, 0);
      const billingParties = [...new Set(lotServices.map((service) => cleanBusLotLabelPart(service.billing_party_name)).filter(Boolean))];
      const capacity = config?.capacity ?? null;
      const remainingSeats = capacity !== null ? capacity - paxTotal : null;
      const lowSeatThreshold = config?.low_seat_threshold ?? 4;
      const minimumPassengers = config?.minimum_passengers ?? null;
      const waitlistEnabled = config?.waitlist_enabled ?? false;
      const waitlistCount = config?.waitlist_count ?? 0;
      const alerts: Array<{ label: string; severity: "high" | "medium" | "low" }> = [];

      if (remainingSeats !== null && remainingSeats <= 0) {
        alerts.push({ label: "Completo", severity: "high" });
      } else if (remainingSeats !== null && remainingSeats <= lowSeatThreshold) {
        alerts.push({ label: `Pochi posti (${remainingSeats})`, severity: "medium" });
      }
      if (minimumPassengers && paxTotal < minimumPassengers) {
        alerts.push({ label: `Sotto minimo (${paxTotal}/${minimumPassengers})`, severity: "low" });
      }
      if (waitlistEnabled && waitlistCount > 0) {
        alerts.push({ label: `Waiting list ${waitlistCount} pax`, severity: "high" });
      }

      return {
        key,
        date: first.date,
        direction: first.direction,
        billing_party_name: billingParties.length === 1 ? billingParties[0] ?? null : billingParties.length > 1 ? `${billingParties.length} agenzie` : null,
        bus_city_origin: first.bus_city_origin ?? null,
        transport_code: lineIdentity.lineCode ?? first.transport_code ?? null,
        meeting_point: first.meeting_point ?? null,
        title: deriveBusLotTitle({
          title: config?.title ?? first.tour_name,
          transportCode: lineIdentity.lineCode ?? first.transport_code,
          busCityOrigin: first.bus_city_origin,
          time: first.outbound_time ?? first.time,
          meetingPoint: first.meeting_point
        }),
        services: lotServices,
        service_count: lotServices.length,
        pax_total: paxTotal,
        config,
        capacity,
        remaining_seats: remainingSeats,
        alerts
      } satisfies BusLotAggregate;
    })
    .sort((left, right) => `${left.date}T${left.services[0]?.time ?? "00:00"}`.localeCompare(`${right.date}T${right.services[0]?.time ?? "00:00"}`));
}
