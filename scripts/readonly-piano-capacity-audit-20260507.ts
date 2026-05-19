import { createClient } from "@supabase/supabase-js";
import { simulateCapacityResolution } from "@/lib/piano-capacity-split-simulation";

const date = "2026-05-07";
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceKey) {
  throw new Error("Missing Supabase env.");
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function norm(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function minuteFromTime(value: unknown) {
  const match = String(value ?? "").match(/(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(value: number | null) {
  if (value == null || !Number.isFinite(value)) return null;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function classifyService(service: {
  direction?: string | null;
  booking_service_kind?: string | null;
  service_type_code?: string | null;
  service_category?: string | null;
  vessel?: string | null;
}) {
  const kind = norm(service.booking_service_kind ?? service.service_type_code ?? service.service_category ?? service.vessel);
  if (kind.includes("NAVETTA") || kind.includes("SHUTTLE")) return "navetta";
  if (kind.includes("EXCURSION") || kind.includes("ESCURSIONE")) return "escursione";
  if (service.direction === "arrival") return "arrivo";
  if (service.direction === "departure") return "partenza";
  return "transfer";
}

function sameValue(values: Array<string | null | undefined>) {
  return new Set(values.map((value) => norm(value))).size <= 1;
}

async function main() {
  const { data: tenants, error: tenantError } = await admin.from("tenants").select("id,name").limit(50);
  if (tenantError) throw tenantError;
  const tenant = (tenants ?? []).find((candidate) => norm(candidate.name).includes("ISCHIA TRANSFER")) ?? tenants?.[0];
  if (!tenant) throw new Error("No tenant found.");
  const tenantId = tenant.id;

  const [
    driversRes,
    driverAvailRes,
    vehiclesRes,
    vehicleAvailRes,
    vehicleBlocksRes,
    groupsRes,
    hotelsRes,
  ] = await Promise.all([
    admin.from("driver_profiles").select("id,user_id,full_name,active").eq("tenant_id", tenantId),
    admin.from("driver_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenantId).order("label"),
    admin.from("vehicle_daily_availability").select("*").eq("tenant_id", tenantId).eq("date", date),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin
      .from("trip_groups")
      .select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .neq("status", "cancelled"),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
  ]);

  for (const [name, result] of Object.entries({ driversRes, driverAvailRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, groupsRes, hotelsRes })) {
    if (result.error) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
  }

  const drivers = driversRes.data ?? [];
  const driverByProfile = new Map(drivers.map((driver) => [driver.id, driver]));
  const driverByUser = new Map(drivers.map((driver) => [driver.user_id, driver]));
  const driverName = (profileId: string | null, userId: string | null) =>
    driverByProfile.get(profileId ?? "")?.full_name ??
    driverByUser.get(userId ?? "")?.full_name ??
    profileId ??
    userId ??
    "SENZA AUTISTA";

  const availableDriverRows = (driverAvailRes.data ?? []).filter((row) => row.available !== false);
  const availableDriverKeys = new Set(availableDriverRows.map((row) => row.driver_profile_id ? `profile:${row.driver_profile_id}` : `user:${row.driver_user_id}`));
  const availableDrivers = availableDriverRows.map((row) => ({
    driver_key: row.driver_profile_id ? `profile:${row.driver_profile_id}` : `user:${row.driver_user_id}`,
    driver_name: driverName(row.driver_profile_id ?? null, row.driver_user_id ?? null),
    driver_profile_id: row.driver_profile_id ?? null,
    driver_user_id: row.driver_user_id ?? null,
  }));

  const vehicleAvailById = new Map((vehicleAvailRes.data ?? []).map((row) => [row.vehicle_id, row]));
  const vehicleBlocks = (vehicleBlocksRes.data ?? []).filter((block) => {
    const singleDate = String(block.date ?? "").slice(0, 10);
    const from = String(block.blocked_from ?? block.block_from ?? "").slice(0, 10);
    const until = String(block.blocked_until ?? "").slice(0, 10);
    if (singleDate) return singleDate === date;
    return Boolean(from && until && from <= date && until >= date);
  });
  const blockedVehicleIds = new Set(vehicleBlocks.map((block) => block.vehicle_id));
  const availableVehicles = (vehiclesRes.data ?? [])
    .filter((vehicle) => vehicle.active !== false && vehicleAvailById.get(vehicle.id)?.available !== false && !blockedVehicleIds.has(vehicle.id))
    .map((vehicle) => ({ id: vehicle.id, label: vehicle.label, capacity: vehicle.capacity }));
  const vehicleByLabel = new Map((vehiclesRes.data ?? []).map((vehicle) => [norm(vehicle.label), vehicle]));
  const hotelById = new Map((hotelsRes.data ?? []).map((hotel) => [hotel.id, hotel]));

  const groups = groupsRes.data ?? [];
  const groupIds = groups.map((group) => group.id);
  const assignmentsRes = groupIds.length
    ? await admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenantId).in("group_id", groupIds)
    : { data: [], error: null };
  if (assignmentsRes.error) throw assignmentsRes.error;

  const serviceIds = [...new Set((assignmentsRes.data ?? []).map((assignment) => assignment.service_id).filter(Boolean))];
  const servicesRes = serviceIds.length
    ? await admin
      .from("services")
      .select("id,date,time,pickup_hotel,pax,direction,status,customer_name,hotel_id,meeting_point,booking_service_kind,service_type_code,service_category,vessel,origin_label_raw,destination_label_raw")
      .eq("tenant_id", tenantId)
      .in("id", serviceIds)
    : { data: [], error: null };
  if (servicesRes.error) throw servicesRes.error;

  const servicesById = new Map((servicesRes.data ?? []).map((service) => [service.id, service]));
  const assignmentsByGroup = new Map<string, NonNullable<typeof assignmentsRes.data>>();
  for (const assignment of assignmentsRes.data ?? []) {
    const list = assignmentsByGroup.get(assignment.group_id ?? "") ?? [];
    list.push(assignment);
    assignmentsByGroup.set(assignment.group_id ?? "", list);
  }

  const stats = new Map<string, {
    driver_key: string;
    driver_name: string;
    vehicles: Map<string, number>;
    groupCount: number;
    maxPax: number;
    maxGroupServices: number;
    criticalGroups: string[];
    currentCapacity: number | null;
  }>();
  const criticalGroups = [];

  for (const group of groups) {
    const driverKey = group.driver_profile_id ? `profile:${group.driver_profile_id}` : `user:${group.driver_user_id}`;
    if (!availableDriverKeys.has(driverKey)) continue;
    const assignments = assignmentsByGroup.get(group.id) ?? [];
    const services = assignments.map((assignment) => servicesById.get(assignment.service_id)).filter(Boolean);
    const pax = services.reduce((sum, service) => sum + (Number(service?.pax) || 0), 0);
    const times = services.map((service) => minuteFromTime(service?.pickup_hotel ?? service?.time)).filter((value): value is number => value != null);
    const start = times.length ? Math.min(...times) : null;
    const end = times.length ? Math.max(...times) + 30 : null;
    const vehicleLabel = group.vehicle_label ?? assignments.map((assignment) => assignment.vehicle_label).find(Boolean) ?? null;
    const vehicle = vehicleLabel ? vehicleByLabel.get(norm(vehicleLabel)) : null;
    const capacity = group.vehicle_capacity ?? vehicle?.capacity ?? null;
    const name = driverName(group.driver_profile_id, group.driver_user_id);
    const stat = stats.get(driverKey) ?? {
      driver_key: driverKey,
      driver_name: name,
      vehicles: new Map<string, number>(),
      groupCount: 0,
      maxPax: 0,
      maxGroupServices: 0,
      criticalGroups: [],
      currentCapacity: capacity,
    };
    stat.groupCount += 1;
    stat.maxPax = Math.max(stat.maxPax, pax);
    stat.maxGroupServices = Math.max(stat.maxGroupServices, services.length);
    stat.currentCapacity = stat.currentCapacity ?? capacity;
    if (vehicleLabel) stat.vehicles.set(vehicleLabel, (stat.vehicles.get(vehicleLabel) ?? 0) + 1);
    if (pax >= 21) stat.criticalGroups.push(group.id);
    stats.set(driverKey, stat);

    if (pax >= 21) {
      const serviceRows = services.map((service) => {
        const hotel = service?.hotel_id ? hotelById.get(service.hotel_id) : null;
        const pickup = service?.direction === "departure"
          ? hotel?.name ?? service?.origin_label_raw ?? service?.meeting_point ?? null
          : service?.meeting_point ?? service?.origin_label_raw ?? null;
        const destination = service?.direction === "departure"
          ? service?.meeting_point ?? service?.destination_label_raw ?? null
          : hotel?.name ?? service?.destination_label_raw ?? null;
        return {
          service_id: service?.id ?? "",
          customer_name: service?.customer_name ?? null,
          pax: Number(service?.pax) || 0,
          direction: service?.direction ?? null,
          booking_service_kind: service?.booking_service_kind ?? null,
          type: classifyService(service ?? {}),
          operational_time: hhmm(minuteFromTime(service?.pickup_hotel ?? service?.time)),
          pickup_label: pickup,
          destination_label: destination,
          destination_zone: hotel?.zone ?? null,
        };
      });
      const groupType = new Set(serviceRows.map((service) => service.type)).size === 1 ? serviceRows[0]?.type ?? "transfer" : "mixed";
      const sameStop = serviceRows.length > 1 &&
        sameValue(serviceRows.map((service) => service.operational_time)) &&
        sameValue(serviceRows.map((service) => service.pickup_label)) &&
        sameValue(serviceRows.map((service) => service.destination_label)) &&
        sameValue(serviceRows.map((service) => service.direction));
      criticalGroups.push({
        group_id: group.id,
        driver_key: driverKey,
        driver_name: name,
        start: hhmm(start),
        end: hhmm(end),
        current_vehicle_label: vehicleLabel,
        current_vehicle_capacity: capacity,
        pax,
        services_count: serviceRows.length,
        type: sameStop ? "same-stop" : groupType,
        split_possible: serviceRows.length > 1 && !sameStop,
        split_note: serviceRows.length <= 1 ? "Singolo servizio: non splittare automaticamente." : sameStop ? "Same-stop: split richiede override operatore." : "Servizi distinti: split simulabile read-only.",
        services: serviceRows,
      });
    }
  }

  const statRows = [...stats.values()].sort((a, b) => a.driver_name.localeCompare(b.driver_name));
  const simulation = simulateCapacityResolution({
    vehicles: availableVehicles,
    drivers: statRows.map((stat) => ({
      driver_key: stat.driver_key,
      driver_name: stat.driver_name,
      current_vehicle_labels: [...stat.vehicles.keys()],
      max_pax: stat.maxPax,
      group_count: stat.groupCount,
    })),
    criticalGroups: criticalGroups.map((group) => ({
      group_id: group.group_id,
      driver_key: group.driver_key,
      driver_name: group.driver_name,
      current_vehicle_label: group.current_vehicle_label,
      current_vehicle_capacity: group.current_vehicle_capacity,
      pax: group.pax,
      start_time: group.start,
      services: group.services,
    })),
  });

  console.log(JSON.stringify({
    projectRef: supabaseUrl.match(/https:\/\/([^.]+)/)?.[1] ?? null,
    tenant: { id: tenantId, name: tenant.name ?? null },
    date,
    availableDrivers,
    availableVehicles,
    vehicleBlocks,
    groupCount: groups.length,
    assignmentCount: (assignmentsRes.data ?? []).length,
    driverCapacity: statRows.map((stat) => {
      const currentVehicle = [...stat.vehicles.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const currentCapacity = currentVehicle ? vehicleByLabel.get(norm(currentVehicle))?.capacity ?? null : null;
      return {
        driver: stat.driver_name,
        pax_max_giro: stat.maxPax,
        mezzo_attuale: currentVehicle,
        capienza: currentCapacity,
        compatibile: currentCapacity != null && currentCapacity >= stat.maxPax,
        giri: stat.groupCount,
        giri_critici: stat.criticalGroups,
      };
    }),
    criticalGroups,
    simulation,
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exit(1);
});
