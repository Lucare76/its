import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchRadiusAllPositions } from "@/lib/server/radius-adapter";
import { reverseGeocodeCoordinates } from "@/lib/server/geocoding";
import type { GpsControlRoomEntry, GpsVehiclePosition, ServiceStatus } from "@/lib/types";

export const runtime = "nodejs";

type VehicleRow = {
  id: string;
  label: string;
  plate: string | null;
  default_zone: string | null;
  blocked_until: string | null;
  blocked_reason: string | null;
  is_blocked_manual: boolean | null;
  radius_vehicle_id: string | null;
  habitual_driver_user_id: string | null;
};

type MembershipRow = {
  user_id: string;
  full_name: string;
  role: string;
};

type AssignmentRow = {
  service_id: string;
  driver_user_id: string | null;
  vehicle_label: string;
};

type HotelRow = {
  id: string;
  name: string;
};

type ServiceRow = {
  id: string;
  customer_name: string;
  date: string;
  time: string;
  status: ServiceStatus;
  hotel_id: string | null;
  service_type_code: string | null;
  booking_service_kind: string | null;
  bus_plate: string | null;
  billing_party_name: string | null;
};

type AnomalyRow = {
  id: string;
  vehicle_id: string;
  severity: "low" | "medium" | "high" | "blocking";
  active: boolean;
};

type SupabaseLikeResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

const ACTIVE_SERVICE_STATUSES: ServiceStatus[] = ["assigned", "partito", "arrivato"];
const OFFLINE_AFTER_SECONDS = 8 * 60;
const STOPPED_AFTER_SECONDS = 5 * 60;

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function deriveLineName(service: Pick<ServiceRow, "service_type_code" | "booking_service_kind" | "billing_party_name">) {
  if (service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel") return "Linea bus";
  if (service.service_type_code === "transfer_airport_hotel" || service.booking_service_kind === "transfer_airport_hotel") return "Aeroporto";
  if (service.service_type_code === "transfer_station_hotel" || service.booking_service_kind === "transfer_train_hotel") return "Stazione";
  if (service.service_type_code === "transfer_port_hotel" || service.booking_service_kind === "transfer_port_hotel") return "Porto";
  return service.billing_party_name?.trim() || null;
}

function findMatchingVehicle(service: ServiceRow, assignment: AssignmentRow | undefined, vehicles: VehicleRow[]) {
  const busPlate = normalizeText(service.bus_plate);
  const assignmentLabel = normalizeText(assignment?.vehicle_label);
  if (busPlate) {
    const byPlate = vehicles.find((vehicle) => normalizeText(vehicle.plate) === busPlate);
    if (byPlate) return byPlate;
  }
  if (assignmentLabel) {
    const byLabel = vehicles.find((vehicle) => normalizeText(vehicle.label) === assignmentLabel);
    if (byLabel) return byLabel;
    const fuzzy = vehicles.find((vehicle) => {
      const label = normalizeText(vehicle.label);
      const plate = normalizeText(vehicle.plate);
      return Boolean(label && (label.includes(assignmentLabel) || assignmentLabel.includes(label) || (plate && assignmentLabel.includes(plate))));
    });
    if (fuzzy) return fuzzy;
  }
  return null;
}

function compareServicePriority(left: ServiceRow, right: ServiceRow) {
  if (left.date !== right.date) return right.date.localeCompare(left.date);
  return right.time.localeCompare(left.time);
}

function deriveStatus(position: GpsVehiclePosition) {
  const lastUpdateSeconds = Math.max(0, Math.floor((Date.now() - new Date(position.timestamp).getTime()) / 1000));
  const speed = typeof position.speed_kmh === "number" && Number.isFinite(position.speed_kmh) ? position.speed_kmh : null;

  if (!position.online || lastUpdateSeconds > OFFLINE_AFTER_SECONDS) return { key: "offline" as const, label: "Offline", icon: "●" };
  if (speed !== null && speed > 5) return { key: "moving" as const, label: "In movimento", icon: "●" };
  if (speed !== null && speed > 0) return { key: "warning" as const, label: "Lento / warning", icon: "●" };
  if (speed === 0 && lastUpdateSeconds >= STOPPED_AFTER_SECONDS) return { key: "stopped" as const, label: "Fermo", icon: "●" };
  return { key: "warning" as const, label: "Attenzione", icon: "●" };
}

function tolerateFailure<T>(result: SupabaseLikeResult<T>) {
  return result.error ? { data: [] as T[], error: null } : result;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    if (!process.env.RADIUS_REFRESH_TOKEN) {
      return NextResponse.json({ ok: false, error: "GPS Radius non configurato (RADIUS_REFRESH_TOKEN mancante)." }, { status: 503 });
    }

    const tenantId = auth.membership.tenant_id;
    const today = new Date().toISOString().slice(0, 10);

    const [positions, vehiclesResult, membershipsResult, anomaliesResult, assignmentsResult, servicesResult, hotelsResult] = await Promise.all([
      fetchRadiusAllPositions(),
      auth.admin
        .from("vehicles")
        .select("id, label, plate, default_zone, blocked_until, blocked_reason, is_blocked_manual, radius_vehicle_id, habitual_driver_user_id")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .then((result: SupabaseLikeResult<VehicleRow>) => tolerateFailure<VehicleRow>(result)),
      auth.admin
        .from("memberships")
        .select("user_id, full_name, role")
        .eq("tenant_id", tenantId)
        .then((result: SupabaseLikeResult<MembershipRow>) => tolerateFailure<MembershipRow>(result)),
      auth.admin
        .from("vehicle_anomalies")
        .select("id, vehicle_id, severity, active")
        .eq("tenant_id", tenantId)
        .eq("active", true)
        .then((result: SupabaseLikeResult<AnomalyRow>) => tolerateFailure<AnomalyRow>(result)),
      auth.admin
        .from("assignments")
        .select("service_id, driver_user_id, vehicle_label")
        .eq("tenant_id", tenantId)
        .then((result: SupabaseLikeResult<AssignmentRow>) => tolerateFailure<AssignmentRow>(result)),
      auth.admin
        .from("services")
        .select("id, customer_name, date, time, status, hotel_id, service_type_code, booking_service_kind, bus_plate, billing_party_name")
        .eq("tenant_id", tenantId)
        .in("status", ACTIVE_SERVICE_STATUSES)
        .gte("date", today)
        .then((result: SupabaseLikeResult<ServiceRow>) => tolerateFailure<ServiceRow>(result)),
      auth.admin
        .from("hotels")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .then((result: SupabaseLikeResult<HotelRow>) => tolerateFailure<HotelRow>(result))
    ]);

    const vehicles = (vehiclesResult.data ?? []) as VehicleRow[];
    const memberships = (membershipsResult.data ?? []) as MembershipRow[];
    const anomalies = (anomaliesResult.data ?? []) as AnomalyRow[];
    const assignments = (assignmentsResult.data ?? []) as AssignmentRow[];
    const services = ((servicesResult.data ?? []) as ServiceRow[]).sort(compareServicePriority);
    const hotels = (hotelsResult.data ?? []) as HotelRow[];

    const membershipByUserId = new Map(memberships.map((member) => [member.user_id, member.full_name]));
    const hotelById = new Map(hotels.map((hotel) => [hotel.id, hotel.name]));
    const assignmentByServiceId = new Map(assignments.map((assignment) => [assignment.service_id, assignment]));

    const anomaliesByVehicleId = new Map<string, { count: number; highest: "low" | "medium" | "high" | "blocking" | null }>();
    for (const anomaly of anomalies) {
      const current = anomaliesByVehicleId.get(anomaly.vehicle_id) ?? { count: 0, highest: null };
      const severityRank = { low: 1, medium: 2, high: 3, blocking: 4 };
      const nextHighest =
        current.highest === null || severityRank[anomaly.severity] > severityRank[current.highest] ? anomaly.severity : current.highest;
      anomaliesByVehicleId.set(anomaly.vehicle_id, { count: current.count + 1, highest: nextHighest });
    }

    const activeServiceByVehicleId = new Map<string, { service: ServiceRow; assignment?: AssignmentRow }>();
    for (const service of services) {
      const assignment = assignmentByServiceId.get(service.id);
      const vehicle = findMatchingVehicle(service, assignment, vehicles);
      if (vehicle && !activeServiceByVehicleId.has(vehicle.id)) {
        activeServiceByVehicleId.set(vehicle.id, { service, assignment });
      }
    }

    type MappedVehicle = VehicleRow & { radius_vehicle_id: string };
    const pmsByRadiusId = new Map<string, MappedVehicle>(
      vehicles
        .filter((vehicle): vehicle is MappedVehicle => typeof vehicle.radius_vehicle_id === "string" && vehicle.radius_vehicle_id.trim().length > 0)
        .map((vehicle) => [vehicle.radius_vehicle_id, vehicle])
    );

    const uniqueCoordinateKeys = Array.from(new Set(positions.map((position) => `${position.lat.toFixed(4)},${position.lng.toFixed(4)}`)));
    const reverseGeoEntries = await Promise.all(
      uniqueCoordinateKeys.map(async (key) => {
        const [latRaw, lngRaw] = key.split(",");
        const lat = Number(latRaw);
        const lng = Number(lngRaw);
        const value = Number.isFinite(lat) && Number.isFinite(lng) ? await reverseGeocodeCoordinates(lat, lng) : null;
        return [key, value] as const;
      })
    );
    const reverseGeoByKey = new Map(reverseGeoEntries);

    const entries: GpsControlRoomEntry[] = positions.map((position) => {
      const pmsVehicle = pmsByRadiusId.get(position.radius_vehicle_id) ?? null;
      const binding = pmsVehicle ? activeServiceByVehicleId.get(pmsVehicle.id) ?? null : null;
      const activeService = binding?.service ?? null;
      const assignedDriverName = binding?.assignment?.driver_user_id ? membershipByUserId.get(binding.assignment.driver_user_id) ?? null : null;
      const habitualDriverName = pmsVehicle?.habitual_driver_user_id ? membershipByUserId.get(pmsVehicle.habitual_driver_user_id) ?? null : null;
      const status = deriveStatus(position);
      const vehicleAnomalies = pmsVehicle ? anomaliesByVehicleId.get(pmsVehicle.id) ?? { count: 0, highest: null } : { count: 0, highest: null };
      const reverseGeo = reverseGeoByKey.get(`${position.lat.toFixed(4)},${position.lng.toFixed(4)}`) ?? null;

      return {
        ...position,
        pms_vehicle_id: pmsVehicle?.id ?? null,
        pms_label: pmsVehicle?.label ?? null,
        plate: pmsVehicle?.plate ?? null,
        default_zone: pmsVehicle?.default_zone ?? null,
        current_address: reverseGeo?.address ?? null,
        current_city: reverseGeo?.city ?? null,
        line_name: position.line_name ?? (activeService ? deriveLineName(activeService) : null),
        driver_name: assignedDriverName ?? habitualDriverName ?? position.driver_name ?? null,
        status_key: status.key,
        status_label: status.label,
        status_icon: status.icon,
        last_update_seconds: Math.max(0, Math.floor((Date.now() - new Date(position.timestamp).getTime()) / 1000)),
        blocked:
          Boolean(pmsVehicle?.is_blocked_manual) ||
          Boolean(pmsVehicle?.blocked_until && new Date(pmsVehicle.blocked_until).getTime() > Date.now()) ||
          vehicleAnomalies.highest === "blocking",
        blocked_reason: pmsVehicle?.blocked_reason ?? null,
        anomalies_count: vehicleAnomalies.count,
        anomaly_severity: vehicleAnomalies.highest,
        active_service: activeService
          ? {
              id: activeService.id,
              customer_name: activeService.customer_name,
              date: activeService.date,
              time: activeService.time,
              status: activeService.status,
              line_name: deriveLineName(activeService),
              hotel_name: activeService.hotel_id ? hotelById.get(activeService.hotel_id) ?? null : null
            }
          : null
      };
    });

    const summary = entries.reduce(
      (acc, entry) => {
        acc.total += 1;
        if (entry.status_key === "moving") acc.moving += 1;
        if (entry.status_key === "stopped") acc.stopped += 1;
        if (entry.status_key === "warning") acc.warning += 1;
        if (entry.status_key === "offline") acc.offline += 1;
        if (entry.blocked) acc.blocked += 1;
        return acc;
      },
      { total: 0, moving: 0, stopped: 0, warning: 0, offline: 0, blocked: 0 }
    );

    return NextResponse.json({ ok: true, entries, summary, fetched_at: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore interno server." }, { status: 500 });
  }
}
