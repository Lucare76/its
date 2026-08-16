import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const nilUuid = "00000000-0000-0000-0000-000000000000";

export const serviceQueryFiltersSchema = z
  .object({
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    status: z
      .array(z.enum(["needs_review", "new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled"]))
      .optional()
      .default([]),
    ship: z.string().max(120).optional().default(""),
    zone: z.string().max(120).optional().default(""),
    hotel_id: z.string().uuid().optional(),
    tenant_id: z.string().uuid(),
    agency_id: z.string().uuid().optional(),
    created_by: z.string().uuid().optional(),
    search: z.string().max(200).optional().default(""),
    service_type: z.enum(["transfer", "bus_tour"]).optional(),
    driver_user_id: z.string().uuid().optional()
  })
  .refine((value) => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, {
    message: "Intervallo date non valido",
    path: ["dateFrom"]
  });

export type ServiceQueryFilters = z.infer<typeof serviceQueryFiltersSchema>;

interface BuildServicesQueryArgs {
  admin: SupabaseClient;
  filters: ServiceQueryFilters;
  select: string;
}

function sanitizeLikeValue(raw: string) {
  return raw.replace(/[%_]/g, "");
}

function sanitizeOrValue(raw: string) {
  return raw.replace(/[,%]/g, " ");
}

export async function buildServicesQuery({ admin, filters, select }: BuildServicesQueryArgs): Promise<{ query: any }> {
  const parsed = serviceQueryFiltersSchema.parse(filters);

  let query = admin.from("services").select(select).eq("tenant_id", parsed.tenant_id);

  if (parsed.dateFrom) query = query.gte("date", parsed.dateFrom);
  if (parsed.dateTo) query = query.lte("date", parsed.dateTo);

  if (parsed.status.length > 0) {
    query = query.in("status", parsed.status);
  }

  if (parsed.ship.trim()) {
    query = query.ilike("vessel", `%${sanitizeLikeValue(parsed.ship.trim())}%`);
  }

  if (parsed.hotel_id) {
    query = query.eq("hotel_id", parsed.hotel_id);
  }

  if (parsed.service_type) {
    query =
      parsed.service_type === "transfer"
        ? query.or("service_type.is.null,service_type.eq.transfer")
        : query.eq("service_type", parsed.service_type);
  }

  if (parsed.driver_user_id) {
    const { data: driverAssignments, error: driverAssignmentsError } = await admin
      .from("assignments")
      .select("service_id")
      .eq("tenant_id", parsed.tenant_id)
      .eq("driver_user_id", parsed.driver_user_id);
    if (driverAssignmentsError) throw driverAssignmentsError;
    const driverServiceIds = Array.from(new Set((driverAssignments ?? []).map((row) => row.service_id as string)));
    query = query.in("id", driverServiceIds.length > 0 ? driverServiceIds : [nilUuid]);
  }

  if (parsed.search.trim()) {
    const search = sanitizeOrValue(parsed.search.trim());
    const conditions = [
      `customer_name.ilike.%${search}%`,
      `customer_first_name.ilike.%${search}%`,
      `customer_last_name.ilike.%${search}%`,
      `phone.ilike.%${search}%`,
      `vessel.ilike.%${search}%`,
      `notes.ilike.%${search}%`,
      `billing_party_name.ilike.%${search}%`,
      `transport_code.ilike.%${search}%`,
      `bus_city_origin.ilike.%${search}%`,
      `booking_service_kind.ilike.%${search}%`
    ];
    if (/^\d{4}-\d{2}-\d{2}$/.test(search)) {
      conditions.push(`arrival_date.eq.${search}`, `departure_date.eq.${search}`, `date.eq.${search}`);
    }
    if (/^\d{2}:\d{2}$/.test(search)) {
      conditions.push(`time.eq.${search}`, `arrival_time.eq.${search}`, `departure_time.eq.${search}`);
    }
    const paxSearch = Number(search);
    if (Number.isInteger(paxSearch) && paxSearch > 0 && paxSearch <= 999) {
      conditions.push(`pax.eq.${paxSearch}`);
    }
    const { data: searchHotels, error: searchHotelsError } = await admin
      .from("hotels")
      .select("id")
      .eq("tenant_id", parsed.tenant_id)
      .or(`name.ilike.%${search}%,zone.ilike.%${search}%`);
    if (searchHotelsError) throw searchHotelsError;
    const searchHotelIds = (searchHotels ?? []).map((hotel) => hotel.id as string);
    if (searchHotelIds.length > 0) {
      conditions.push(`hotel_id.in.(${searchHotelIds.join(",")})`);
    }
    query = query.or(conditions.join(","));
  }

  if (parsed.zone.trim()) {
    const { data: zoneHotels, error: zoneHotelsError } = await admin
      .from("hotels")
      .select("id")
      .eq("tenant_id", parsed.tenant_id)
      .ilike("zone", `%${sanitizeLikeValue(parsed.zone.trim())}%`);
    if (zoneHotelsError) throw zoneHotelsError;

    const zoneHotelIds = (zoneHotels ?? []).map((hotel) => hotel.id as string);
    query = query.in("hotel_id", zoneHotelIds.length > 0 ? zoneHotelIds : [nilUuid]);
  }

  const actorId = parsed.created_by ?? parsed.agency_id;
  if (actorId) {
    const { data: actorEvents, error: actorEventsError } = await admin
      .from("status_events")
      .select("service_id")
      .eq("tenant_id", parsed.tenant_id)
      .eq("by_user_id", actorId);
    if (actorEventsError) throw actorEventsError;

    const actorServiceIds = Array.from(new Set((actorEvents ?? []).map((event) => event.service_id as string)));
    query = query.in("id", actorServiceIds.length > 0 ? actorServiceIds : [nilUuid]);
  }

  // Wrapping in a plain object avoids the JS thenable-chaining gotcha: the Supabase
  // query builder implements .then(), so `await asyncFn()` that returns a builder
  // would silently execute the query instead of returning the builder itself.
  return { query };
}
