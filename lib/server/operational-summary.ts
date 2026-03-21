import { buildOperationalInstances } from "@/lib/operational-service-instances";
import type { Service } from "@/lib/types";

type SummaryLine = {
  service_id: string;
  customer_name: string;
  date: string;
  time: string;
  direction: "arrival" | "departure";
  hotel_or_destination: string | null;
  booking_kind: string | null;
  service_type_code: string | null;
  billing_party_name: string | null;
  pax: number;
  total_amount_cents: number | null;
  currency: string | null;
};

export type SummaryPreviewPayload = {
  generated_at: string;
  target_date_48h: string;
  arrivals_48h: Record<string, SummaryLine[]>;
  departures_48h: Record<string, SummaryLine[]>;
  bus_monday: Record<string, SummaryLine[]>;
  statement_candidates: Record<string, SummaryLine[]>;
  export_history?: Array<{
    id: string;
    date_from: string;
    date_to: string;
    service_type: string;
    exported_count: number;
    created_at: string;
  }>;
};

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function isMonday(dateIso: string) {
  const date = new Date(`${dateIso}T12:00:00`);
  return date.getDay() === 1;
}

function hotelNameFromService(service: Service) {
  const raw = service.notes.match(/\[hotel:([^\]]+)\]/i)?.[1] ?? null;
  return raw ? raw.trim() : null;
}

function lineFromInstance(instance: ReturnType<typeof buildOperationalInstances>[number]): SummaryLine {
  return {
    service_id: instance.serviceId,
    customer_name: instance.service.customer_name,
    date: instance.date,
    time: instance.time,
    direction: instance.direction,
    hotel_or_destination: hotelNameFromService(instance.service),
    booking_kind: instance.service.booking_service_kind ?? null,
    service_type_code: instance.service.service_type_code ?? null,
    billing_party_name: instance.service.billing_party_name ?? null,
    pax: instance.service.pax,
    total_amount_cents: instance.service.source_total_amount_cents ?? null,
    currency: instance.service.source_amount_currency ?? null
  };
}

function groupByBookingOwner(lines: SummaryLine[]) {
  return lines.reduce<Record<string, SummaryLine[]>>((acc, line) => {
    const key = line.billing_party_name?.trim() || "Privati / non classificati";
    acc[key] = [...(acc[key] ?? []), line];
    return acc;
  }, {});
}

export function buildOperationalSummaryPreview(services: Service[], todayIso: string, statementAgencyNames: string[] = []) {
  const instances = buildOperationalInstances(services);
  const targetDate48h = addDays(todayIso, 2);
  const arrivals48h = instances.filter((item) => item.direction === "arrival" && item.date === targetDate48h && item.service.booking_service_kind !== "bus_city_hotel");
  const departures48h = instances.filter((item) => item.direction === "departure" && item.date === targetDate48h && item.service.booking_service_kind !== "bus_city_hotel");

  const busWeekly = isMonday(todayIso)
    ? instances.filter((item) => item.service.booking_service_kind === "bus_city_hotel" && item.date >= todayIso)
    : [];

  const statementCandidates = instances.filter((item) =>
    Boolean(item.service.billing_party_name && statementAgencyNames.includes(item.service.billing_party_name))
  );

  return {
    generated_at: new Date().toISOString(),
    target_date_48h: targetDate48h,
    arrivals_48h: groupByBookingOwner(arrivals48h.map(lineFromInstance)),
    departures_48h: groupByBookingOwner(departures48h.map(lineFromInstance)),
    bus_monday: groupByBookingOwner(busWeekly.map(lineFromInstance)),
    statement_candidates: groupByBookingOwner(statementCandidates.map(lineFromInstance))
  } satisfies SummaryPreviewPayload;
}
