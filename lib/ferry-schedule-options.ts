export interface FerryScheduleRow {
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

function normalizeTime(value: string): string {
  return value.slice(0, 5);
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
