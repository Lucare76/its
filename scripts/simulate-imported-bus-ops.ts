import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { deriveServiceBusIdentity } from "@/lib/server/bus-network";
import type { Service, TenantBusLine, TenantBusUnit } from "@/lib/types";

type SimulationGroupKey = "arrival|ITALIA" | "arrival|CENTRO" | "arrival|ADRIATICA" | "departure|ITALIA" | "departure|CENTRO" | "departure|ADRIATICA";

type SimBus = {
  id: string;
  label: string;
  remaining: number;
  pax: number;
  services: number;
};

type SimService = Pick<Service, "id" | "customer_name" | "pax" | "direction" | "transport_code" | "bus_city_origin"> & {
  targetLineCode: "ITALIA" | "CENTRO" | "ADRIATICA";
  targetLineName: string;
  preferredBusLabels: string[];
};

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
    }
  }
  return { tenantId, date };
}

function buildServiceTarget(service: Service): SimService {
  const identity = deriveServiceBusIdentity(service);
  const targetLineCode = identity.family_code;
  const preferredBusLabels = service.transport_code === "LINEA_PUGLIA_ITALIA" ? ["ITALIA PUGLIA", "ITALIA PUGLIA 2"] : [];
  return {
    id: service.id,
    customer_name: service.customer_name,
    pax: service.pax,
    direction: service.direction,
    transport_code: service.transport_code,
    bus_city_origin: service.bus_city_origin,
    targetLineCode,
    targetLineName: identity.family_name,
    preferredBusLabels
  };
}

function buildGroupKey(direction: Service["direction"], lineCode: "ITALIA" | "CENTRO" | "ADRIATICA"): SimulationGroupKey {
  return `${direction}|${lineCode}` as SimulationGroupKey;
}

function findAssignableBus(
  service: SimService,
  buses: SimBus[],
  reservedLabels: Set<string>
) {
  if (service.preferredBusLabels.length > 0) {
    const dedicated = service.preferredBusLabels
      .map((label) => buses.find((bus) => bus.label === label && bus.remaining >= service.pax) ?? null)
      .find((bus): bus is SimBus => Boolean(bus));
    if (dedicated) return dedicated;
  }

  const candidates = buses.filter(
    (bus) => bus.remaining >= service.pax && (!reservedLabels.has(bus.label) || service.preferredBusLabels.includes(bus.label))
  );
  return candidates.sort((left, right) => left.remaining - right.remaining)[0] ?? null;
}

async function main() {
  loadDotEnvLocal();
  const { tenantId, date } = parseArgs(process.argv.slice(2));
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Env Supabase mancanti.");
  }
  if (!tenantId || !date) {
    throw new Error("Uso: pnpm bus:simulate-ops --tenant <tenant_id> --date <YYYY-MM-DD>");
  }

  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const [servicesResult, linesResult, unitsResult] = await Promise.all([
    admin
      .from("services")
      .select("id,customer_name,pax,direction,transport_code,bus_city_origin,time,outbound_time,service_type_code,booking_service_kind")
      .eq("tenant_id", tenantId)
      .eq("service_type_code", "bus_line")
      .eq("date", date)
      .order("direction")
      .order("time"),
    admin.from("tenant_bus_lines").select("id,code,name,family_code,family_name").eq("tenant_id", tenantId).order("code"),
    admin.from("tenant_bus_units").select("id,bus_line_id,label,capacity,sort_order,active,status").eq("tenant_id", tenantId).eq("active", true).order("sort_order")
  ]);

  if (servicesResult.error) throw new Error(servicesResult.error.message);
  if (linesResult.error) throw new Error(linesResult.error.message);
  if (unitsResult.error) throw new Error(unitsResult.error.message);

  const lines = (linesResult.data ?? []) as Pick<TenantBusLine, "id" | "code" | "name" | "family_code" | "family_name">[];
  const units = (unitsResult.data ?? []) as Array<Pick<TenantBusUnit, "id" | "bus_line_id" | "label" | "capacity">>;
  const lineByCode = new Map(lines.map((line) => [line.code, line]));

  const groupedServices = new Map<SimulationGroupKey, SimService[]>();
  for (const raw of (servicesResult.data ?? []) as Service[]) {
    const service = buildServiceTarget(raw);
    const key = buildGroupKey(service.direction, service.targetLineCode);
    const list = groupedServices.get(key) ?? [];
    list.push(service);
    groupedServices.set(key, list);
  }

  const summaries: Array<Record<string, unknown>> = [];

  for (const [groupKey, services] of groupedServices.entries()) {
    const [direction, lineCode] = groupKey.split("|") as [Service["direction"], "ITALIA" | "CENTRO" | "ADRIATICA"];
    const line = lineByCode.get(lineCode);
    if (!line) continue;

    const lineBuses = units
      .filter((unit) => unit.bus_line_id === line.id)
      .map((unit) => ({
        id: unit.id,
        label: unit.label,
        remaining: unit.capacity,
        pax: 0,
        services: 0
      }));

    const reservedLabels = new Set(lineCode === "ITALIA" ? ["ITALIA PUGLIA", "ITALIA PUGLIA 2"] : []);
    const overflow: SimService[] = [];

    for (const service of [...services].sort((left, right) => right.pax - left.pax)) {
      const targetBus = findAssignableBus(service, lineBuses, reservedLabels);
      if (!targetBus) {
        overflow.push(service);
        continue;
      }
      targetBus.pax += service.pax;
      targetBus.remaining -= service.pax;
      targetBus.services += 1;
    }

    summaries.push({
      direction,
      line_code: lineCode,
      line_name: line.name,
      services: services.length,
      pax: services.reduce((sum, item) => sum + item.pax, 0),
      buses: lineBuses.map((bus) => ({
        label: bus.label,
        pax: bus.pax,
        remaining: bus.remaining,
        services: bus.services
      })),
      overflow_services: overflow.map((service) => ({
        customer_name: service.customer_name,
        pax: service.pax,
        bus_city_origin: service.bus_city_origin,
        transport_code: service.transport_code
      }))
    });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenant_id: tenantId,
        date,
        summary: summaries
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
