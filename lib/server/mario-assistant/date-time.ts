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

/** "HH:MM[:SS]" -> minuti dalla mezzanotte, o null se il formato non e' valido. */
export function timeStringToMinutes(time: string | null | undefined): number | null {
  const match = String(time ?? "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
