const ROME_TIME_ZONE = "Europe/Rome";
const OPEN_MINUTES = 9 * 60;
const CLOSE_MINUTES = 19 * 60 + 30;

type RomeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
};

export type WhatsAppOfficeHoursStatus = {
  isOpen: boolean;
  isSunday: boolean;
  result: "in_orario" | "fuori_orario";
  closureWindowKey: string | null;
  timestampUtc: string;
  timestampEuropeRome: string;
  timeZone: typeof ROME_TIME_ZONE;
};

function formatter(options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: ROME_TIME_ZONE,
    ...options,
  });
}

const partsFormatter = formatter({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const displayFormatter = formatter({
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function parseRomeParts(date: Date): RomeParts {
  const values = Object.fromEntries(partsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: String(values.weekday),
  };
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function localDateKey(parts: Pick<RomeParts, "year" | "month" | "day">) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function addLocalDays(parts: Pick<RomeParts, "year" | "month" | "day">, days: number) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function weekdayIndex(weekday: string) {
  const normalized = weekday.toLowerCase();
  if (normalized.startsWith("mon")) return 1;
  if (normalized.startsWith("tue")) return 2;
  if (normalized.startsWith("wed")) return 3;
  if (normalized.startsWith("thu")) return 4;
  if (normalized.startsWith("fri")) return 5;
  if (normalized.startsWith("sat")) return 6;
  return 0;
}

function closureStartDate(parts: RomeParts) {
  const weekday = weekdayIndex(parts.weekday);
  const minutes = parts.hour * 60 + parts.minute;

  if (weekday === 0) {
    return addLocalDays(parts, -1);
  }

  if (minutes < OPEN_MINUTES) {
    return weekday === 1 ? addLocalDays(parts, -2) : addLocalDays(parts, -1);
  }

  return { year: parts.year, month: parts.month, day: parts.day };
}

export function getWhatsAppOfficeHoursStatus(input: Date | string): WhatsAppOfficeHoursStatus {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid timestamp for WhatsApp office hours check");
  }

  const parts = parseRomeParts(date);
  const weekday = weekdayIndex(parts.weekday);
  const minutes = parts.hour * 60 + parts.minute;
  const isSunday = weekday === 0;
  const isOpen = !isSunday && weekday >= 1 && weekday <= 6 && minutes >= OPEN_MINUTES && minutes < CLOSE_MINUTES;
  const startDate = isOpen ? null : closureStartDate(parts);
  const closureWindowKey = startDate
    ? `office_closed:${localDateKey(startDate)}T19:30:00+Europe/Rome`
    : null;

  return {
    isOpen,
    isSunday,
    result: isOpen ? "in_orario" : "fuori_orario",
    closureWindowKey,
    timestampUtc: date.toISOString(),
    timestampEuropeRome: `${displayFormatter.format(date).replace(",", "")} Europe/Rome`,
    timeZone: ROME_TIME_ZONE,
  };
}

export const WHATSAPP_OFFICE_CLOSED_AUTO_REPLY_TEXT = `Ciao 👋

Ti informiamo che i nostri uffici sono aperti dal lunedì al sabato dalle 09:00 alle 19:30.

Abbiamo ricevuto il tuo messaggio e ti risponderemo non appena possibile durante l’orario di apertura.

Ischia Transfer Service`;
