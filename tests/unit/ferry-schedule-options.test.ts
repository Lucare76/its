import { describe, expect, it } from "vitest";
import { findArrivalScheduleForService, findDepartureScheduleForService, type FerryScheduleRow } from "@/lib/ferry-schedule-options";

const rows: FerryScheduleRow[] = [
  {
    company: "snav",
    departure_port: "napoli_beverello",
    arrival_port: "casamicciola",
    departure_time: "08:30:00",
    direction: "mainland_to_ischia",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
  },
  {
    company: "medmar",
    departure_port: "napoli_beverello",
    arrival_port: "ischia_porto",
    departure_time: "14:20:00",
    direction: "mainland_to_ischia",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
  },
  {
    company: "medmar",
    departure_port: "pozzuoli",
    arrival_port: "casamicciola",
    departure_time: "12:00:00",
    direction: "mainland_to_ischia",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
  },
  {
    company: "medmar",
    departure_port: "ischia_porto",
    arrival_port: "napoli_beverello",
    departure_time: "17:00:00",
    direction: "ischia_to_mainland",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
  },
  {
    company: "medmar",
    departure_port: "casamicciola",
    arrival_port: "pozzuoli",
    departure_time: "16:50:00",
    direction: "ischia_to_mainland",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
  },
];

describe("findArrivalScheduleForService", () => {
  it("usa ferry_schedules per SNAV e calcola l'arrivo senza lookup hardcoded per orario", () => {
    const result = findArrivalScheduleForService(rows, "2026-04-26", "08:30", "formula_snav");
    expect(result).toEqual({
      company: "snav",
      departureTime: "08:30",
      arrivalTime: "09:35",
      arrivalPort: "casamicciola",
    });
  });

  it("distingue Medmar Napoli da Medmar Pozzuoli usando il booking kind", () => {
    const fromNaples = findArrivalScheduleForService(rows, "2026-04-26", "14:20", "formula_medmar_napoli");
    const fromPozzuoli = findArrivalScheduleForService(rows, "2026-04-26", "12:00", "formula_medmar_pozzuoli");

    expect(fromNaples?.arrivalTime).toBe("15:50");
    expect(fromNaples?.arrivalPort).toBe("ischia_porto");
    expect(fromPozzuoli?.arrivalTime).toBe("13:00");
    expect(fromPozzuoli?.arrivalPort).toBe("casamicciola");
  });
});

describe("findDepartureScheduleForService", () => {
  it("per una partenza usa il primo traghetto utile dopo il prelievo hotel", () => {
    const result = findDepartureScheduleForService(rows, "2026-05-02", "15:30", "formula_medmar_napoli");

    expect(result).toEqual({
      company: "medmar",
      departureTime: "17:00",
      departurePort: "ischia_porto",
      arrivalPort: "napoli_beverello",
    });
  });

  it("distingue il porto di partenza in base alla destinazione mainland", () => {
    const result = findDepartureScheduleForService(rows, "2026-05-02", "15:30", "formula_medmar_pozzuoli");

    expect(result?.departureTime).toBe("16:50");
    expect(result?.departurePort).toBe("casamicciola");
    expect(result?.arrivalPort).toBe("pozzuoli");
  });
});
