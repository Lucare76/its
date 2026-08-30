/**
 * GET /api/ops/piano-giorno?date=YYYY-MM-DD
 * Carica tutti i dati necessari per il Piano del Giorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";
import { isVehicleManuallyBlockedOnDate } from "@/lib/server/vehicle-availability";
import { listDriverRegistry } from "@/lib/server/driver-registry";
import { buildContinentDispatchBuckets, loadContinentDispatchServices } from "@/lib/server/continent-dispatch";
import {
  buildPianoDisplayUnits,
  type PianoBookingGroupLike,
  type PianoBookingGroupStopLike,
  type PianoBusReservationLike,
  type PianoBusUnitLike,
  type PianoGroupAwareService,
} from "@/lib/piano-booking-group-display";

export const runtime = "nodejs";

type FerryScheduleRow = {
  id: string;
  company: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
  direction: string;
  days_of_week: number[] | null;
  valid_from: string | null;
  valid_to: string | null;
  notes: string | null;
};

const BASE_SERVICE_COLUMNS = [
  "id",
  "date",
  "time",
  "time_from",
  "time_to",
  "direction",
  "customer_name",
  "customer_first_name",
  "customer_last_name",
  "pax",
  "hotel_id",
  "vessel",
  "notes",
  "status",
  "meeting_point",
  "place_type",
  "pickup_hotel",
  "booking_service_kind",
  "service_type",
  "phone",
];

const PIANO_OPTIONAL_SERVICE_COLUMNS = [
  "service_type_code",
  "transport_code",
  "orario_barca",
  "porto_bruno",
  "barca_compagnia",
  "ferry_details",
  "excursion_details",
  "tour_name",
  "pickup_time",
  "origin_place_type",
  "destination_place_type",
  "origin_place_id",
  "destination_place_id",
  "arrival_time",
  "departure_time",
  "train_arrival_number",
  "train_arrival_time",
  "train_departure_number",
  "train_departure_time",
  "booking_group_id",
  "booking_group_stop_id",
];

function missingSchemaColumn(message: string) {
  return message.match(/Could not find the '([^']+)' column/)?.[1]
    ?? message.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1]
    ?? message.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1]
    ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const url = new URL(request.url);
    const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

    // Giorno della settimana (0=dom, 1=lun, …) per ferry schedules
    const dow = new Date(date + "T12:00:00Z").getDay();

    // Carica prima i servizi del giorno per filtrare assignments per service_id.
    // Alcune colonne operational_v2 sono opzionali tra ambienti: se la schema cache
    // non le conosce, riproviamo togliendo solo la colonna segnalata.
    let serviceColumns = [...BASE_SERVICE_COLUMNS, ...PIANO_OPTIONAL_SERVICE_COLUMNS];
    let servicesResult: {
      data: Array<Record<string, unknown>> | null;
      error: { message: string } | null;
    } = { data: null, error: null };
    const omittedServiceColumns: string[] = [];
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const result = await auth.admin
        .from("services")
        .select(serviceColumns.join(", "))
        .eq("tenant_id", tenantId)
        .eq("date", date)
        .neq("status", "cancelled")
        .neq("is_draft", true)
        .order("time")
        .limit(2000);
      servicesResult = result as typeof servicesResult;
      if (!result.error) break;
      const missingColumn = missingSchemaColumn(result.error.message);
      if (!missingColumn || !serviceColumns.includes(missingColumn)) break;
      omittedServiceColumns.push(missingColumn);
      serviceColumns = serviceColumns.filter((column) => column !== missingColumn);
    }

    if (servicesResult.error) {
      console.error("[piano-giorno] services query error:", servicesResult.error.message, servicesResult.error);
      return NextResponse.json({ ok: false, error: `services: ${servicesResult.error.message}` }, { status: 500 });
    }

    const dayServiceIds = (servicesResult.data ?? []).map((s) => s.id);

    // FASE 4 — Piano del Giorno group-aware: id dei gruppi prenotazione
    // referenziati dai services del giorno, per il batch IN (...) qui sotto
    // (nessuna query per gruppo: sempre lo stesso numero di round-trip
    // indipendentemente da quanti booking_group_id compaiono).
    const bookingGroupIds = Array.from(
      new Set(
        (servicesResult.data ?? [])
          .map((s) => s.booking_group_id as string | null | undefined)
          .filter((v): v is string => Boolean(v))
      )
    );

    // Step 1: trip_groups del giorno (serve per filtrare assignments per group_id)
    const tripGroupsResult = await auth.admin
      .from("trip_groups")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .eq("status", "active")
      .limit(2000);

    if (tripGroupsResult.error) {
      console.error("[piano-giorno] trip_groups query error:", tripGroupsResult.error.message, tripGroupsResult.error);
      return NextResponse.json({ ok: false, error: `trip_groups: ${tripGroupsResult.error.message}` }, { status: 500 });
    }

    const tripGroups = tripGroupsResult.data ?? [];
    const todayGroupIds = tripGroups.map((g) => g.id as string);

    // Step 2: assignments filtrati per group_id + altri dati in parallelo
    const [
      assignmentsResult,
      hotelsResult,
      membershipsResult,
      vehiclesResult,
      ferryResult,
      commitments,
      driverRegistry,
      continentDispatch,
      bookingGroupsResult,
      bookingGroupStopsResult,
      bookingGroupReservationsResult,
    ] = await Promise.all([
      todayGroupIds.length > 0
        ? auth.admin
            .from("assignments")
            .select("id, service_id, driver_user_id, vehicle_label, group_id")
            .eq("tenant_id", tenantId)
            .in("group_id", todayGroupIds)
            .limit(5000)
        : Promise.resolve({ data: [] as Array<{ id: string; service_id: string; driver_user_id: string | null; vehicle_label: string | null; group_id: string }>, error: null }),

      auth.admin
        .from("hotels")
        .select("id, name, zone, lat, lng, address, geo_status, geo_source, geo_accuracy, geo_verified_at")
        .eq("tenant_id", tenantId),

      auth.admin
        .from("memberships")
        .select("user_id, full_name, role")
        .eq("tenant_id", tenantId)
        .in("role", ["driver", "admin", "operator"]),

      auth.admin
        .from("vehicles")
        .select("id, label, capacity, vehicle_size, active, blocked_from, blocked_until, blocked_reason, is_blocked_manual")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .order("label"),

      auth.admin
        .from("ferry_schedules")
        .select("id, company, departure_port, arrival_port, departure_time, direction, days_of_week, valid_from, valid_to, notes")
        .eq("direction", "mainland_to_ischia")
        .order("departure_time"),
      loadVehicleCommitmentsForDate(auth.admin, tenantId, date),
      listDriverRegistry(auth.admin, tenantId, { activeOnly: true }),
      loadContinentDispatchServices(auth, date),

      // FASE 4 — batch IN (...) sui gruppi referenziati dai services del giorno.
      bookingGroupIds.length > 0
        ? auth.admin
            .from("booking_groups")
            .select("id, name, kind, status, expected_pax, service_date, outbound_ferry_company, outbound_departure_port, outbound_ferry_time, outbound_arrival_port, outbound_expected_arrival_time, return_ferry_company, return_departure_port, return_ferry_time, return_arrival_port, return_expected_arrival_time")
            .eq("tenant_id", tenantId)
            .in("id", bookingGroupIds)
        : Promise.resolve({ data: [] as PianoBookingGroupLike[], error: null }),
      bookingGroupIds.length > 0
        ? auth.admin
            .from("booking_group_stops")
            .select("id, booking_group_id, city, pickup_point, expected_pax, direction, sort_order")
            .eq("tenant_id", tenantId)
            .in("booking_group_id", bookingGroupIds)
        : Promise.resolve({ data: [] as PianoBookingGroupStopLike[], error: null }),
      bookingGroupIds.length > 0
        ? auth.admin
            .from("booking_group_bus_reservations")
            .select("id, booking_group_id, bus_unit_id, service_date, reserved_pax, exclusive")
            .eq("tenant_id", tenantId)
            .eq("service_date", date)
            .in("booking_group_id", bookingGroupIds)
        : Promise.resolve({ data: [] as PianoBusReservationLike[], error: null }),
    ]);

    const errorSources = [
      assignmentsResult.error ? `assignments: ${assignmentsResult.error.message}` : null,
      hotelsResult.error ? `hotels: ${hotelsResult.error.message}` : null,
      membershipsResult.error ? `memberships: ${membershipsResult.error.message}` : null,
      vehiclesResult.error ? `vehicles: ${vehiclesResult.error.message}` : null,
      bookingGroupsResult.error ? `booking_groups: ${bookingGroupsResult.error.message}` : null,
      bookingGroupStopsResult.error ? `booking_group_stops: ${bookingGroupStopsResult.error.message}` : null,
      bookingGroupReservationsResult.error ? `booking_group_bus_reservations: ${bookingGroupReservationsResult.error.message}` : null,
    ].filter(Boolean);

    if (errorSources.length > 0) {
      console.error("[piano-giorno] parallel query errors:", errorSources);
      return NextResponse.json({ ok: false, error: errorSources.join("; ") }, { status: 500 });
    }

    const dayAssignments = assignmentsResult.data ?? [];
    const committedVehicleIds = new Set(commitments.rows.map((row) => row.vehicle_id));
    const availableVehicles = (vehiclesResult.data ?? []).filter((vehicle) => {
      if (committedVehicleIds.has(vehicle.id as string)) return false;
      return !isVehicleManuallyBlockedOnDate(vehicle, date);
    });
    const ferrySchedules = ((ferryResult.data ?? []) as FerryScheduleRow[]).filter((schedule) => {
      if (schedule.valid_from && schedule.valid_from > date) return false;
      if (schedule.valid_to && schedule.valid_to < date) return false;
      if (schedule.days_of_week && schedule.days_of_week.length > 0) {
        return schedule.days_of_week.includes(dow);
      }
      return true;
    });
    const continentDispatchBuckets = buildContinentDispatchBuckets(continentDispatch.services, { date });

    // FASE 4 — bus units riservati per i gruppi del giorno: un solo IN (...)
    // sui bus_unit_id realmente citati dalle reservation, mai una query per gruppo.
    const bookingGroupReservations = (bookingGroupReservationsResult.data ?? []) as PianoBusReservationLike[];
    const busUnitIds = Array.from(new Set(bookingGroupReservations.map((r) => r.bus_unit_id)));
    let busUnits: PianoBusUnitLike[] = [];
    if (busUnitIds.length > 0) {
      const busUnitsResult = await auth.admin
        .from("tenant_bus_units")
        .select("id, label, capacity")
        .eq("tenant_id", tenantId)
        .in("id", busUnitIds);
      if (busUnitsResult.error) {
        console.error("[piano-giorno] tenant_bus_units query error:", busUnitsResult.error.message);
        return NextResponse.json({ ok: false, error: `tenant_bus_units: ${busUnitsResult.error.message}` }, { status: 500 });
      }
      busUnits = (busUnitsResult.data ?? []) as PianoBusUnitLike[];
    }

    const displayUnits = buildPianoDisplayUnits({
      services: (servicesResult.data ?? []) as unknown as PianoGroupAwareService[],
      bookingGroups: (bookingGroupsResult.data ?? []) as PianoBookingGroupLike[],
      stops: (bookingGroupStopsResult.data ?? []) as PianoBookingGroupStopLike[],
      reservations: bookingGroupReservations,
      busUnits,
    });

    return NextResponse.json({
      ok: true,
      date,
      services: servicesResult.data ?? [],
      omitted_service_columns: omittedServiceColumns,
      trip_groups: tripGroups,
      assignments: dayAssignments,
      hotels: hotelsResult.data ?? [],
      memberships: membershipsResult.data ?? [],
      driver_profiles: driverRegistry,
      vehicles: availableVehicles,
      vehicle_commitments: commitments.rows,
      ferry_schedules: ferrySchedules,
      continent_dispatch: continentDispatchBuckets,
      display_units: displayUnits,
    });
  } catch (err) {
    console.error("[piano-giorno] unhandled exception:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
