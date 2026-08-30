import { describe, expect, it } from "vitest";
import {
  resolveFerryLeg,
  resolveIncomingFerryMeta,
  ferryLegForResponse,
  type FerryConnectionContext,
} from "@/lib/server/ferry-connection-lookup";
import type { OperationalPickupRule } from "@/lib/operational-connection-resolver";
import type { FerryScheduleRow } from "@/lib/travel-connection-resolver";

/**
 * Audit pratica 26/010806 (MATTIOLI ALESSANDRA — Aleste Viaggi): il vecchio
 * enrichment ferry_meta di GET /api/ops/services/[id] mostrava un aliscafo
 * ALILAURO delle 13:20 al posto del traghetto MEDMAR reale, per pura
 * coincidenza di orario col treno di ritorno (ITA 9940, 13:20) — nessuna
 * consapevolezza di agenzia/zona/traghetto-vs-aliscafo. Questi test
 * verificano che lib/server/ferry-connection-lookup.ts (che riusa
 * resolveOperationalConnection come unica fonte canonica) non ripeta
 * quell'errore.
 */

const DATE = "2026-09-06";

function medmarCanonicalRule(overrides: Partial<OperationalPickupRule> = {}): OperationalPickupRule {
  return {
    agency_logic: "aleste",
    transport_type: "train",
    direction: "from_ischia",
    boat_type: "traghetto",
    hotel_id: null,
    zone: "forio",
    transport_from: "13:20",
    transport_to: "16:30",
    company: "medmar",
    departure_time: "10:10",
    embark_port: "casamicciola",
    arrival_port: "pozzuoli",
    arrival_time: null,
    pickup_time: "08:30",
    valid_from: null,
    valid_to: null,
    days_of_week: null,
    ...overrides,
  };
}

function alilauroCoincidentalSchedule(overrides: Partial<FerryScheduleRow> = {}): FerryScheduleRow {
  return {
    id: "sched-alilauro-1320",
    company: "alilauro",
    departure_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    departure_time: "13:20:00",
    arrival_time: "14:05:00",
    direction: "ischia_to_mainland",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
    ...overrides,
  };
}

describe("resolveFerryLeg — audit MATTIOLI (26/010806): mai una compagnia inventata per coincidenza di orario", () => {
  it("1. regola canonica MEDMAR presente + ferry_schedules ha ALILAURO alla stessa ora -> risultato MEDMAR, MAI ALILAURO", () => {
    const context: FerryConnectionContext = {
      operationalRules: [medmarCanonicalRule()],
      ferrySchedules: [alilauroCoincidentalSchedule()],
    };
    const leg = resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "13:20",
      date: DATE,
      hotelId: null,
      zone: "forio",
      zoneRecognized: true,
      agencyName: "Aleste Viaggi",
      pax: 3,
      context,
    });
    expect(leg).not.toBeNull();
    expect(leg?.company).toBe("medmar");
    expect(leg?.company).not.toBe("alilauro");
    expect(leg?.ferry_type).toBe("traghetto");
    expect(leg?.departure_port).toBe("casamicciola");
    expect(leg?.arrival_port).toBe("pozzuoli");
    expect(leg?.departure_time).toBe("10:10");
    expect(leg?.pickup_time).toBe("08:30");

    const response = ferryLegForResponse(leg);
    expect(response?.company).toBe("MEDMAR");
  });

  it("2. nessuna regola canonica applicabile, ma ferry_schedules coincide con l'orario del treno -> undetermined (null), mai una compagnia inventata", () => {
    const context: FerryConnectionContext = {
      operationalRules: [], // nessuna regola canonica configurata
      ferrySchedules: [alilauroCoincidentalSchedule()],
    };
    const leg = resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel",
      transportTime: "13:20",
      date: DATE,
      hotelId: null,
      zone: "forio",
      zoneRecognized: true,
      agencyName: "Aleste Viaggi",
      pax: 3,
      context,
    });
    // Il motore legacy potrebbe comunque proporre qualcosa (source:
    // legacy_fallback) — resolveFerryLeg lo scarta esplicitamente: solo
    // canonical_rule è affidabile abbastanza da mostrare una compagnia.
    expect(leg).toBeNull();
  });

  it("3. transfer_train_hotel Aleste: allowedBoatTypes traghetto soltanto -> una regola aliscafo nella stessa fascia NON viene usata", () => {
    const aliscafoOnlyRule = medmarCanonicalRule({
      boat_type: "aliscafo",
      company: "snav",
      departure_time: "14:00",
      embark_port: "casamicciola",
      arrival_port: "napoli_beverello",
    });
    const context: FerryConnectionContext = {
      operationalRules: [aliscafoOnlyRule],
      ferrySchedules: [],
    };
    const leg = resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel", // nessun suffisso _aliscafo
      transportTime: "13:20",
      date: DATE,
      hotelId: null,
      zone: "forio",
      zoneRecognized: true,
      agencyName: "Aleste Viaggi",
      pax: 3,
      context,
    });
    expect(leg).toBeNull(); // nessuna regola traghetto in questa fascia, l'aliscafo è escluso

    // Conferma: con booking_service_kind esplicitamente "_aliscafo" la stessa
    // regola aliscafo DIVENTA ammissibile (comunicazione esplicita, non default).
    const legWithExplicitAliscafo = resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: "transfer_train_hotel_aliscafo",
      transportTime: "13:20",
      date: DATE,
      hotelId: null,
      zone: "forio",
      zoneRecognized: true,
      agencyName: "Aleste Viaggi",
      pax: 3,
      context,
    });
    expect(legWithExplicitAliscafo?.company).toBe("snav");
    expect(legWithExplicitAliscafo?.ferry_type).toBe("aliscafo");
  });

  it("kind non treno/volo (bus/escursione) -> null, fuori dominio (non un errore)", () => {
    const context: FerryConnectionContext = { operationalRules: [medmarCanonicalRule()], ferrySchedules: [] };
    const leg = resolveFerryLeg({
      direction: "from_ischia",
      bookingServiceKind: "bus_city_hotel",
      transportTime: "13:20",
      date: DATE,
      context,
    });
    expect(leg).toBeNull();
  });
});

describe("resolveIncomingFerryMeta — preview server-side per la NUOVA prenotazione (stesso helper del lato esistente)", () => {
  function fakeAdmin(operationalRules: OperationalPickupRule[], ferrySchedules: FerryScheduleRow[], hotelZone: string | null) {
    return {
      from(table: string) {
        if (table === "ferry_pickup_rules") {
          return { select: () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: operationalRules, error: null }).then(resolve) }) };
        }
        if (table === "ferry_schedules") {
          return { select: () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: ferrySchedules, error: null }).then(resolve) }) };
        }
        if (table === "hotels") {
          return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { zone: hotelZone }, error: null }) }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      },
    } as never;
  }

  it("4/5. riga con arrival_time (12:53) + departure_time (13:20): entrambe le gambe (outbound e return) risolte con lo stesso helper", async () => {
    const admin = fakeAdmin(
      [
        medmarCanonicalRule(), // return leg (from_ischia, 13:20)
        {
          agency_logic: "aleste",
          transport_type: "train",
          direction: "to_ischia",
          boat_type: "traghetto",
          hotel_id: null,
          zone: null,
          transport_from: "12:15",
          transport_to: "13:30",
          company: "medmar",
          departure_time: "14:20",
          embark_port: null,
          arrival_port: "ischia_porto",
          arrival_time: "15:40",
          pickup_time: null,
          valid_from: "2026-05-01",
          valid_to: "2026-09-15",
          days_of_week: null,
        }, // outbound leg (to_ischia, 12:53)
      ],
      [alilauroCoincidentalSchedule()],
      "forio"
    );

    const meta = await resolveIncomingFerryMeta(admin, {
      bookingServiceKind: "transfer_train_hotel",
      arrivalDate: "2026-09-01",
      arrivalTime: "12:53",
      departureDate: "2026-09-06",
      departureTime: "13:20",
      hotelId: "hotel-villa-teresa",
      agencyName: "Aleste Viaggi",
      pax: 3,
    });

    expect(meta.outbound).not.toBeNull();
    expect(meta.outbound?.company).toBe("MEDMAR");
    expect(meta.return).not.toBeNull();
    expect(meta.return?.company).toBe("MEDMAR");
    expect(meta.return?.company).not.toBe("ALILAURO");
  });

  it("nessuna regola canonica -> entrambe le gambe null (undetermined), mai un valore inventato", async () => {
    const admin = fakeAdmin([], [alilauroCoincidentalSchedule()], "forio");
    const meta = await resolveIncomingFerryMeta(admin, {
      bookingServiceKind: "transfer_train_hotel",
      arrivalDate: "2026-09-01",
      arrivalTime: "12:53",
      departureDate: "2026-09-06",
      departureTime: "13:20",
      hotelId: null,
      agencyName: "Aleste Viaggi",
      pax: 3,
    });
    expect(meta.outbound).toBeNull();
    expect(meta.return).toBeNull();
  });
});
