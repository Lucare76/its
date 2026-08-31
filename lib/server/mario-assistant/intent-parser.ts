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
  // FASE 3 — gruppi prenotazione (READ + rimando al flusso di conferma per le WRITE).
  | { intent: "booking_group_find"; params: { query?: string; date?: string } }
  | { intent: "booking_group_detail"; params: { query?: string; date?: string } }
  | { intent: "booking_group_inspect"; params: { query?: string; date?: string } }
  | { intent: "booking_group_write"; params: { query?: string; date?: string } }
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

// FASE 3 — contesto "gruppo prenotazione": solo se presente attiviamo gli
// intent gruppo (evita che un generico "crea"/"aggiungi" senza contesto gruppo
// finisca qui invece che in write_unsupported).
const BOOKING_GROUP_CTX_RE = /\bgrupp[oi]\b|prenotazion/;
const BOOKING_GROUP_WRITE_RE =
  /\b(crea(re|mi)?|fa(mmi|i)(?!\s+veder)|aggiung(i|ere)|aggiorna(re)?|riserv(a|are)|prenot(a|are)|impost(a|are)|operativizz\w*|rendi(lo)? operativ\w*|collega(re)?|metti)\b/;
const BOOKING_GROUP_INSPECT_RE =
  /\b(pront[oi]|cosa manca|che cosa manca|manca(no)? qualcosa|operativizzabil\w*|verifica (i )?servizi|avanzament\w*|completezza|è completo|quanti pax mancano)\b/;
const BOOKING_GROUP_DETAIL_RE =
  /\b(dettagli\w*|com'?è messo|situazione del gruppo|quadro pax|pax del gruppo|riepilog\w*|fermate del gruppo|passeggeri del gruppo)\b/;
// FIX A.4.1 — solo un segnale READ esplicito autorizza booking_group_find. La
// sola presenza di un nome gruppo estratto (`query`) NON è più sufficiente:
// altrimenti una scrittura in linguaggio naturale non riconosciuta (es.
// "possiamo caricare un bus ... gruppo La Marra?") veniva rubata dal parser
// deterministico invece di passare all'LLM router (§A.4.1).
const BOOKING_GROUP_FIND_READ_RE =
  /\b(trova|cerc\w*|mostrami|fammi vedere|quale|quali|elenco|lista|esiste|dammi i dettagli)\b|c['’]è/;

/** Estrae un nome/frase di ricerca gruppo dal testo, best-effort. Ritorna
 *  undefined se non c'è nulla di utile: l'orchestratore chiederà chiarimenti,
 *  NON inventa (§23). */
export function extractBookingGroupQuery(text: string): string | undefined {
  // "... gruppo <nome> ..." / "... prenotazione <nome> ..." fino a fine stringa
  // o a un separatore. Rimuove eventuali code di verbi/parole funzione.
  const m = /(?:grupp[oi]|prenotazione)\s+(?:prenotazione\s+)?(?:di\s+|della\s+|del\s+|per\s+)?["']?([\p{L}0-9][\p{L}0-9 .'&-]{1,80}?)["']?(?:\s*[?.,;!]|$)/u.exec(text);
  if (!m) return undefined;
  let q = m[1].trim();
  q = q.replace(/\b(oggi|domani|adesso|ora|pronto|pronti|operativ\w*|completo|per favore|grazie)\b.*$/u, "").trim();
  q = q.replace(/\s{2,}/g, " ");
  return q.length >= 2 ? q : undefined;
}

export function detectMarioIntent(rawText: string, now: Date = new Date()): MarioIntentResult {
  const text = normalize(rawText);

  // FASE 3 — gruppi prenotazione: valutati PRIMA del gate WRITE_VERB_RE
  // generico, ma solo entro un contesto "gruppo/prenotazione" esplicito.
  if (BOOKING_GROUP_CTX_RE.test(text)) {
    const date = parseRelativeOrIsoDate(text, now);
    const query = extractBookingGroupQuery(text);
    const base = { ...(query ? { query } : {}), ...(date ? { date } : {}) };
    if (BOOKING_GROUP_INSPECT_RE.test(text)) return { intent: "booking_group_inspect", params: base };
    if (BOOKING_GROUP_WRITE_RE.test(text)) return { intent: "booking_group_write", params: base };
    if (BOOKING_GROUP_DETAIL_RE.test(text)) return { intent: "booking_group_detail", params: base };
    if (BOOKING_GROUP_FIND_READ_RE.test(text)) return { intent: "booking_group_find", params: base };
    // FIX A.4.1 — contesto gruppo presente ma nessun segnale READ/WRITE certo:
    // un verbo di modifica generico resta write_unsupported (rifiuto esplicito,
    // §80 sotto), qualunque altro linguaggio naturale non riconosciuto passa
    // all'LLM router via "unsupported" — MAI dedotto a booking_group_find solo
    // perché è stato estratto un nome di gruppo (§2 fix spec).
    if (WRITE_VERB_RE.test(text)) return { intent: "write_unsupported", params: {} };
    return { intent: "unsupported", params: {} };
  }

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
