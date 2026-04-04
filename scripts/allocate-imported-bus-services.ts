import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { findBusStopsByCity } from "@/lib/bus-lines-catalog";
import { deriveServiceBusIdentity } from "@/lib/server/bus-network";
import type { Service, TenantBusLine, TenantBusLineStop, TenantBusUnit } from "@/lib/types";

type PlannedAllocation = {
  service_id: string;
  customer_name: string;
  pax: number;
  direction: "arrival" | "departure";
  bus_city_origin: string | null;
  transport_code: string | null;
  bus_line_id: string;
  bus_line_code: string;
  bus_unit_id: string;
  bus_unit_label: string;
  stop_id: string;
  stop_name: string;
};

type SimBus = {
  id: string;
  label: string;
  remaining: number;
};

function normalizeBusText(value?: string | null) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function parseArgs(args: string[]) {
  let tenantId = "";
  let date = "";
  let userId = "";
  let apply = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--tenant") {
      tenantId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--date") {
      date = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--user") {
      userId = args[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
    }
  }

  return { tenantId, date, userId, apply };
}

function chooseBus(service: Service, buses: SimBus[]) {
  const preferredLabels = service.transport_code === "LINEA_PUGLIA_ITALIA" ? ["ITALIA PUGLIA", "ITALIA PUGLIA 2"] : [];
  if (preferredLabels.length > 0) {
    const dedicated = preferredLabels
      .map((label) => buses.find((bus) => bus.label === label && bus.remaining >= service.pax) ?? null)
      .find((bus): bus is SimBus => Boolean(bus));
    return dedicated ?? null;
  }

  const reserved = new Set(["ITALIA PUGLIA", "ITALIA PUGLIA 2"]);
  const candidates = buses
    .filter((bus) => bus.remaining >= service.pax && !reserved.has(bus.label))
    .sort((left, right) => left.remaining - right.remaining);
  return candidates[0] ?? null;
}

async function main() {
  loadDotEnvLocal();
  const { tenantId, date, userId, apply } = parseArgs(process.argv.slice(2));
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Env Supabase mancanti.");
  }
  if (!tenantId || !date) {
    throw new Error("Uso: pnpm bus:allocate-imported --tenant <tenant_id> --date <YYYY-MM-DD> [--apply] [--user <user_id>]");
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  let createdByUserId = userId;
  if (!createdByUserId) {
    const membershipResult = await admin
      .from("memberships")
      .select("user_id, role")
      .eq("tenant_id", tenantId)
      .in("role", ["admin", "operator"])
      .limit(1)
      .maybeSingle();
    if (membershipResult.error || !membershipResult.data?.user_id) {
      throw new Error(membershipResult.error?.message ?? "Nessun admin/operator disponibile per allocare i servizi.");
    }
    createdByUserId = membershipResult.data.user_id;
  }

  const [servicesResult, linesResult, stopsResult, unitsResult, allocationsResult] = await Promise.all([
    admin
      .from("services")
      .select("id,customer_name,pax,direction,bus_city_origin,transport_code,time,outbound_time,service_type_code,booking_service_kind")
      .eq("tenant_id", tenantId)
      .eq("service_type_code", "bus_line")
      .eq("date", date)
      .order("direction")
      .order("time"),
    admin.from("tenant_bus_lines").select("id,code,name,family_code").eq("tenant_id", tenantId),
    admin.from("tenant_bus_line_stops").select("id,bus_line_id,direction,stop_name,city,active,stop_order").eq("tenant_id", tenantId).eq("active", true),
    admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,active,status,sort_order").eq("tenant_id", tenantId).eq("active", true).order("sort_order"),
    admin.from("tenant_bus_allocations").select("id,service_id,bus_unit_id,pax_assigned").eq("tenant_id", tenantId)
  ]);

  if (servicesResult.error) throw new Error(servicesResult.error.message);
  if (linesResult.error) throw new Error(linesResult.error.message);
  if (stopsResult.error) throw new Error(stopsResult.error.message);
  if (unitsResult.error) throw new Error(unitsResult.error.message);
  if (allocationsResult.error) throw new Error(allocationsResult.error.message);

  const services = (servicesResult.data ?? []) as Service[];
  const lines = (linesResult.data ?? []) as Array<Pick<TenantBusLine, "id" | "code" | "name" | "family_code">>;
  const stops = (stopsResult.data ?? []) as Array<Pick<TenantBusLineStop, "id" | "bus_line_id" | "direction" | "stop_name" | "city" | "stop_order">>;
  const units = (unitsResult.data ?? []) as Array<Pick<TenantBusUnit, "id" | "bus_line_id" | "label" | "capacity">>;
  const existingAllocations = allocationsResult.data ?? [];

  const allocatedServiceIds = new Set(existingAllocations.map((item: { service_id: string }) => item.service_id));
  const lineByCode = new Map(lines.map((line) => [line.code, line]));
  const familyLineByCode = new Map(lines.map((line) => [line.family_code, line]));
  const loadsByUnit = new Map<string, number>();
  for (const allocation of existingAllocations) {
    loadsByUnit.set(allocation.bus_unit_id, (loadsByUnit.get(allocation.bus_unit_id) ?? 0) + allocation.pax_assigned);
  }

  const busesByLineId = new Map<string, SimBus[]>();
  for (const unit of units) {
    const list = busesByLineId.get(unit.bus_line_id) ?? [];
    list.push({
      id: unit.id,
      label: unit.label,
      remaining: Math.max(0, unit.capacity - (loadsByUnit.get(unit.id) ?? 0))
    });
    busesByLineId.set(unit.bus_line_id, list);
  }

  const planned: PlannedAllocation[] = [];
  const skippedAlreadyAllocated: string[] = [];
  const errors: Array<{ service_id: string; customer_name: string; message: string }> = [];
  // Fermate create al volo durante questa esecuzione (chiave: "lineId:direction:CITY")
  const createdStops = new Map<string, Pick<TenantBusLineStop, "id" | "bus_line_id" | "direction" | "stop_name" | "city" | "stop_order">>();

  for (const service of services) {
    if (allocatedServiceIds.has(service.id)) {
      skippedAlreadyAllocated.push(service.id);
      continue;
    }

    const identity = deriveServiceBusIdentity(service);
    const line = familyLineByCode.get(identity.family_code) ?? lineByCode.get(identity.lineCode ?? "");
    if (!line) {
      errors.push({ service_id: service.id, customer_name: service.customer_name, message: "Linea bus non trovata." });
      continue;
    }

    const lineStops = stops.filter((item) => item.bus_line_id === line.id && item.direction === service.direction);
    const requestedCity = normalizeBusText(service.bus_city_origin);
    const identityCity = normalizeBusText(identity.city);
    const aliasCities = findBusStopsByCity(service.bus_city_origin)
      .map((entry) => normalizeBusText(entry.stop.city));
    let stop = lineStops.find((item) => {
      const stopCity = normalizeBusText(item.city);
      const stopName = normalizeBusText(item.stop_name);
      return (
        stopCity === requestedCity ||
        stopName === requestedCity ||
        stopCity === identityCity ||
        stopName === identityCity ||
        aliasCities.includes(stopCity) ||
        aliasCities.includes(stopName)
      );
    });
    // Se la fermata non si trova → creala come fermata manuale
    if (!stop) {
      const rawCity = (service.bus_city_origin ?? "").trim();
      const cityName = rawCity.toUpperCase() || "SCONOSCIUTA";
      const stopKey = `${line.id}:${service.direction}:${cityName}`;

      // Riusa la fermata se già creata in questo run
      const alreadyCreated = createdStops.get(stopKey);
      if (alreadyCreated) {
        stop = alreadyCreated;
      } else {
        const maxOrder = lineStops.reduce((max, s) => Math.max(max, s.stop_order ?? 0), 0);
        const newStopData = {
          tenant_id: tenantId,
          bus_line_id: line.id,
          direction: service.direction as "arrival" | "departure",
          stop_name: cityName,
          city: rawCity || cityName,
          stop_order: maxOrder + 1,
          order_index: maxOrder + 1,
          is_manual: true,
          active: true
        };

        if (apply) {
          const { data: inserted, error: insertErr } = await admin
            .from("tenant_bus_line_stops")
            .insert(newStopData)
            .select("id,bus_line_id,direction,stop_name,city,stop_order")
            .single();
          if (insertErr || !inserted) {
            errors.push({ service_id: service.id, customer_name: service.customer_name, message: `Impossibile creare fermata per ${cityName}: ${insertErr?.message ?? "errore"}` });
            continue;
          }
          stop = inserted as Pick<TenantBusLineStop, "id" | "bus_line_id" | "direction" | "stop_name" | "city" | "stop_order">;
        } else {
          // Dry-run: fermata virtuale
          stop = { id: `new-${stopKey}`, bus_line_id: line.id, direction: service.direction as "arrival" | "departure", stop_name: cityName, city: rawCity || cityName, stop_order: maxOrder + 1 };
        }

        createdStops.set(stopKey, stop);
        lineStops.push(stop); // disponibile per i prossimi passeggeri della stessa città
        console.log(`[INFO] Creata fermata manuale: ${cityName} (linea ${line.code}, ${service.direction})`);
      }
    }

    const buses = busesByLineId.get(line.id) ?? [];
    const chosenBus = chooseBus(service, buses);
    if (!chosenBus) {
      const message =
        service.transport_code === "LINEA_PUGLIA_ITALIA"
          ? "Nessun posto disponibile sui bus dedicati ITALIA PUGLIA."
          : `Nessun bus disponibile sulla linea ${line.code}.`;
      errors.push({ service_id: service.id, customer_name: service.customer_name, message });
      continue;
    }

    chosenBus.remaining -= service.pax;
    planned.push({
      service_id: service.id,
      customer_name: service.customer_name,
      pax: service.pax,
      direction: service.direction,
      bus_city_origin: service.bus_city_origin ?? null,
      transport_code: service.transport_code ?? null,
      bus_line_id: line.id,
      bus_line_code: line.code,
      bus_unit_id: chosenBus.id,
      bus_unit_label: chosenBus.label,
      stop_id: stop.id,
      stop_name: stop.stop_name
    });
  }

  if (!apply) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: true,
          tenant_id: tenantId,
          date,
          summary: {
            candidate_services: services.length,
            already_allocated_services: skippedAlreadyAllocated.length,
            planned_allocations: planned.length,
            errors: errors.length
          },
          planned_allocations: planned,
          errors
        },
        null,
        2
      )
    );
    return;
  }

  for (const item of planned) {
    const { error } = await admin.rpc("allocate_bus_service", {
      p_tenant_id: tenantId,
      p_service_id: item.service_id,
      p_bus_line_id: item.bus_line_id,
      p_bus_unit_id: item.bus_unit_id,
      p_stop_id: item.stop_id,
      p_stop_name: item.stop_name,
      p_direction: item.direction,
      p_pax_assigned: item.pax,
      p_notes: null,
      p_created_by_user_id: createdByUserId
    });
    if (error) {
      errors.push({ service_id: item.service_id, customer_name: item.customer_name, message: error.message });
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        dry_run: false,
        tenant_id: tenantId,
        date,
        summary: {
          candidate_services: services.length,
          already_allocated_services: skippedAlreadyAllocated.length,
          planned_allocations: planned.length,
          applied_allocations: planned.length - errors.length,
          errors: errors.length
        },
        errors
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
