import { hotelGeoQuality } from "@/lib/hotel-geocoding";
import type { Assignment, BusLotConfig, Hotel, Service } from "@/lib/types";

export type SuggestionType = "overcapacity" | "geo_issue" | "missing_data" | "imbalance";
export type SuggestionPriority = "critical" | "high" | "medium" | "low";

export type SuggestionActionPayload = {
  action: "move_pax_between_buses" | "open_service" | "open_hotel" | "mark_resolved";
  from_bus_id?: string;
  from_bus_label?: string;
  to_bus_id?: string;
  to_bus_label?: string;
  pax?: number;
  service_id?: string;
  customer_name?: string;
  hotel_id?: string;
  date?: string;
  direction?: Service["direction"];
};

export type Suggestion = {
  id: string;
  type: SuggestionType;
  priority: SuggestionPriority;
  title: string;
  description: string;
  action_label: string;
  action_payload: SuggestionActionPayload;
  created_at: Date;
  resolved: boolean;
};

export type OperationsSuggestionState = {
  buses?: OperationBus[];
  services: Service[];
  assignments: Assignment[];
  hotels: Hotel[];
  busLotConfigs?: BusLotConfig[];
  now?: Date;
  resolvedSuggestionIds?: Set<string>;
};

export type OperationBus = {
  id: string;
  label: string;
  capacity: number;
  assigned_pax: number;
  date?: string;
  direction?: Service["direction"];
  source: "assignment" | "bus_lot" | "service";
};

const PRIORITY_WEIGHT: Record<SuggestionPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function stableId(parts: Array<string | number | null | undefined>) {
  return parts
    .map((part) =>
      String(part ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join(":");
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function isActiveService(service: Service, horizon?: Date) {
  if (service.status === "cancelled" || service.status === "completato" || service.is_draft === true) return false;
  if (horizon && service.date) {
    const serviceDate = new Date(service.date);
    if (serviceDate > horizon) return false;
  }
  return true;
}

function matchesBusLot(service: Service, lot: BusLotConfig) {
  if (service.date !== lot.service_date || service.direction !== lot.direction) return false;
  if (lot.billing_party_name && normalizeText(service.billing_party_name) !== normalizeText(lot.billing_party_name)) return false;
  if (lot.bus_city_origin && normalizeText(service.bus_city_origin) !== normalizeText(lot.bus_city_origin)) return false;
  if (lot.transport_code && normalizeText(service.transport_code) !== normalizeText(lot.transport_code)) return false;
  return service.service_type_code === "bus_line" || service.booking_service_kind === "bus_city_hotel";
}

function busLabelFromLot(lot: BusLotConfig) {
  return lot.title?.trim() || lot.meeting_point?.trim() || lot.bus_city_origin?.trim() || lot.lot_key;
}

function buildBuses(state: OperationsSuggestionState): OperationBus[] {
  const services = state.services.filter(isActiveService);
  const buses: OperationBus[] = [...(state.buses ?? [])];

  for (const lot of state.busLotConfigs ?? []) {
    const assignedPax = services
      .filter((service) => matchesBusLot(service, lot))
      .reduce((sum, service) => sum + (service.pax ?? 0), 0);

    buses.push({
      id: lot.id,
      label: busLabelFromLot(lot),
      capacity: lot.capacity,
      assigned_pax: assignedPax,
      date: lot.service_date,
      direction: lot.direction,
      source: "bus_lot"
    });
  }

  for (const service of services) {
    if (!service.capacity || service.capacity <= 0) continue;
    if (service.service_type !== "bus_tour" && service.service_type_code !== "bus_line" && service.booking_service_kind !== "bus_city_hotel") continue;

    buses.push({
      id: service.id,
      label: service.tour_name?.trim() || service.bus_plate?.trim() || service.vessel || `Bus ${service.id.slice(0, 6)}`,
      capacity: service.capacity,
      assigned_pax: service.pax ?? 0,
      date: service.date,
      direction: service.direction,
      source: "service"
    });
  }

  const servicesById = new Map(services.map((service) => [service.id, service]));
  const assignmentGroups = new Map<string, OperationBus>();
  for (const assignment of state.assignments) {
    const service = servicesById.get(assignment.service_id);
    const label = assignment.vehicle_label?.trim();
    if (!service || !label) continue;

    const key = stableId(["assignment", service.date, service.direction, label]);
    const existing = assignmentGroups.get(key);
    const capacity = service.capacity && service.capacity > 0 ? service.capacity : undefined;
    if (existing) {
      existing.assigned_pax += service.pax ?? 0;
      if (!existing.capacity && capacity) existing.capacity = capacity;
      continue;
    }

    assignmentGroups.set(key, {
      id: key,
      label,
      capacity: capacity ?? 0,
      assigned_pax: service.pax ?? 0,
      date: service.date,
      direction: service.direction,
      source: "assignment"
    });
  }

  for (const bus of assignmentGroups.values()) {
    if (bus.capacity > 0) buses.push(bus);
  }

  const unique = new Map<string, OperationBus>();
  for (const bus of buses) {
    if (!bus.capacity || bus.capacity <= 0) continue;
    unique.set(bus.id, bus);
  }
  return [...unique.values()];
}

function findTargetBus(source: OperationBus, buses: OperationBus[], paxNeeded: number) {
  return buses
    .filter((bus) => bus.id !== source.id && bus.date === source.date && bus.direction === source.direction)
    .map((bus) => ({ ...bus, remaining: bus.capacity - bus.assigned_pax }))
    .filter((bus) => bus.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .find((bus) => bus.remaining >= Math.max(1, paxNeeded)) ?? null;
}

function makeSuggestion(input: Omit<Suggestion, "created_at" | "resolved">, state: OperationsSuggestionState): Suggestion {
  return {
    ...input,
    created_at: state.now ?? new Date(),
    resolved: state.resolvedSuggestionIds?.has(input.id) ?? false
  };
}

export function generateSuggestions(state: OperationsSuggestionState): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const now = state.now ?? new Date();
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + 30);
  const buses = buildBuses(state);
  const activeServices = state.services.filter((s) => isActiveService(s, horizon));
  const hotelsById = new Map(state.hotels.map((hotel) => [hotel.id, hotel]));

  for (const bus of buses) {
    const remainingSeats = bus.capacity - bus.assigned_pax;
    if (remainingSeats < 0) {
      const paxToMove = Math.abs(remainingSeats);
      const target = findTargetBus(bus, buses, paxToMove);
      suggestions.push(makeSuggestion({
        id: stableId(["suggestion", "overcapacity", bus.id, bus.assigned_pax, bus.capacity, target?.id]),
        type: "overcapacity",
        priority: "critical",
        title: "Bus in overbooking",
        description: target
          ? `Sposta ${paxToMove} passeggeri da ${bus.label} a ${target.label}.`
          : `${bus.label} supera la capienza di ${paxToMove} passeggeri. Serve un mezzo alternativo o una redistribuzione manuale.`,
        action_label: target ? "Sposta pax" : "Segna gestito",
        action_payload: target
          ? {
              action: "move_pax_between_buses",
              from_bus_id: bus.id,
              from_bus_label: bus.label,
              to_bus_id: target.id,
              to_bus_label: target.label,
              pax: paxToMove,
              date: bus.date,
              direction: bus.direction
            }
          : { action: "mark_resolved", from_bus_id: bus.id, from_bus_label: bus.label, pax: paxToMove, date: bus.date, direction: bus.direction }
      }, state));
      continue;
    }

    if (remainingSeats <= 5) {
      const target = findTargetBus(bus, buses, Math.max(1, 6 - remainingSeats));
      suggestions.push(makeSuggestion({
        id: stableId(["suggestion", "near-full", bus.id, remainingSeats, target?.id]),
        type: "overcapacity",
        priority: "high",
        title: "Bus quasi pieno",
        description: target
          ? `${bus.label} ha ${remainingSeats} posti liberi. Puoi alleggerire spostando alcuni passeggeri su ${target.label}.`
          : `${bus.label} ha solo ${remainingSeats} posti liberi. Tienilo monitorato prima di nuove assegnazioni.`,
        action_label: target ? "Alleggerisci" : "Segna gestito",
        action_payload: target
          ? {
              action: "move_pax_between_buses",
              from_bus_id: bus.id,
              from_bus_label: bus.label,
              to_bus_id: target.id,
              to_bus_label: target.label,
              pax: Math.min(target.capacity - target.assigned_pax, Math.max(1, 6 - remainingSeats)),
              date: bus.date,
              direction: bus.direction
            }
          : { action: "mark_resolved", from_bus_id: bus.id, from_bus_label: bus.label, date: bus.date, direction: bus.direction }
      }, state));
    }
  }

  for (const service of activeServices) {
    const hotel = hotelsById.get(service.hotel_id);
    const hotelGeo = hotel ? hotelGeoQuality(hotel) : null;
    if (hotel && (hotel.geo_status === "missing" || hotel.geo_status === "generic" || hotelGeo?.routeUsable === false)) {
      suggestions.push(makeSuggestion({
        id: stableId(["suggestion", "geo", hotel.id, hotel.geo_status]),
        type: "geo_issue",
        priority: "medium",
        title: "Hotel da verificare sulla mappa",
        description: `${hotel.name} ha geocoding ${hotel.geo_status ?? "non verificato"}. Verifica le coordinate prima del giro.`,
        action_label: "Apri hotel",
        action_payload: { action: "open_hotel", hotel_id: hotel.id, service_id: service.id }
      }, state));
    }

    const isNavetta =
      (service.booking_service_kind as string | null) === "navetta" ||
      service.booking_service_kind === "shuttle_hotel" ||
      (service.vessel as string | null)?.toLowerCase().trim() === "navetta" ||
      (service.customer_name as string | null)?.toLowerCase().trim() === "navetta";
    const isExcursion =
      service.booking_service_kind === "excursion" ||
      (service.service_type_code as string | null) === "excursion" ||
      service.service_type === "bus_tour";
    if (!isNavetta && !isExcursion && !service.phone?.trim() && !service.phone_e164?.trim()) {
      suggestions.push(makeSuggestion({
        id: stableId(["suggestion", "missing-phone", service.id]),
        type: "missing_data",
        priority: "medium",
        title: "Telefono cliente mancante",
        description: `${service.customer_name || "Cliente"} non ha un telefono salvato. Recuperalo prima di inviare reminder o aggiornamenti.`,
        action_label: "Apri servizio",
        action_payload: { action: "open_service", service_id: service.id, customer_name: service.customer_name ?? undefined }
      }, state));
    }
  }

  const busesByDateDirection = new Map<string, OperationBus[]>();
  for (const bus of buses) {
    const key = stableId([bus.date, bus.direction]);
    busesByDateDirection.set(key, [...(busesByDateDirection.get(key) ?? []), bus]);
  }

  for (const group of busesByDateDirection.values()) {
    const fullBus = group
      .filter((bus) => bus.capacity - bus.assigned_pax <= 5)
      .sort((a, b) => a.capacity - a.assigned_pax - (b.capacity - b.assigned_pax))[0];
    const freeBus = group
      .filter((bus) => bus.capacity - bus.assigned_pax >= 10)
      .sort((a, b) => b.capacity - b.assigned_pax - (a.capacity - a.assigned_pax))[0];

    if (!fullBus || !freeBus || fullBus.id === freeBus.id) continue;
    const pax = Math.min(5, freeBus.capacity - freeBus.assigned_pax, Math.max(1, fullBus.assigned_pax - Math.floor(fullBus.capacity * 0.85)));
    suggestions.push(makeSuggestion({
      id: stableId(["suggestion", "imbalance", fullBus.id, freeBus.id, pax]),
      type: "imbalance",
      priority: "medium",
      title: "Sbilanciamento bus",
      description: `${fullBus.label} e ${freeBus.label} non sono bilanciati. Sposta circa ${pax} passeggeri verso il mezzo con piu posti liberi.`,
      action_label: "Redistribuisci",
      action_payload: {
        action: "move_pax_between_buses",
        from_bus_id: fullBus.id,
        from_bus_label: fullBus.label,
        to_bus_id: freeBus.id,
        to_bus_label: freeBus.label,
        pax,
        date: fullBus.date,
        direction: fullBus.direction
      }
    }, state));
  }

  const byId = new Map<string, Suggestion>();
  for (const suggestion of suggestions) byId.set(suggestion.id, suggestion);

  return [...byId.values()].sort((a, b) => {
    const priorityDiff = PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.title.localeCompare(b.title);
  });
}

export async function generateSuggestionText(suggestion: Suggestion): Promise<string> {
  if (suggestion.priority !== "critical" && suggestion.priority !== "high") return suggestion.description;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return suggestion.description;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_SUGGESTIONS_MODEL?.trim() || "gpt-5.4-mini",
        input: [
          {
            role: "system",
            content: "Sei un assistente operativo per transfer turistici. Non prendere decisioni: riscrivi solo il testo in italiano chiaro, breve e concreto."
          },
          {
            role: "user",
            content: `Spiega in modo chiaro e operativo questa situazione: ${JSON.stringify({
              type: suggestion.type,
              priority: suggestion.priority,
              title: suggestion.title,
              description: suggestion.description,
              action_payload: suggestion.action_payload
            })}`
          }
        ],
        max_output_tokens: 120
      })
    });

    if (!response.ok) return suggestion.description;
    const body = (await response.json().catch(() => null)) as { output_text?: string } | null;
    const text = body?.output_text?.trim();
    return text || suggestion.description;
  } catch {
    return suggestion.description;
  }
}
