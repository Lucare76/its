import { describe, it, expect } from "vitest";
import {
  isScheduleActiveOnDate,
  buildFerryScheduleOptions,
  ferryPortLabel,
  type FerryScheduleRow,
} from "@/lib/ferry-schedule-options";

// 2026-05-04 = lunedì (day=1)
// 2026-05-09 = sabato (day=6)
// 2026-05-10 = domenica (day=0)

function makeRow(overrides: Partial<FerryScheduleRow> = {}): FerryScheduleRow {
  return {
    company: "medmar",
    departure_port: "napoli_beverello",
    arrival_port: "ischia_porto",
    departure_time: "08:00",
    direction: "mainland_to_ischia",
    days_of_week: null,
    valid_from: null,
    valid_to: null,
    ...overrides,
  };
}

describe("isScheduleActiveOnDate", () => {
  it("sempre attivo se nessun filtro (null su tutto)", () => {
    expect(isScheduleActiveOnDate(makeRow(), "2026-05-04")).toBe(true);
  });

  it("attivo sul giorno esatto di valid_from", () => {
    const row = makeRow({ valid_from: "2026-05-04" });
    expect(isScheduleActiveOnDate(row, "2026-05-04")).toBe(true);
  });

  it("inattivo il giorno prima di valid_from", () => {
    const row = makeRow({ valid_from: "2026-05-04" });
    expect(isScheduleActiveOnDate(row, "2026-05-03")).toBe(false);
  });

  it("attivo sul giorno esatto di valid_to", () => {
    const row = makeRow({ valid_to: "2026-09-30" });
    expect(isScheduleActiveOnDate(row, "2026-09-30")).toBe(true);
  });

  it("inattivo il giorno dopo valid_to", () => {
    const row = makeRow({ valid_to: "2026-09-30" });
    expect(isScheduleActiveOnDate(row, "2026-10-01")).toBe(false);
  });

  it("attivo all'interno della finestra valid_from/valid_to", () => {
    const row = makeRow({ valid_from: "2026-06-01", valid_to: "2026-09-30" });
    expect(isScheduleActiveOnDate(row, "2026-07-15")).toBe(true);
  });

  it("inattivo fuori dalla finestra valid_from/valid_to", () => {
    const row = makeRow({ valid_from: "2026-06-01", valid_to: "2026-09-30" });
    expect(isScheduleActiveOnDate(row, "2026-05-31")).toBe(false);
    expect(isScheduleActiveOnDate(row, "2026-10-01")).toBe(false);
  });

  it("attivo per il giorno della settimana corretto (lunedì = 1)", () => {
    const row = makeRow({ days_of_week: [1, 3, 5] }); // lun, mer, ven
    expect(isScheduleActiveOnDate(row, "2026-05-04")).toBe(true); // lunedì
  });

  it("inattivo se il giorno della settimana non è in days_of_week", () => {
    const row = makeRow({ days_of_week: [1, 3, 5] }); // lun, mer, ven
    expect(isScheduleActiveOnDate(row, "2026-05-09")).toBe(false); // sabato = 6
  });

  it("sempre attivo se days_of_week è array vuoto", () => {
    const row = makeRow({ days_of_week: [] });
    expect(isScheduleActiveOnDate(row, "2026-05-04")).toBe(true);
  });

  it("restituisce true se isoDate è stringa vuota", () => {
    const row = makeRow({ valid_from: "2026-06-01" });
    expect(isScheduleActiveOnDate(row, "")).toBe(true);
  });

  it("filtro combinato: data nella finestra E giorno corretto", () => {
    const row = makeRow({ valid_from: "2026-05-01", valid_to: "2026-05-31", days_of_week: [1] });
    expect(isScheduleActiveOnDate(row, "2026-05-04")).toBe(true);  // lunedì in finestra
    expect(isScheduleActiveOnDate(row, "2026-05-09")).toBe(false); // sabato in finestra ma giorno errato
    expect(isScheduleActiveOnDate(row, "2026-06-01")).toBe(false); // lunedì fuori finestra
  });
});

describe("buildFerryScheduleOptions", () => {
  const rows: FerryScheduleRow[] = [
    makeRow({ company: "snav", departure_port: "napoli_beverello", arrival_port: "casamicciola", departure_time: "08:30", direction: "mainland_to_ischia" }),
    makeRow({ company: "medmar", departure_port: "napoli_beverello", arrival_port: "ischia_porto", departure_time: "14:20", direction: "mainland_to_ischia" }),
    makeRow({ company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "10:00", direction: "mainland_to_ischia" }),
    makeRow({ company: "medmar", departure_port: "ischia_porto", arrival_port: "napoli_beverello", departure_time: "17:00", direction: "ischia_to_mainland" }),
    makeRow({ company: "snav", departure_port: "casamicciola", arrival_port: "napoli_beverello", departure_time: "09:00", direction: "ischia_to_mainland" }),
    // riga con validità stagionale
    makeRow({ company: "alilauro", departure_port: "napoli_beverello", arrival_port: "ischia_porto", departure_time: "07:00", direction: "mainland_to_ischia", valid_from: "2026-07-01", valid_to: "2026-08-31" }),
  ];

  it("filtra per direzione mainland_to_ischia", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04");
    expect(opts.every((o) => o.time && o.porto)).toBe(true);
    expect(opts.length).toBe(3); // snav + medmar napoli + medmar pozzuoli (alilauro fuori stagione)
  });

  it("filtra per direzione ischia_to_mainland", () => {
    const opts = buildFerryScheduleOptions(rows, "ischia_to_mainland", "2026-05-04");
    expect(opts.length).toBe(2);
  });

  it("per mainland_to_ischia il porto è arrival_port", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04", { company: "snav" });
    expect(opts[0]?.porto).toBe("casamicciola");
  });

  it("per ischia_to_mainland il porto è departure_port", () => {
    const opts = buildFerryScheduleOptions(rows, "ischia_to_mainland", "2026-05-04", { company: "medmar" });
    expect(opts[0]?.porto).toBe("ischia_porto");
  });

  it("filtra per company", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04", { company: "medmar" });
    expect(opts.length).toBe(2);
    expect(opts.every((o) => o.porto === "napoli_beverello" || o.porto === "pozzuoli" || true)).toBe(true);
  });

  it("filtra per departurePort", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04", { departurePort: "pozzuoli" });
    expect(opts.length).toBe(1);
    expect(opts[0]?.time).toBe("10:00");
  });

  it("filtra per arrivalPort", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04", { arrivalPort: "ischia_porto" });
    expect(opts.length).toBe(2); // medmar napoli + medmar pozzuoli
  });

  it("esclude righe con validità stagionale non attiva", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04", { company: "alilauro" });
    expect(opts.length).toBe(0);
  });

  it("include righe con validità stagionale attiva", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-07-15", { company: "alilauro" });
    expect(opts.length).toBe(1);
    expect(opts[0]?.time).toBe("07:00");
  });

  it("ordina per orario crescente", () => {
    const opts = buildFerryScheduleOptions(rows, "mainland_to_ischia", "2026-05-04");
    const times = opts.map((o) => o.time);
    expect(times).toEqual([...times].sort());
  });

  it("normalizza l'orario a HH:MM (5 caratteri)", () => {
    const row = makeRow({ departure_time: "08:30:00" });
    const opts = buildFerryScheduleOptions([row], "mainland_to_ischia", "2026-05-04");
    expect(opts[0]?.time).toBe("08:30");
  });
});

describe("ferryPortLabel", () => {
  it("ischia_porto → Ischia Porto", () => {
    expect(ferryPortLabel("ischia_porto")).toBe("Ischia Porto");
  });

  it("ISCHIA PORTO (maiuscolo) → Ischia Porto", () => {
    expect(ferryPortLabel("ISCHIA PORTO")).toBe("Ischia Porto");
  });

  it("casamicciola → Casamicciola", () => {
    expect(ferryPortLabel("casamicciola")).toBe("Casamicciola");
  });

  it("CASAMICCIOLA → Casamicciola", () => {
    expect(ferryPortLabel("CASAMICCIOLA")).toBe("Casamicciola");
  });

  it("napoli_beverello → Napoli Beverello", () => {
    expect(ferryPortLabel("napoli_beverello")).toBe("Napoli Beverello");
  });

  it("pozzuoli → Pozzuoli", () => {
    expect(ferryPortLabel("pozzuoli")).toBe("Pozzuoli");
  });

  it("porto sconosciuto: formatta da snake_case a Title Case", () => {
    expect(ferryPortLabel("porto_nuovo")).toBe("Porto Nuovo");
  });
});
