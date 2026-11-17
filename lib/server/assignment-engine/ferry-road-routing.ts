import type { SupabaseClient } from "@supabase/supabase-js";
import type { AutoAssignPreviewServiceRow } from "@/lib/piano-assignable-preview";
import type { FerryRoadRouting } from "@/lib/piano-ferry-road-pickup";

type ServicePlaces = { id: string; origin_place_id?: unknown; destination_place_id?: unknown; hotel_id?: string | null };

export async function loadFerryRoadRouting(
  admin: SupabaseClient,
  tenantId: string,
  rows: AutoAssignPreviewServiceRow[],
  services: ServicePlaces[],
  hotels: Array<{ id: string; lat: number | null; lng: number | null }>,
): Promise<FerryRoadRouting> {
  const unavailable = () => null;
  const departures = new Set(rows.filter((row) =>
    row.macro_category === "PARTENZA" && row.assignable && !row.needs_review &&
    !row.is_locked && !row.already_assigned && row.port_departure && row.ferry_departure_time
  ).map((row) => row.service_id));
  const candidates = services.filter((service) => departures.has(service.id));
  const placeIds = [...new Set(candidates.flatMap(({ origin_place_id, destination_place_id }) =>
    [origin_place_id, destination_place_id].filter((id): id is string => typeof id === "string")
  ))];
  if (!placeIds.length || placeIds.length > 100) return unavailable;

  const { data, error } = await admin.from("places").select("id, lat, lng, place_type")
    .eq("tenant_id", tenantId).eq("active", true).in("id", placeIds);
  if (error || !data) return unavailable;
  const places = new Map(data.map((place) => [place.id, place]));
  const hotelsById = new Map(hotels.map((hotel) => [hotel.id, hotel]));
  const indexes = new Map<string, number>();
  const register = (place?: { lat: number | null; lng: number | null }) => {
    if (!place || typeof place.lat !== "number" || typeof place.lng !== "number" ||
        !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return null;
    const key = `${place.lng},${place.lat}`;
    if (!indexes.has(key)) indexes.set(key, indexes.size);
    return indexes.get(key)!;
  };
  const points = new Map<string, { pickup: number; port: number }>();
  for (const service of candidates) {
    const destination = places.get(service.destination_place_id);
    if (!destination || !["port", "porto"].includes(destination.place_type)) continue;
    const port = register(destination);
    const pickup = register(places.get(service.origin_place_id) ?? hotelsById.get(service.hotel_id ?? ""));
    if (pickup !== null && port !== null && pickup !== port) points.set(service.id, { pickup, port });
  }
  if (points.size < 2 || indexes.size > 50) return unavailable;

  try {
    const coordinates = [...indexes.keys()].join(";");
    const response = await fetch(`https://routing.openstreetmap.de/routed-car/table/v1/driving/${coordinates}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return unavailable;
    const body = await response.json() as { code?: string; durations?: Array<Array<number | null>> };
    if (body.code !== "Ok" || !Array.isArray(body.durations)) return unavailable;
    const durations = body.durations;
    return (previousId, nextId) => {
      const previous = points.get(previousId);
      const next = points.get(nextId);
      if (!previous || !next || previous.port !== next.port || previous.pickup === next.pickup) return null;
      const betweenSeconds = durations[previous.pickup]?.[next.pickup];
      const toPortSeconds = durations[next.pickup]?.[next.port];
      return typeof betweenSeconds === "number" && typeof toPortSeconds === "number"
        ? { betweenSeconds, toPortSeconds }
        : null;
    };
  } catch {
    return unavailable;
  }
}
