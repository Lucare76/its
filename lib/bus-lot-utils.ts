import type { BusLotConfig, Service } from "@/lib/types";

export function isBusLineService(service: Service) {
  return service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel";
}

export function isTrueBusTour(service: Service) {
  return (service.service_type ?? "transfer") === "bus_tour" && !isBusLineService(service);
}

export function buildBusLotKey(service: Service) {
  return [
    service.date,
    service.direction,
    service.billing_party_name?.trim().toLowerCase() || "n-d",
    service.bus_city_origin?.trim().toLowerCase() || "n-d",
    service.transport_code?.trim().toLowerCase() || "n-d"
  ].join("|");
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
      const config = configByKey.get(key) ?? null;
      const paxTotal = lotServices.reduce((sum, item) => sum + item.pax, 0);
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
        billing_party_name: first.billing_party_name ?? null,
        bus_city_origin: first.bus_city_origin ?? null,
        transport_code: first.transport_code ?? null,
        meeting_point: first.meeting_point ?? null,
        title: config?.title ?? first.tour_name ?? `${first.billing_party_name ?? "Bus"} ${first.bus_city_origin ?? ""}`.trim(),
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
