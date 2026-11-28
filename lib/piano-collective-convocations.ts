import { z } from "zod";
import { buildArrivalConvocations, type ConvocationArrival } from "@/lib/piano-arrival-convocations";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const collectiveConvocationSchema = z.object({
  date: z.string().date(),
  event_key: z.string().min(1).max(500),
  active: z.boolean(),
  last_departure: time,
  margin_min: z.number().int().min(25).max(35).default(25),
  margin_max: z.number().int().min(25).max(35).default(35),
}).strict().refine((value) => value.margin_min <= value.margin_max, "Margini non validi");
export type CollectiveConvocation = z.infer<typeof collectiveConvocationSchema> & { updated_at?: string };
export type CollectiveReservation = CollectiveConvocation & {
  arrival: string;
  port: string;
  label: string;
  serviceIds: string[];
};
export const timeMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
export function timeLabel(value: number) {
  return `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function resolveCollectiveReservations(configs: CollectiveConvocation[], services: ConvocationArrival[]): CollectiveReservation[] {
  const events = buildArrivalConvocations(services, new Map());
  return configs.filter((config) => config.active).flatMap((config) => {
    const event = events.find((entry) => entry.id === config.event_key);
    if (!event) return [];
    return [{ ...config, arrival: event.time, port: event.port,
      label: `${event.time} · ${event.company} · ${event.port}`,
      serviceIds: event.loads.flatMap((load) => load.serviceIds) }];
  });
}

/** No knowledge of the on-site split: never invent a driver's last hotel.
 * Before the ferry require service duration + travel to port; after the last
 * departure allow proposals, but flag the entire uncertain delivery/reposition window.
 */
export function collectiveImpact(reservations: CollectiveReservation[], start: number, durationAndTravel: number) {
  const blocked = reservations.find((event) => start < timeMinutes(event.last_departure) &&
    start + durationAndTravel > timeMinutes(event.arrival));
  const uncertain = reservations.find((event) => start >= timeMinutes(event.last_departure) &&
    start < timeMinutes(event.last_departure) + event.margin_max + 60);
  return { blocked, uncertain };
}
