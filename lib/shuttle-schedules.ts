import type { Hotel, Service } from "@/lib/types";

export interface ShuttleSchedule {
  id: string;
  tenant_id: string;
  hotel_id: string | null;
  booking_service_kind: "navetta" | "shuttle_hotel";
  customer_name: string;
  direction: "arrival" | "departure";
  departure_time: string;
  meeting_point: string | null;
  vessel: string;
  valid_from: string;
  valid_to: string;
  days_of_week: number[] | null;
  notes: string | null;
}

type ShuttleLikeService = Pick<
  Service,
  | "tenant_id"
  | "hotel_id"
  | "booking_service_kind"
  | "customer_name"
  | "direction"
  | "time"
  | "meeting_point"
  | "vessel"
  | "date"
  | "notes"
>;

type ShuttleKeyPayload = {
  hotel_id: string | null;
  booking_service_kind: "navetta" | "shuttle_hotel";
  customer_name: string;
  direction: "arrival" | "departure";
  departure_time: string;
  meeting_point: string | null;
  vessel: string;
};

function normalizedKind(service: ShuttleLikeService): "navetta" | "shuttle_hotel" | null {
  const kind = service.booking_service_kind as string | null | undefined;
  if (kind === "navetta" || kind === "shuttle_hotel") {
    return kind;
  }
  if ((service.vessel ?? "").trim().toLowerCase() === "navetta") {
    return "navetta";
  }
  return null;
}

function normalizedText(value: string | null | undefined, fallback = "") {
  return value?.trim() || fallback;
}

function encodePayload(payload: ShuttleKeyPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeShuttleScheduleId(id: string): ShuttleKeyPayload {
  return JSON.parse(Buffer.from(id, "base64url").toString("utf8")) as ShuttleKeyPayload;
}

export function buildShuttleScheduleId(payload: ShuttleKeyPayload) {
  return encodePayload(payload);
}

export function isShuttleLikeService(service: ShuttleLikeService) {
  return normalizedKind(service) !== null;
}

export function deriveShuttleSchedules(services: ShuttleLikeService[]) {
  const grouped = new Map<string, ShuttleSchedule>();

  for (const service of services) {
    const kind = normalizedKind(service);
    if (!kind) continue;

    const payload: ShuttleKeyPayload = {
      hotel_id: service.hotel_id ?? null,
      booking_service_kind: kind,
      customer_name: normalizedText(service.customer_name, "Navetta"),
      direction: service.direction,
      departure_time: service.time.slice(0, 5),
      meeting_point: normalizedText(service.meeting_point) || null,
      vessel: normalizedText(service.vessel, "Navetta"),
    };
    const key = buildShuttleScheduleId(payload);
    const current = grouped.get(key);
    const serviceDate = service.date;
    const serviceDow = new Date(`${serviceDate}T12:00:00`).getDay();

    if (!current) {
      grouped.set(key, {
        id: key,
        tenant_id: service.tenant_id,
        hotel_id: payload.hotel_id,
        booking_service_kind: payload.booking_service_kind,
        customer_name: payload.customer_name,
        direction: payload.direction,
        departure_time: payload.departure_time,
        meeting_point: payload.meeting_point,
        vessel: payload.vessel,
        valid_from: serviceDate,
        valid_to: serviceDate,
        days_of_week: [serviceDow],
        notes: normalizedText(service.notes) || null,
      });
      continue;
    }

    if (serviceDate < current.valid_from) current.valid_from = serviceDate;
    if (serviceDate > current.valid_to) current.valid_to = serviceDate;
    if (!current.days_of_week?.includes(serviceDow)) {
      current.days_of_week = [...(current.days_of_week ?? []), serviceDow].sort((left, right) => left - right);
    }
  }

  return Array.from(grouped.values()).sort((left, right) => {
    const leftHotel = left.hotel_id ?? "";
    const rightHotel = right.hotel_id ?? "";
    return leftHotel !== rightHotel
      ? leftHotel.localeCompare(rightHotel)
      : left.departure_time.localeCompare(right.departure_time);
  });
}

export function enumerateShuttleDates(schedule: ShuttleSchedule, startDate?: string) {
  const dates: string[] = [];
  const firstDate = startDate && startDate > schedule.valid_from ? startDate : schedule.valid_from;
  const cursor = new Date(`${firstDate}T12:00:00`);
  const end = new Date(`${schedule.valid_to}T12:00:00`);

  while (cursor <= end) {
    const isoDate = cursor.toISOString().slice(0, 10);
    const dow = cursor.getDay();
    if (!schedule.days_of_week?.length || schedule.days_of_week.includes(dow)) {
      dates.push(isoDate);
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

export function resolveShuttleHotelName(schedule: ShuttleSchedule, hotelsById: Map<string, Hotel>) {
  return hotelsById.get(schedule.hotel_id ?? "")?.name ?? schedule.customer_name;
}
