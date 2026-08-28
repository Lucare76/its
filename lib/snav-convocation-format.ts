// Pure date/time formatters for SNAV convocations.
//
// Excel cells parsed with `cellDates:true` surface as native JS Date
// objects — including for time-only cells, which xlsx anchors at the Excel
// epoch (30/12/1899). Naively stringifying those Date objects produces
// garbage like "Sat Dec 30 1899 10:00:00 GMT+0100 (...)" in the UI and in
// the WhatsApp message itself. These functions are the single place where
// a raw Excel cell value (Date | numeric serial | string) is turned into a
// display string — never a timestamp, never a timezone, never "1899".
//
// A SNAV departure date is a civil date, not an instant: all arithmetic
// here operates on (year, month, day) triples, never on epoch milliseconds
// interpreted through a timezone, so DST/UTC can't shift the day.
//
// Self-contained (mirrors lib/medmar-convocation-format.ts) so SNAV never
// depends on the MEDMAR module and the two can't drift each other.

const WEEKDAYS_IT = ["DOMENICA", "LUNEDÌ", "MARTEDÌ", "MERCOLEDÌ", "GIOVEDÌ", "VENERDÌ", "SABATO"];
const MONTHS_IT = [
  "GENNAIO", "FEBBRAIO", "MARZO", "APRILE", "MAGGIO", "GIUGNO",
  "LUGLIO", "AGOSTO", "SETTEMBRE", "OTTOBRE", "NOVEMBRE", "DICEMBRE",
];

type DateParts = { y: number; m: number; d: number };

// Excel's date epoch is 30/12/1899 (with the historical leap-year bug baked
// in). Converting a serial via UTC epoch arithmetic never touches local time.
function excelSerialToDateParts(serial: number): DateParts {
  const epochUtcMs = Date.UTC(1899, 11, 30);
  const ms = epochUtcMs + Math.round(serial) * 86_400_000;
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

function resolveDateParts(value: unknown): DateParts | null {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return { y: value.getFullYear(), m: value.getMonth() + 1, d: value.getDate() };
  }
  if (typeof value === "number" && isFinite(value) && value > 1) {
    return excelSerialToDateParts(value);
  }

  const s = String(value ?? "").trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };

  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (m) return { y: Number(m[3]), m: Number(m[2]), d: Number(m[1]) };

  return null;
}

// "DOMENICA 30 AGOSTO" — Italian weekday + zero-padded day + Italian month,
// uppercase to match the approved partenze_snav template body. Falls back to
// the trimmed raw string when the value can't be parsed as a date.
export function formatSnavDepartureDate(value: unknown): string {
  const parts = resolveDateParts(value);
  if (!parts) return typeof value === "string" ? value.trim() : "";
  const weekdayIdx = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  const dd = String(parts.d).padStart(2, "0");
  return `${WEEKDAYS_IT[weekdayIdx]} ${dd} ${MONTHS_IT[parts.m - 1]}`;
}

// Canonical YYYY-MM-DD form of the same value, for storage/filtering
// (dedup, WhatsApp daily log by departure day) — never displayed to the user.
export function parseSnavDepartureDateIso(value: unknown): string | null {
  const parts = resolveDateParts(value);
  if (!parts) return null;
  return `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.d).padStart(2, "0")}`;
}

// Always "HH:mm" — handles Date objects anchored at the Excel epoch, Excel
// time serials (fraction of a day), and "16:40"/"16.40" strings. Never
// emits "1899", "GMT", a timezone, or seconds.
export function formatSnavTime(value: unknown): string {
  if (value instanceof Date && !isNaN(value.getTime())) {
    const hh = String(value.getHours()).padStart(2, "0");
    const mm = String(value.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  if (typeof value === "number" && isFinite(value)) {
    const fraction = value < 1 ? value : value - Math.floor(value);
    const totalMinutes = Math.round(fraction * 24 * 60) % (24 * 60);
    const hh = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    const mm = String(totalMinutes % 60).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  return s;
}
