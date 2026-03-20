import type { Service, ServiceDirection } from "@/lib/types";

export type OperationalInstance = {
  instanceId: string;
  serviceId: string;
  date: string;
  time: string;
  direction: ServiceDirection;
  service: Service;
};

function normalizeTime(value?: string | null) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)/);
  if (!match) return "00:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function isOperationallyVisible(service: Service) {
  return !service.is_draft && service.status !== "cancelled";
}

export function buildOperationalInstances(services: Service[]) {
  const instances: OperationalInstance[] = [];

  for (const service of services) {
    if (!isOperationallyVisible(service)) continue;

    const arrivalDate = service.arrival_date ?? service.date;
    const arrivalTime = service.arrival_time ?? service.outbound_time ?? service.time;
    if (arrivalDate) {
      instances.push({
        instanceId: `${service.id}:arrival`,
        serviceId: service.id,
        date: arrivalDate,
        time: normalizeTime(arrivalTime),
        direction: "arrival",
        service
      });
    }

    const departureDate = service.departure_date;
    const departureTime = service.departure_time ?? service.return_time;
    if (departureDate) {
      instances.push({
        instanceId: `${service.id}:departure`,
        serviceId: service.id,
        date: departureDate,
        time: normalizeTime(departureTime),
        direction: "departure",
        service
      });
    }
  }

  return instances.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.time !== b.time) return a.time.localeCompare(b.time);
    return a.service.customer_name.localeCompare(b.service.customer_name);
  });
}

export function groupOperationalInstancesByDate(instances: OperationalInstance[]) {
  const map = new Map<string, OperationalInstance[]>();
  for (const instance of instances) {
    const current = map.get(instance.date) ?? [];
    current.push(instance);
    map.set(instance.date, current);
  }
  return map;
}

