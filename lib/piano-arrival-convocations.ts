export type ConvocationArrival = {
  id: string;
  direction: string;
  status: string;
  time: string;
  pax: number;
  vessel: string | null;
  meeting_point: string | null;
  origin_place_type?: string | null;
  origin_place_id?: string | null;
  hotel_id: string | null;
  destination_place_id?: string | null;
  orario_barca?: string | null;
  ferry_details?: Record<string, unknown> | null;
};

type HotelLoad = { id: string; label: string; serviceIds: string[]; pax: number };
type Convocation = {
  id: string;
  time: string;
  port: string;
  company: string;
  ferryTime: string;
  pax: number;
  loads: HotelLoad[];
};

export function buildArrivalConvocations(
  services: ConvocationArrival[],
  hotels: ReadonlyMap<string, { name: string }>,
): Convocation[] {
  const convocations = new Map<string, Omit<Convocation, "loads"> & { loads: Map<string, HotelLoad> }>();
  for (const service of services) {
    if (service.direction !== "arrival" || service.status === "cancelled" ||
        !["port", "porto"].includes(service.origin_place_type ?? "") || !service.origin_place_id) continue;
    const time = service.time?.slice(0, 5);
    const company = service.vessel?.trim().toUpperCase();
    const port = service.meeting_point?.trim();
    if (!time || !company || !port) continue;
    const ferryTime = String(service.ferry_details?.departure_time ?? service.orario_barca ?? "").trim().slice(0, 5);
    const id = JSON.stringify([service.origin_place_id, time, company, ferryTime]);
    const convocation = convocations.get(id) ?? { id, time, company, port, ferryTime, pax: 0, loads: new Map<string, HotelLoad>() };
    const hotel = hotels.get(service.hotel_id ?? "");
    const destinationId = service.destination_place_id ?? service.hotel_id ?? service.id;
    const load = convocation.loads.get(destinationId) ?? {
      id: destinationId,
      label: hotel?.name ?? "Destinazione da verificare",
      serviceIds: [],
      pax: 0,
    };
    load.serviceIds.push(service.id);
    load.pax += service.pax;
    convocation.pax += service.pax;
    convocation.loads.set(destinationId, load);
    convocations.set(id, convocation);
  }

  return [...convocations.values()].map((convocation) => ({
    ...convocation,
    loads: [...convocation.loads.values()].sort((a, b) => b.pax - a.pax || a.label.localeCompare(b.label)),
  })).sort((a, b) => a.time.localeCompare(b.time) || a.company.localeCompare(b.company));
}
