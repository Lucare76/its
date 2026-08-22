/**
 * Ricerca e filtro data per la lista biglietti Medmar (biglietti-medmar
 * PARTE ricerca/filtri) — sola logica pura, nessun accesso DB/rete qui,
 * stesso pattern di lib/medmar-delivery-card.ts: il componente pagina
 * costruisce i dati gia' caricati e delega qui il match, cosi' resta
 * testabile senza React/Supabase.
 *
 * Il filtro data si applica SOLO ai biglietti gia' inviati/delivered (vedi
 * matchesMedmarSentDateFilter): i gruppi non ancora inviati (pending,
 * errori, in coda) non vengono mai esclusi da questo filtro, decisione
 * presa a monte dal chiamante (biglietti-medmar/page.tsx) passando `isSent`.
 */

export type MedmarSearchableGroup = {
  key: string;
  customerName: string | null;
  hotel: string | null;
  pratica: string | null;
  phone: string | null;
  agencyName: string | null;
  allServiceIds: readonly string[];
  medmarNumero: string | null;
  medmarIdPrenotazione: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
};

/** trim + lowercase, mai crash su input non stringa. */
export function normalizeMedmarSearchTerm(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Case-insensitive, per sottostringa (funziona anche con parte del codice),
 * mai un crash su campi null: i campi null/vuoti vengono semplicemente
 * ignorati nel confronto.
 */
export function matchesMedmarSearch(group: MedmarSearchableGroup, rawQuery: string): boolean {
  const query = normalizeMedmarSearchTerm(rawQuery);
  if (!query) return true;

  const haystack: Array<string | null | undefined> = [
    group.customerName,
    group.hotel,
    group.pratica,
    group.phone,
    group.agencyName,
    group.medmarNumero,
    group.medmarIdPrenotazione,
    group.recipientEmail,
    group.recipientName,
    ...group.allServiceIds,
  ];

  return haystack.some((value) => typeof value === "string" && value.trim().length > 0 && value.toLowerCase().includes(query));
}

export type MedmarSentDateFilter = "today" | "yesterday" | "7d" | "month" | "all";

export const MEDMAR_SENT_DATE_FILTER_OPTIONS: ReadonlyArray<{ value: MedmarSentDateFilter; label: string }> = [
  { value: "today", label: "Oggi" },
  { value: "yesterday", label: "Ieri" },
  { value: "7d", label: "Ultimi 7 giorni" },
  { value: "month", label: "Questo mese" },
  { value: "all", label: "Tutti" },
];

/** Default meno invasivo: mostra gli inviati recenti senza nascondere di colpo lo storico piu' vecchio dietro un solo giorno. */
export const MEDMAR_DEFAULT_SENT_DATE_FILTER: MedmarSentDateFilter = "7d";

function addDaysToDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Date-key (YYYY-MM-DD) di un biglietto inviato: delivered_at ha sempre
 * priorita' (e' la data ufficiale di invio); updated_at e' un fallback
 * SOLO per visualizzazione/raggruppamento quando delivered_at manca — mai
 * usato per marcare qualcosa come "delivered ufficialmente".
 */
export function medmarSentDateKey(deliveredAtIso: string | null | undefined, updatedAtIso: string | null | undefined): string | null {
  const iso = deliveredAtIso ?? updatedAtIso ?? null;
  if (!iso) return null;
  const key = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/**
 * true se `dateKey` rientra nel filtro selezionato, relativo a `todayKey`
 * (entrambi YYYY-MM-DD). Un dateKey mancante non soddisfa mai un filtro
 * specifico (solo "all" lo include) — mai un valore inventato per un
 * biglietto senza data nota.
 */
export function matchesMedmarSentDateFilter(dateKey: string | null, filter: MedmarSentDateFilter, todayKey: string): boolean {
  if (filter === "all") return true;
  if (!dateKey) return false;

  if (filter === "today") return dateKey === todayKey;
  if (filter === "yesterday") return dateKey === addDaysToDateKey(todayKey, -1);
  if (filter === "7d") {
    const from = addDaysToDateKey(todayKey, -6); // include oggi: 7 giorni totali
    return dateKey >= from && dateKey <= todayKey;
  }
  if (filter === "month") return dateKey.slice(0, 7) === todayKey.slice(0, 7);
  return true;
}
