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
  if (!match) return "--:--";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function sortTimeKey(value: string) {
  return value === "--:--" ? "99:99" : value;
}

// Obiettivo C/G: stesso carve-out gia' applicato in ops/search (Fix B) —
// un draft di gruppo (booking_group_id valorizzato) e' una prenotazione
// reale in attesa di operativizzazione, non un draft generico da nascondere.
// Senza questo, un gruppo bus_exclusive come GIACOMONI non compariva mai in
// Arrivi/Partenze finche' qualcuno non lo operativizzava a mano.
function isOperationallyVisible(service: Service) {
  return (!service.is_draft || Boolean(service.booking_group_id)) && service.status !== "cancelled";
}

export function buildOperationalInstances(services: Service[]) {
  const instances: OperationalInstance[] = [];

  for (const service of services) {
    if (!isOperationallyVisible(service)) continue;

    // Arrivi: usa arrival_date se esplicito, altrimenti service.date per servizi direction=arrival
    const arrivalDate = service.arrival_date ?? (service.direction === "arrival" ? service.date : null);
    const arrivalTime = service.arrival_time ?? service.outbound_time ?? service.time;
    // Le prenotazioni A/R moderne hanno due record collegati: ciascun record
    // deve produrre soltanto l'istanza della propria direzione. I record legacy
    // non collegati continuano invece a espandersi in arrivo + partenza.
    const linkedPair = Boolean(service.linked_service_id);
    if (arrivalDate && (!linkedPair || service.direction === "arrival")) {
      instances.push({
        instanceId: `${service.id}:arrival`,
        serviceId: service.id,
        date: arrivalDate,
        time: normalizeTime(arrivalTime),
        direction: "arrival",
        service
      });
    }

    // Partenze: usa departure_date se esplicito, altrimenti service.date per servizi direction=departure
    const departureDate = service.departure_date ?? (service.direction === "departure" ? service.date : null);
    const departureTime = service.departure_time ?? service.return_time ?? service.time;
    if (departureDate && (!linkedPair || service.direction === "departure")) {
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
    if (a.time !== b.time) return sortTimeKey(a.time).localeCompare(sortTimeKey(b.time));
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
