/**
 * Verifica FASE 2: replica la logica della route global-planner-preview
 * su date=2026-05-07 SENZA duration config hardcoded.
 * Confronta i numeri con la regressione FASE 1.
 *
 * FASE 1 attesi (backtracking depth=3, window=75, CON route-duration config):
 *   total_units: ?   assigned_units = total_units, needs_review = 0,
 *   total_conflicts = 0, driver_conflicts = 0, vehicle_conflicts = 0,
 *   eligibility_blockers = 0, availability_blockers = 0, overbooking = 0
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { canDriverCoverInterval } from "@/lib/piano-driver-availability";
import { canDriverUseVehicle } from "@/lib/piano-driver-vehicle-eligibility";
import { resolveAssignableService } from "@/lib/piano-assignable-service";
import { detectExcursionRoundtripClusters } from "@/lib/piano-excursion-roundtrip-cluster";
import {
  assignGlobalPlanner,
  type GlobalPlannerDriver,
  type GlobalPlannerVehicle,
  type GlobalPlannerUnit,
  type GlobalPlannerAssignment,
} from "@/lib/piano-global-planner";
import { calculateOperationalDuration, isOperationalShuttleLike, type OperationalDurationResult } from "@/lib/piano-operational-duration";
import { mergeSameStops, type ResolvedServiceForSameStop } from "@/lib/piano-same-stop-merge";
import { listDriverRegistry, type DriverRegistryEntry } from "@/lib/server/driver-registry";
import { loadConfirmedOperatorDecisions } from "@/lib/server/piano-operator-decisions";
import type { PricingAuthContext } from "@/lib/server/pricing-auth";

const DATE = "2026-05-07";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        process.env[t.slice(0, i).trim()] ??= t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    } catch { /* optional */ }
  }
}

type GroupRow = { id: string; date: string; driver_user_id: string | null; driver_profile_id: string | null; vehicle_label: string | null; vehicle_capacity: number | null; status: string | null };
type AssignmentRow = { id: string; service_id: string; group_id: string | null; driver_user_id: string | null; driver_profile_id: string | null; vehicle_label: string | null };
type ServiceRow = { id: string; time?: string | null; time_from?: string | null; time_to?: string | null; direction?: string | null; customer_name?: string | null; pax?: number | null; hotel_id?: string | null; vessel?: string | null; notes?: string | null; status?: string | null; meeting_point?: string | null; place_type?: string | null; pickup_hotel?: string | null; booking_service_kind?: string | null; service_type?: string | null; service_type_code?: string | null; transport_code?: string | null; ferry_details?: Record<string, unknown> | null; excursion_details?: Record<string, unknown> | null; tour_name?: string | null; pickup_time?: string | null; arrival_time?: string | null; departure_time?: string | null; origin_place_type?: string | null; destination_place_type?: string | null; route_kind?: string | null; origin_place_id?: string | null; destination_place_id?: string | null };
type VehicleRow = { id: string; label: string | null; capacity: number | null; active: boolean | null };
type AvailabilityRow = { driver_profile_id: string | null; driver_user_id: string | null; available: boolean | null; available_from: string | null; available_to: string | null };
type HotelRow = { id: string; name: string | null; zone: string | null };
type UnitType = "giro_singolo" | "same_stop" | "multi_drop_confirmed" | "accorpamento_confirmed" | "shuttle_pair" | "cluster_escursione_roundtrip" | "navetta_speciale";
type RouteUnit = GlobalPlannerUnit & { type: UnitType; group_ids: string[]; service_ids: string[]; current_driver_name: string | null; current_vehicle_capacity: number | null; duration_minutes: number; duration_reason: string; duration_source: OperationalDurationResult["source"] | "fallback"; duration_warnings: string[]; pickup: string | null; destinations: string[]; needs_review: boolean };
type ProposedUnit = GlobalPlannerAssignment<RouteUnit>;

function norm(v: unknown) { return String(v ?? "").replace(/\s+/g, " ").trim().toUpperCase(); }
function minutes(v: unknown) { const m = String(v ?? "").match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function hhmm(v: number | null) { if (v == null) return null; return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; }
function groupDriverKey(g: Pick<GroupRow, "driver_profile_id" | "driver_user_id">) { return g.driver_profile_id ? `profile:${g.driver_profile_id}` : g.driver_user_id ? `user:${g.driver_user_id}` : null; }
function driverKey(d: Pick<DriverRegistryEntry, "id" | "user_id">) { return d.id ? `profile:${d.id}` : d.user_id ? `user:${d.user_id}` : null; }
function driverNameForGroup(g: GroupRow, drivers: DriverRegistryEntry[]) { if (g.driver_profile_id) return drivers.find((d) => d.id === g.driver_profile_id)?.full_name ?? null; if (g.driver_user_id) return drivers.find((d) => d.user_id === g.driver_user_id)?.full_name ?? null; return null; }
function availabilityFor(driver: DriverRegistryEntry, av: AvailabilityRow[]) { const row = av.find((a) => a.driver_profile_id === driver.id) ?? (driver.user_id ? av.find((a) => a.driver_user_id === driver.user_id) : null) ?? null; return row ? { available: row.available, available_from: row.available_from, available_to: row.available_to, blocks: [] } : null; }
function vehicleBlockedOnDate(b: Record<string, unknown>, date: string) { const d = String(b.date ?? "").slice(0, 10); if (d) return d === date; const from = String(b.blocked_from ?? b.block_from ?? "").slice(0, 10); const until = String(b.blocked_until ?? b.block_to ?? "").slice(0, 10); return Boolean(from && until && from <= date && until >= date); }
function unitDurationMinutes(u: Pick<RouteUnit, "start" | "end">) { const s = minutes(u.start); const e = minutes(u.end); return s == null || e == null ? 30 : Math.max(1, e - s); }
function overlapsWithBuffer(a: Pick<RouteUnit, "start" | "end" | "buffer_minutes">, b: Pick<RouteUnit, "start" | "end" | "buffer_minutes">) { const as = minutes(a.start); const ae = minutes(a.end); const bs = minutes(b.start); const be = minutes(b.end); if (as == null || ae == null || bs == null || be == null) return true; const buf = Math.min(a.buffer_minutes ?? 5, b.buffer_minutes ?? 5); return as < be + buf && ae + buf > bs; }

function buildDurationWarnings(dur: OperationalDurationResult): string[] {
  const warnings = [...dur.warnings];
  if (dur.source !== "route_duration_config") {
    warnings.push(`Nessuna route-duration config: durata stimata ${dur.duration_minutes} min da default (${dur.reason}).`);
  }
  return warnings;
}

function serviceStops(args: { services: ServiceRow[]; hotels: HotelRow[] }): ResolvedServiceForSameStop[] {
  const hotelById = new Map(args.hotels.map((h) => [h.id, h]));
  return args.services.map((service) => {
    const r = resolveAssignableService(service, { hotel: service.hotel_id ? hotelById.get(service.hotel_id) ?? null : null });
    return { service_id: service.id, customer_name: service.customer_name ?? null, macro_category: r.macro_category, assignable: r.assignable, needs_review: r.needs_review, review_reasons: r.review_reasons, operational_time: r.operational_time, pickup_label: r.pickup_label, pickup_zone: r.pickup_zone, destination_label: r.destination_label, destination_zone: r.destination_zone, pax: r.pax, booking_service_kind: r.booking_service_kind, service_type_code: r.service_type_code, route_kind: service.route_kind ?? null, origin_place_id: service.origin_place_id ?? null, destination_place_id: service.destination_place_id ?? null } satisfies ResolvedServiceForSameStop;
  });
}

function unitTypeFromStops(stops: ResolvedServiceForSameStop[], confirmedActions: Set<string>): UnitType {
  if (confirmedActions.has("MULTI_DROP")) return "multi_drop_confirmed";
  if (confirmedActions.has("ACCORPARE_CON_CONFERMA")) return "accorpamento_confirmed";
  if (isOperationalShuttleLike(stops)) { const times = stops.map((s) => minutes(s.operational_time)).filter((v): v is number => v != null); const span = times.length ? Math.max(...times) - Math.min(...times) : 0; return stops.length > 1 && span <= 10 ? "shuttle_pair" : "navetta_speciale"; }
  const merged = mergeSameStops(stops.filter((s) => s.assignable && !s.needs_review));
  if (merged.some((s) => s.is_merged)) return "same_stop";
  return "giro_singolo";
}

function makeUnit(args: { id: string; groupIds: string[]; services: ServiceRow[]; stops: ResolvedServiceForSameStop[]; type: UnitType; group: GroupRow | null; drivers: DriverRegistryEntry[]; vehiclesByLabel: Map<string, VehicleRow>; confirmedActions: Set<string> }): RouteUnit {
  const times = args.stops.map((s) => minutes(s.operational_time)).filter((v): v is number => v != null);
  const startMin = times.length ? Math.min(...times) : null;
  const pax = args.stops.reduce((sum, s) => sum + (Number(s.pax) || 0), 0);
  // NO route-duration config — identical to what the route does
  const dur = calculateOperationalDuration({ type: args.type, stops: args.stops, defaultDurationMinutes: 30, defaultBufferMinutes: 5, pax });
  const endMin = startMin != null ? startMin + dur.duration_minutes : null;
  const currentVehicle = args.group?.vehicle_label ? args.vehiclesByLabel.get(norm(args.group.vehicle_label)) ?? null : null;
  const customers = [...new Set(args.services.map((s) => String(s.customer_name ?? "").replace(/\s+/g, " ").trim()).filter(Boolean))];
  const uniqueDestinations = [...new Set(args.stops.map((s) => s.destination_label).filter((d): d is string => Boolean(d)))];
  return { id: args.id, type: args.type, label: customers.length ? customers.join(" / ") : args.type, group_ids: args.groupIds, service_ids: args.services.map((s) => s.id).sort(), start: hhmm(startMin), end: hhmm(endMin), pax, nonsplittable: true, min_vehicle_capacity: pax, buffer_minutes: dur.buffer_minutes, current_driver_key: args.group ? groupDriverKey(args.group) : null, current_driver_name: args.group ? driverNameForGroup(args.group, args.drivers) : null, current_vehicle_label: args.group?.vehicle_label ?? null, current_vehicle_capacity: args.group?.vehicle_capacity ?? currentVehicle?.capacity ?? null, duration_minutes: dur.duration_minutes, duration_reason: dur.reason, duration_source: dur.source === "route_duration_config" ? "route_duration_config" : "fallback", duration_warnings: buildDurationWarnings(dur), pickup: args.stops[0]?.pickup_label ?? null, destinations: uniqueDestinations, needs_review: args.stops.some((s) => s.needs_review || !s.assignable), locked: args.confirmedActions.size > 0 || args.type === "cluster_escursione_roundtrip", protected_from_backtracking: args.type === "cluster_escursione_roundtrip" || pax >= 21, dense_shuttle: isOperationalShuttleLike(args.stops) };
}

function splitDenseShuttleUnits(args: { group: GroupRow; groupServices: ServiceRow[]; stops: ResolvedServiceForSameStop[]; type: UnitType; drivers: DriverRegistryEntry[]; vehiclesByLabel: Map<string, VehicleRow>; confirmedActions: Set<string> }): RouteUnit[] | null {
  if (args.type !== "navetta_speciale" || args.confirmedActions.size > 0) return null;
  if (args.stops.length <= 1 || !args.stops.every((s) => isOperationalShuttleLike([s]))) return null;
  const ordered = args.stops.map((stop, i) => ({ stop, service: args.groupServices[i] })).filter((x): x is { stop: ResolvedServiceForSameStop; service: ServiceRow } => Boolean(x.service)).sort((a, b) => (minutes(a.stop.operational_time) ?? 9999) - (minutes(b.stop.operational_time) ?? 9999));
  if (ordered.length <= 1) return null;
  const span = (minutes(ordered[ordered.length - 1]!.stop.operational_time) ?? 0) - (minutes(ordered[0]!.stop.operational_time) ?? 0);
  if (span <= 15) return null;
  return ordered.map((item, i) => makeUnit({ id: `${args.group.id}:navetta-cycle:${i + 1}`, groupIds: [args.group.id], services: [item.service], stops: [item.stop], type: "navetta_speciale", group: args.group, drivers: args.drivers, vehiclesByLabel: args.vehiclesByLabel, confirmedActions: args.confirmedActions }));
}

async function loadServices(admin: ReturnType<typeof createClient>, tenantId: string, ids: string[]): Promise<ServiceRow[]> {
  if (ids.length === 0) return [];
  let columns = ["id","time","time_from","time_to","direction","customer_name","pax","hotel_id","vessel","notes","status","meeting_point","place_type","pickup_hotel","booking_service_kind","service_type","service_type_code","transport_code","ferry_details","excursion_details","tour_name","pickup_time","arrival_time","departure_time","origin_place_type","destination_place_type","route_kind","origin_place_id","destination_place_id","origin_label_raw","destination_label_raw"];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const r = await admin.from("services").select(columns.join(",")).eq("tenant_id", tenantId).in("id", ids);
    if (!r.error) return (r.data ?? []) as ServiceRow[];
    const msg = r.error.message;
    const missing = msg.match(/Could not find the '([^']+)' column/)?.[1] ?? msg.match(/column (?:public\.)?services\.([a-zA-Z0-9_]+) does not exist/)?.[1] ?? msg.match(/column "([a-zA-Z0-9_]+)" does not exist/)?.[1] ?? null;
    if (!missing || !columns.includes(missing)) throw r.error;
    columns = columns.filter((c) => c !== missing);
  }
  throw new Error("Service loading failed.");
}

function diagnostics(plan: ProposedUnit[], drivers: DriverRegistryEntry[], vehicles: VehicleRow[], av: AvailabilityRow[]) {
  const driverByKey = new Map(drivers.map((d) => [driverKey(d), d]));
  const vehicleByLabel = new Map(vehicles.map((v) => [norm(v.label), v]));
  let dc = 0, vc = 0, el = 0, avb = 0, ob = 0;
  const assigned = plan.filter((u) => u.assigned);
  for (let i = 0; i < assigned.length; i += 1) {
    const left = assigned[i]!;
    const driver = left.proposed_driver_key ? driverByKey.get(left.proposed_driver_key) ?? null : null;
    const vehicle = left.proposed_vehicle_label ? vehicleByLabel.get(norm(left.proposed_vehicle_label)) ?? null : null;
    if (!driver || !vehicle || !canDriverUseVehicle(driver, vehicle, { blockUnknownVehicleCapacity: true }).allowed) el += 1;
    if (vehicle && left.pax > (vehicle.capacity ?? 0)) ob += 1;
    if (driver && !canDriverCoverInterval(availabilityFor(driver, av), { start_time: left.start, end_time: left.end }, { missingAvailability: "blocker", missingBounds: "warning", defaultDurationMinutes: unitDurationMinutes(left) }).allowed) avb += 1;
    for (let j = i + 1; j < assigned.length; j += 1) {
      const right = assigned[j]!;
      if (!overlapsWithBuffer(left, right)) continue;
      if (left.proposed_driver_key && left.proposed_driver_key === right.proposed_driver_key) dc += 1;
      if (norm(left.proposed_vehicle_label) && norm(left.proposed_vehicle_label) === norm(right.proposed_vehicle_label)) vc += 1;
    }
  }
  return { total_conflicts: dc + vc + plan.filter((u) => !u.assigned).length, driver_conflicts: dc, vehicle_conflicts: vc, eligibility_blockers: el, availability_blockers: avb, overbooking: ob, needs_review: plan.filter((u) => u.needs_review || !u.assigned).length };
}

async function main() {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing Supabase env.");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Resolve tenant
  const { data: tenants, error: tenantError } = await admin.from("tenants").select("id,name").limit(50);
  if (tenantError) throw tenantError;
  const tenant = (tenants ?? []).find((t) => norm(t.name).includes("ISCHIA TRANSFER")) ?? tenants?.[0];
  if (!tenant?.id) throw new Error("Tenant non trovato.");
  const tenantId = tenant.id as string;

  const auth = { admin, user: { id: "readonly-gp-preview-verify", email: null }, membership: { tenant_id: tenantId, role: "admin", suspended: false } } satisfies PricingAuthContext;

  const [driversAll, hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes, decisions] = await Promise.all([
    listDriverRegistry(admin, tenantId, { activeOnly: true }),
    admin.from("hotels").select("id,name,zone").eq("tenant_id", tenantId),
    admin.from("trip_groups").select("id,date,driver_user_id,driver_profile_id,vehicle_label,vehicle_capacity,status").eq("tenant_id", tenantId).eq("date", DATE).eq("status", "active"),
    admin.from("assignments").select("id,service_id,group_id,driver_user_id,driver_profile_id,vehicle_label").eq("tenant_id", tenantId),
    admin.from("vehicles").select("id,label,capacity,active").eq("tenant_id", tenantId).order("label"),
    admin.from("vehicle_daily_availability").select("vehicle_id,available").eq("tenant_id", tenantId).eq("date", DATE),
    admin.from("vehicle_time_blocks").select("*").eq("tenant_id", tenantId),
    admin.from("driver_daily_availability").select("driver_profile_id,driver_user_id,available,available_from,available_to").eq("tenant_id", tenantId).eq("date", DATE),
    loadConfirmedOperatorDecisions(auth, DATE),
  ]);
  for (const [name, r] of Object.entries({ hotelsRes, groupsRes, assignmentsRes, vehiclesRes, vehicleAvailRes, vehicleBlocksRes, driverAvailRes })) {
    if ((r as { error?: { message: string } | null }).error) throw new Error(`${name}: ${(r as { error: { message: string } }).error.message}`);
  }

  const availability = (driverAvailRes.data ?? []) as AvailabilityRow[];
  const availableDriverKeys = new Set(availability.filter((r) => r.available !== false).map((r) => r.driver_profile_id ? `profile:${r.driver_profile_id}` : r.driver_user_id ? `user:${r.driver_user_id}` : null).filter((k): k is string => k != null));
  const drivers = driversAll.filter((d) => availableDriverKeys.has(driverKey(d) ?? ""));
  const vehicleAvailMap = new Map((vehicleAvailRes.data ?? []).map((r: { vehicle_id: string | null; available: boolean | null }) => [r.vehicle_id, r.available]));
  const vehicleBlocked = new Set(((vehicleBlocksRes.data ?? []) as Array<Record<string, unknown>>).filter((b) => vehicleBlockedOnDate(b, DATE)).map((b) => b.vehicle_id));
  const vehicles = ((vehiclesRes.data ?? []) as VehicleRow[]).filter((v) => v.active !== false && vehicleAvailMap.get(v.id) !== false && !vehicleBlocked.has(v.id)).sort((a, b) => (a.capacity ?? 999) - (b.capacity ?? 999) || String(a.label).localeCompare(String(b.label)));
  const allVehicles = (vehiclesRes.data ?? []) as VehicleRow[];

  const groups = (groupsRes.data ?? []) as GroupRow[];
  const groupIds = new Set(groups.map((g) => g.id));
  const assignments = ((assignmentsRes.data ?? []) as AssignmentRow[]).filter((a) => a.group_id && groupIds.has(a.group_id));
  const hotels = (hotelsRes.data ?? []) as HotelRow[];
  const vehiclesByLabel = new Map(allVehicles.map((v) => [norm(v.label), v]));

  const services = await loadServices(admin, tenantId, [...new Set(assignments.map((a) => a.service_id))]);
  const servicesById = new Map(services.map((s) => [s.id, s]));
  const assignmentsByGroup = new Map<string, AssignmentRow[]>();
  for (const a of assignments) { if (!a.group_id) continue; assignmentsByGroup.set(a.group_id, [...(assignmentsByGroup.get(a.group_id) ?? []), a]); }
  const servicesByGroup = new Map<string, ServiceRow[]>();
  for (const g of groups) { servicesByGroup.set(g.id, (assignmentsByGroup.get(g.id) ?? []).map((a) => servicesById.get(a.service_id)).filter((s): s is ServiceRow => Boolean(s))); }
  const confirmedByGroup = new Map<string, Set<string>>();
  for (const d of decisions) { if (!d.trip_group_id) continue; const set = confirmedByGroup.get(d.trip_group_id) ?? new Set<string>(); set.add(d.action); confirmedByGroup.set(d.trip_group_id, set); }

  const clusters = detectExcursionRoundtripClusters({ services, hotels });
  const clusterServiceIds = new Set(clusters.flatMap((c) => c.service_ids));
  const clusterGroupIds = new Set(assignments.filter((a) => clusterServiceIds.has(a.service_id)).map((a) => a.group_id).filter((id): id is string => Boolean(id)));

  const units: RouteUnit[] = [];
  for (const cluster of clusters) {
    const cGroupIds = [...new Set(assignments.filter((a) => cluster.service_ids.includes(a.service_id) && a.group_id && groupIds.has(a.group_id!)).map((a) => a.group_id!))];
    if (cGroupIds.length === 0) continue;
    const clusterServices = services.filter((s) => cluster.service_ids.includes(s.id));
    const unit = makeUnit({ id: cluster.cluster_id, groupIds: cGroupIds, services: clusterServices, stops: serviceStops({ services: clusterServices, hotels }), type: "cluster_escursione_roundtrip", group: groups.find((g) => cGroupIds.includes(g.id)) ?? null, drivers, vehiclesByLabel, confirmedActions: new Set() });
    unit.pax = cluster.total_pax;
    unit.min_vehicle_capacity = cluster.total_pax;
    units.push(unit);
  }
  for (const group of groups) {
    if (clusterGroupIds.has(group.id)) continue;
    const groupServices = servicesByGroup.get(group.id) ?? [];
    const stops = serviceStops({ services: groupServices, hotels });
    const confirmedActions = confirmedByGroup.get(group.id) ?? new Set<string>();
    const type = unitTypeFromStops(stops, confirmedActions);
    const split = splitDenseShuttleUnits({ group, groupServices, stops, type, drivers, vehiclesByLabel, confirmedActions });
    if (split) { units.push(...split); continue; }
    units.push(makeUnit({ id: group.id, groupIds: [group.id], services: groupServices, stops, type, group, drivers, vehiclesByLabel, confirmedActions }));
  }

  const plannerDrivers = drivers.map((d) => { const key = driverKey(d); const w = availabilityFor(d, availability); if (!key) return null; return { key, name: d.full_name, max_vehicle_capacity: d.max_vehicle_capacity, available_from: w?.available_from ?? null, available_to: w?.available_to ?? null } satisfies GlobalPlannerDriver; }).filter((d): d is GlobalPlannerDriver => d != null);
  const plannerVehicles = vehicles.map((v): GlobalPlannerVehicle => ({ key: norm(v.label ?? v.id), label: v.label, capacity: v.capacity }));

  const proposed = assignGlobalPlanner({ units, drivers: plannerDrivers, vehicles: plannerVehicles, enableBacktracking: true, backtrackingMaxDepth: 3, backtrackingLocalWindowMinutes: 75 }) as ProposedUnit[];
  const diag = diagnostics(proposed, drivers, allVehicles, availability);

  const unassigned = proposed.filter((u) => !u.assigned);
  const durationSourceCounts = Object.fromEntries(Object.entries(Object.groupBy(units, (u) => u.duration_source)).map(([k, v]) => [k, v?.length ?? 0]));

  console.log(JSON.stringify({
    date: DATE,
    summary: {
      total_units: proposed.length,
      assigned_units: proposed.filter((u) => u.assigned).length,
      needs_review: diag.needs_review,
      total_conflicts: diag.total_conflicts,
      driver_conflicts: diag.driver_conflicts,
      vehicle_conflicts: diag.vehicle_conflicts,
      eligibility_blockers: diag.eligibility_blockers,
      availability_blockers: diag.availability_blockers,
      overbooking: diag.overbooking,
    },
    duration_source_counts: durationSourceCounts,
    available_drivers: drivers.length,
    available_vehicles: vehicles.length,
    unassigned_units: unassigned.map((u) => ({ id: u.id, start: u.start, end: u.end, type: u.type, pax: u.pax, blocker: u.blocker })),
    regression_check: {
      assigned_units_eq_total: proposed.filter((u) => u.assigned).length === proposed.length,
      needs_review_zero: diag.needs_review === 0,
      total_conflicts_zero: diag.total_conflicts === 0,
      eligibility_blockers_zero: diag.eligibility_blockers === 0,
      availability_blockers_zero: diag.availability_blockers === 0,
      overbooking_zero: diag.overbooking === 0,
      ALL_PASS: diag.total_conflicts === 0 && diag.needs_review === 0 && diag.eligibility_blockers === 0 && diag.availability_blockers === 0 && diag.overbooking === 0 && proposed.filter((u) => u.assigned).length === proposed.length,
    },
  }, null, 2));
}

main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.stack ?? e.message : JSON.stringify(e, null, 2)); process.exit(1); });
