/**
 * Intent parser deterministico per Mario Assistant (Sprint 6) — nessun LLM,
 * solo keyword/pattern italiani. Vedi spec sprint: solo una piccola classe
 * di intent supportati, mai un guess rischioso — testo non riconosciuto ->
 * "unsupported".
 */
import { parseRelativeOrIsoDate, parseTimeWindow, type TimeWindow } from "./date-time";

export type MarioIntentResult =
  | { intent: "operational_brief"; params: { date?: string } }
  | { intent: "health_status"; params: Record<string, never> }
  | { intent: "alerts"; params: { severity?: "warning" | "critical" | "all" } }
  | { intent: "unassigned"; params: { date?: string } }
  | { intent: "driver_availability"; params: { date?: string; timeWindow?: TimeWindow } }
  | { intent: "assignment_plan"; params: { date?: string } }
  | { intent: "assignment_exceptions"; params: { date?: string } }
  | { intent: "write_unsupported"; params: Record<string, never> }
  | { intent: "unsupported"; params: Record<string, never> };

/**
 * Verbi di modifica (stessa lista concettuale delle "AZIONI NON CONSENTITE"
 * di Sprint 4): se il messaggio li contiene, non tentiamo MAI di riconoscere
 * un intent READ sottostante — meglio il rifiuto esplicito che un'azione
 * indovinata.
 */
const WRITE_VERB_RE =
  /\b(assegna(re)?|riassegna(re)?|cambia(re)?\s+stato|sposta(re)?|cancella(re)?|rimuovi(re)?|modifica(re)?|riprova|reinvia(re)?|correggi(re)?|risolvi(re)?|rigenera(re)?|ripristina(re)?)\b/;

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

export function detectMarioIntent(rawText: string, now: Date = new Date()): MarioIntentResult {
  const text = normalize(rawText);

  if (WRITE_VERB_RE.test(text)) {
    return { intent: "write_unsupported", params: {} };
  }

  // Health status — vocabolario tecnico/sistema, controllato per primo
  // perche' e' il piu' specifico (evita che "problemi" da solo finisca qui).
  if (/\bfunzion|tecnic|salute (del )?sistema|come sta (il )?(sistema|its)|its\s+(va|sta)\b/.test(text)) {
    return { intent: "health_status", params: {} };
  }

  // Piano di assegnazione intelligente — controllato prima di operational_brief
  // perche' "piano/assegnazioni" e' piu' specifico di "giornata/situazione".
  if (/\b(piano (di assegnazione|automatico)|prepara(mi)?\s+(il piano|le assegnazioni)|assegnazioni di (oggi|domani|domenica|lunedì|lunedi|martedì|martedi|mercoledì|mercoledi|giovedì|giovedi|venerdì|venerdi|sabato))\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    return { intent: "assignment_plan", params: date ? { date } : {} };
  }
  if (/\b(eccezion|solo (i |le )?(servizi )?(non risolt|da verificare|da risolvere|review))\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    return { intent: "assignment_exceptions", params: date ? { date } : {} };
  }

  // Operational brief — richiede un contesto esplicito di "giornata".
  if (/\bcome siamo|punto della giornata|situazione (di )?oggi|situazione operativa|giornata\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    return { intent: "operational_brief", params: date ? { date } : {} };
  }
  if (/\bproblemi\b/.test(text) && /\boggi\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    return { intent: "operational_brief", params: date ? { date } : {} };
  }

  // Alerts — vocabolario esplicito di attenzione/urgenza, oppure "problemi"
  // generico non altrimenti disambiguato (fallback, vedi spec test 3).
  if (/\battenzione|allert|alert|critici|critico|urgente/.test(text)) {
    const severity: "warning" | "critical" | "all" | undefined = /\bcritic/.test(text) ? "critical" : /\bwarning|attenzione media/.test(text) ? "warning" : undefined;
    return { intent: "alerts", params: severity ? { severity } : {} };
  }
  if (/\bproblemi\b/.test(text)) {
    return { intent: "alerts", params: {} };
  }

  // Servizi senza autista.
  if (/\bsenza autist|non assegnat|unassigned\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    return { intent: "unassigned", params: date ? { date } : {} };
  }

  // Disponibilita' autisti.
  if (/\bdisponibil|chi è libero|chi e libero|chi posso usare|autisti liberi|chi c'è (oggi|domani)\b/.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    const timeWindow = parseTimeWindow(text);
    return { intent: "driver_availability", params: { ...(date ? { date } : {}), ...(timeWindow ? { timeWindow } : {}) } };
  }

  return { intent: "unsupported", params: {} };
}

export const UNSUPPORTED_ANSWER =
  "Questa richiesta non è ancora supportata. Posso aiutarti con situazione della giornata, salute sistema, alert, servizi senza autista, disponibilità autisti, piano di assegnazione intelligente ed eccezioni del piano.";

export const WRITE_UNSUPPORTED_ANSWER =
  "Le operazioni di modifica richiedono ancora il flusso di conferma MCP e non sono disponibili in questa interfaccia.";
