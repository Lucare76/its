/**
 * Parsing data/ora deterministico per Mario Assistant (Sprint 6) — nessun
 * LLM, solo pattern/keyword italiani. Sempre Europe/Rome, mai UTC ingenuo
 * (riusa romeDateKey, stessa funzione gia' esportata da operations-health.ts
 * per Sprint 5 — nessuna seconda implementazione del "oggi operativo ITS").
 */
import { romeDateKey } from "@/lib/server/operational-health/operations-health";

const ISO_DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;

/**
 * Riconosce "oggi"/"domani"/una data ISO esplicita nel testo. Ritorna
 * undefined se non trova nulla di esplicito (il chiamante applica il default
 * — solitamente "oggi" — a livello di tool, non qui).
 */
export function parseRelativeOrIsoDate(text: string, now: Date): string | undefined {
  const isoMatch = text.match(ISO_DATE_RE);
  if (isoMatch) return isoMatch[1];

  const normalized = text.toLowerCase();
  if (/\bdomani\b/.test(normalized)) {
    return romeDateKey(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  }
  if (/\boggi\b/.test(normalized)) {
    return romeDateKey(now);
  }
  return undefined;
}

const MONTHS_IT: Record<string, number> = {
  gennaio: 1, febbraio: 2, marzo: 3, aprile: 4, maggio: 5, giugno: 6,
  luglio: 7, agosto: 8, settembre: 9, sett: 9, ottobre: 10, novembre: 11, dicembre: 12,
};
const WEEKDAYS_IT: Record<string, number> = {
  // 0 = domenica … 6 = sabato (come Date.getUTCDay)
  domenica: 0, lunedì: 1, lunedi: 1, martedì: 2, martedi: 2, mercoledì: 3, mercoledi: 3,
  giovedì: 4, giovedi: 4, venerdì: 5, venerdi: 5, sabato: 6,
};

/**
 * FASE A.3 §5 — parsing data per lo slot-filling deterministico. Estende
 * `parseRelativeOrIsoDate` (ISO / "oggi" / "domani") con:
 *   - "dopodomani"
 *   - "13 settembre" / "13 sett" / "13/09" / "13-09"  → anno corrente, o anno
 *     successivo se la data sarebbe già passata (regola "prossima occorrenza")
 *   - "lunedì" / "lunedì prossimo" / … → prossima occorrenza di quel giorno
 * Ritorna "YYYY-MM-DD" (Europe/Rome) o undefined se non è affidabile.
 * Nessuna libreria: solo aritmetica su Date + `romeDateKey`.
 */
export function parseMarioSlotDate(text: string, now: Date): string | undefined {
  const base = parseRelativeOrIsoDate(text, now);
  if (base) return base;

  const t = text.toLowerCase();

  if (/\bdopodomani\b/.test(t)) {
    return romeDateKey(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000));
  }

  // FIX A.4.4 §3/§4 — data ESPLICITA completa (DD/MM/YYYY o DD-MM-YYYY): PRIMA
  // del pattern "DD/MM" senza anno sotto, perché quel pattern falliva
  // silenziosamente su un anno a 4 cifre (root cause del bug live: il
  // messaggio finiva reinterpretato dall'LLM, che ha "inventato" una data).
  // L'anno è LETTERALE: mai la regola "prossima occorrenza" (quella si
  // applica SOLO quando l'anno non è specificato, sotto). Validazione
  // calendario reale (mai un 31 febbraio silenziosamente normalizzato da JS).
  const full = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/.exec(t);
  if (full) {
    const day = Number(full[1]);
    const month = Number(full[2]);
    const year = Number(full[3]);
    if (isValidCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    // Pattern riconosciuto ma calendario impossibile (es. 31/02/2026): non è
    // un'altra data plausibile, è un errore utente — nessun fallback silenzioso,
    // si esce con undefined (il chiamante chiede di nuovo, mai un dato inventato).
    return undefined;
  }

  const todayKey = romeDateKey(now);
  const currentYear = Number(todayKey.slice(0, 4));

  // FIX A.4.4 §14 — "13 settembre 2026": mese per nome CON anno esplicito.
  // Stesso principio del pattern numerico sopra: l'anno è letterale, mai la
  // regola "prossima occorrenza" (quella si applica solo se l'anno manca).
  const dmy = /\b(\d{1,2})\s+(?:di\s+)?(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|sett|ottobre|novembre|dicembre)\s+(\d{4})\b/.exec(t);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = MONTHS_IT[dmy[2]!]!;
    const year = Number(dmy[3]);
    if (isValidCalendarDate(year, month, day)) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    return undefined;
  }

  // giorno + mese (nome o numerico "13/09"), SENZA anno → "prossima occorrenza".
  const dm =
    /\b(\d{1,2})\s+(?:di\s+)?(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|sett|ottobre|novembre|dicembre)\b/.exec(t) ??
    /\b(\d{1,2})[/-](\d{1,2})(?![/-]?\d)\b/.exec(t);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number.isNaN(Number(dm[2])) ? MONTHS_IT[dm[2]!]! : Number(dm[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const mk = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      let candidate = mk(currentYear);
      if (candidate < todayKey) candidate = mk(currentYear + 1);
      const parsed = new Date(`${candidate}T12:00:00Z`);
      if (!Number.isNaN(parsed.getTime()) && parsed.getUTCDate() === day) return candidate;
    }
  }

  // giorno della settimana ("lunedì", "lunedì prossimo"). Split su non-lettere
  // (`\b` non funziona dopo 'ì').
  const words = new Set(t.split(/[^\p{L}]+/u).filter(Boolean));
  const wdName = Object.keys(WEEKDAYS_IT).find((w) => words.has(w));
  if (wdName) {
    const target = WEEKDAYS_IT[wdName]!;
    for (let i = 1; i <= 7; i += 1) {
      const key = romeDateKey(new Date(now.getTime() + i * 24 * 60 * 60 * 1000));
      if (new Date(`${key}T12:00:00Z`).getUTCDay() === target) return key;
    }
  }

  return undefined;
}

export type TimeWindow = { fromMinutes: number; toMinutes: number; label: string };

const EXPLICIT_RANGE_RE = /\bdalle\s+(\d{1,2})(?:[:.](\d{2}))?\s+alle\s+(\d{1,2})(?:[:.](\d{2}))?\b/;

/**
 * Riconosce una finestra oraria esplicita ("dalle 15 alle 20") o una parola
 * chiave di fascia (mattina/pomeriggio/sera). Finestre di fascia documentate
 * nello sprint: mattina 06:00-12:00, pomeriggio 12:00-18:00, sera 18:00-23:59.
 * Ritorna undefined se il testo non menziona nessuna fascia — il chiamante
 * mostra allora tutti gli orari senza filtrare.
 */
export function parseTimeWindow(text: string): TimeWindow | undefined {
  const normalized = text.toLowerCase();

  const explicit = normalized.match(EXPLICIT_RANGE_RE);
  if (explicit) {
    const fromH = Number(explicit[1]);
    const fromM = explicit[2] ? Number(explicit[2]) : 0;
    const toH = Number(explicit[3]);
    const toM = explicit[4] ? Number(explicit[4]) : 0;
    if (fromH >= 0 && fromH <= 23 && toH >= 0 && toH <= 23) {
      const fromMinutes = fromH * 60 + fromM;
      const toMinutes = toH * 60 + toM;
      const label = `dalle ${pad(fromH)}:${pad(fromM)} alle ${pad(toH)}:${pad(toM)}`;
      return { fromMinutes, toMinutes, label };
    }
  }

  if (/\bmattina\b/.test(normalized)) {
    return { fromMinutes: 6 * 60, toMinutes: 12 * 60, label: "mattina (06:00–12:00)" };
  }
  if (/\bpomeriggio\b/.test(normalized)) {
    return { fromMinutes: 12 * 60, toMinutes: 18 * 60, label: "pomeriggio (12:00–18:00)" };
  }
  if (/\bsera\b/.test(normalized)) {
    return { fromMinutes: 18 * 60, toMinutes: 23 * 60 + 59, label: "sera (18:00–23:59)" };
  }

  return undefined;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** FIX A.4.4 §4 — vero se {year,month,day} è una data di calendario REALE
 *  (rifiuta 31 febbraio, 29 febbraio in anno non bisestile, giorno 0/32…),
 *  mai la normalizzazione silenziosa di `new Date()` (che farebbe "31 feb" ->
 *  "3 mar"). `Date.UTC` con componenti fuori range trabocca sul mese/giorno
 *  successivo: qui lo si rileva confrontando i componenti tornati indietro. */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1000 || year > 9999) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/**
 * FIX A.4.4 §1/§2/§10 — CONTRATTO DATE Mario: internamente/DB/MCP sempre
 * "YYYY-MM-DD", ma l'utente vede SEMPRE "DD-MM-YYYY" (mai lo YYYY-MM-DD
 * interno, mai lo slash "DD/MM/YYYY" usato da altri formatter ITS non-Mario,
 * es. `fmtDateIt` in lib/mcp/tools/booking-groups/read.ts — quello resta
 * invariato per gli altri consumatori, Mario applica SEMPRE questa funzione
 * prima di mostrare una data all'utente). `null`/`undefined`/ISO non valido
 * -> null (mai un testo troncato o parzialmente sbagliato).
 */
export function formatMarioDateForUser(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "HH:MM[:SS]" -> minuti dalla mezzanotte, o null se il formato non e' valido. */
export function timeStringToMinutes(time: string | null | undefined): number | null {
  const match = String(time ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
