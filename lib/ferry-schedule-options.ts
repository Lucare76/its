export interface FerryScheduleRow {
  id?: string;
  company: string;
  departure_port: string;
  arrival_port: string;
  departure_time: string;
  direction: "ischia_to_mainland" | "mainland_to_ischia";
  days_of_week: number[] | null;
  valid_from: string | null;
  valid_to: string | null;
}

export interface FerryScheduleOption {
  time: string;
  porto: string;
}

export interface FerryArrivalMatch {
  departureTime: string;
  arrivalTime: string;
  arrivalPort: string;
  company: string;
}

function normalizeTime(value: string): string {
  return value.slice(0, 5);
}

function addMinutesToTime(rawTime: string, minutesToAdd: number): string {
  const [hoursRaw = "0", minutesRaw = "0"] = normalizeTime(rawTime).split(":");
  const totalMinutes = Number(hoursRaw) * 60 + Number(minutesRaw) + minutesToAdd;
  const hours = Math.floor((((totalMinutes % 1440) + 1440) % 1440) / 60);
  const minutes = (((totalMinutes % 1440) + 1440) % 1440) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function inferArrivalDurationMinutes(row: FerryScheduleRow): number | null {
  if (row.company === "snav") return 65;
  if (row.company === "medmar" && row.departure_port === "napoli_beverello") return 90;
  if (row.company === "medmar" && row.departure_port === "pozzuoli") return 60;
  if (row.company === "alilauro") return 70;
  return null;
}

function bookingKindToScheduleFilter(bookingKind: string | null): {
  company?: string;
  departurePort?: string;
} {
  switch (bookingKind) {
    case "formula_snav":
      return { company: "snav", departurePort: "napoli_beverello" };
    case "formula_medmar_napoli":
      return { company: "medmar", departurePort: "napoli_beverello" };
    case "formula_medmar_pozzuoli":
      return { company: "medmar", departurePort: "pozzuoli" };
    default:
      return {};
  }
}

export function ferryPortLabel(port: string): string {
  switch (port) {
    case "ischia_porto":
    case "ISCHIA PORTO":
      return "Ischia Porto";
    case "casamicciola":
    case "CASAMICCIOLA":
      return "Casamicciola";
    case "napoli_beverello":
    case "NAPOLI":
      return "Napoli Beverello";
    case "pozzuoli":
    case "POZZUOLI":
      return "Pozzuoli";
    default:
      return port
        .replaceAll("_", " ")
        .toLowerCase()
        .replace(/\b\w/g, (match) => match.toUpperCase());
  }
}

export function isScheduleActiveOnDate(row: FerryScheduleRow, isoDate: string): boolean {
  if (!isoDate) return true;
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return true;
  if (row.valid_from && isoDate < row.valid_from) return false;
  if (row.valid_to && isoDate > row.valid_to) return false;
  if (row.days_of_week?.length && !row.days_of_week.includes(date.getDay())) return false;
  return true;
}

export function buildFerryScheduleOptions(
  rows: FerryScheduleRow[],
  direction: FerryScheduleRow["direction"],
  isoDate: string,
  filters?: {
    company?: string;
    departurePort?: string;
    arrivalPort?: string;
  }
): FerryScheduleOption[] {
  return rows
    .filter((row) => row.direction === direction)
    .filter((row) => !filters?.company || row.company === filters.company)
    .filter((row) => !filters?.departurePort || row.departure_port === filters.departurePort)
    .filter((row) => !filters?.arrivalPort || row.arrival_port === filters.arrivalPort)
    .filter((row) => isScheduleActiveOnDate(row, isoDate))
    .sort((a, b) => normalizeTime(a.departure_time).localeCompare(normalizeTime(b.departure_time)))
    .map((row) => ({
      time: normalizeTime(row.departure_time),
      porto: direction === "mainland_to_ischia" ? row.arrival_port : row.departure_port,
    }));
}

export function findArrivalScheduleForService(
  rows: FerryScheduleRow[],
  isoDate: string,
  depTime: string | null,
  bookingKind: string | null
): FerryArrivalMatch | null {
  if (!depTime) return null;
  const filter = bookingKindToScheduleFilter(bookingKind);
  const time = normalizeTime(depTime);
  const match = rows.find((row) => {
    if (row.direction !== "mainland_to_ischia") return false;
    if (filter.company && row.company !== filter.company) return false;
    if (filter.departurePort && row.departure_port !== filter.departurePort) return false;
    if (normalizeTime(row.departure_time) !== time) return false;
    return isScheduleActiveOnDate(row, isoDate);
  });
  if (!match) return null;
  const durationMinutes = inferArrivalDurationMinutes(match);
  if (durationMinutes == null) return null;
  return {
    departureTime: time,
    arrivalTime: addMinutesToTime(time, durationMinutes),
    arrivalPort: match.arrival_port,
    company: match.company,
  };
}
