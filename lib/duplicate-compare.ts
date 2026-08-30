/**
 * Confronto CAMPO | ESISTENTE | NUOVI DATI per il pannello "prenotazione già
 * esistente" dell'Inbox (app/(app)/inbox/page.tsx).
 *
 * Funzione pura, condivisa client+server e testabile in isolamento
 * (tests/unit/duplicate-compare.test.ts). Sostituisce la vecchia `diffRow`
 * inline: un campo con valore identico resta leggibile ma NON evidenziato,
 * un campo cambiato è marcato `changed:true`. `identical` è true solo quando
 * nessuna riga con un nuovo valore reale differisce dall'esistente — è il
 * segnale per il CASO 1 ("La prenotazione importata coincide con quella già
 * presente." → azione primaria "Scarta duplicato").
 */

export type DuplicateExistingSnapshot = {
  practice_number?: string | null;
  arrival_time?: string | null;
  outbound_time?: string | null;
  return_time?: string | null;
  departure_time?: string | null;
  transport_code?: string | null;
  pax?: number | null;
  phone?: string | null;
  hotel_name?: string | null;
  customer_name?: string | null;
  date?: string | null;
};

export type DuplicateIncomingSummary = {
  customer_name: string;
  date: string;
  hotel: string;
  pax: string;
  phone: string;
  agency: string;
  practice_number: string;
  arrival_time: string;
  return_time: string;
  transport_code: string;
};

export type DuplicateDiffRow = {
  /** Etichetta mostrata nella colonna CAMPO. */
  label: string;
  /** Valore attualmente a sistema (colonna ESISTENTE). */
  existing: string;
  /** Valore proveniente dalla nuova comunicazione (colonna NUOVI DATI). */
  incoming: string;
  /**
   * true = il nuovo import porta un valore reale diverso dall'esistente.
   * Non è mai true quando il nuovo valore è vuoto (assenza di dato nel PDF
   * non è una modifica) né quando i due valori coincidono.
   */
  changed: boolean;
};

export type DuplicateDiff = {
  rows: DuplicateDiffRow[];
  /** Nessun campo rilevante cambia → prenotazione importata identica. */
  identical: boolean;
  /** Solo le righe con `changed:true` (comodo per l'audit changed_fields). */
  changedLabels: string[];
};

function norm(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** Confronto "morbido" degli orari: 12:5 == 12:05 == 12.05, spazi ignorati. */
function sameTime(a: string, b: string): boolean {
  const normTime = (v: string) => {
    const m = v.replace(/\./, ":").match(/^(\d{1,2}):(\d{1,2})$/);
    return m ? `${m[1].padStart(2, "0")}:${m[2].padStart(2, "0")}` : v;
  };
  return normTime(a) === normTime(b);
}

function rowsEqual(label: string, existing: string, incoming: string): boolean {
  if (existing === incoming) return true;
  const timeLike = label === "Arrivo" || label === "Ritorno";
  if (timeLike && sameTime(existing, incoming)) return true;
  return false;
}

/**
 * Costruisce le righe del confronto. L'ordine segue lo screenshot di
 * riferimento (Pratica, Arrivo, Ritorno, Mezzo, Pax, Telefono, Hotel,
 * Cliente, Data). Una riga viene omessa solo se entrambi i valori sono vuoti.
 */
export function computeDuplicateDiff(
  existing: DuplicateExistingSnapshot,
  incoming: DuplicateIncomingSummary
): DuplicateDiff {
  const specs: Array<[string, string | number | null | undefined, string | number | null | undefined]> = [
    ["Pratica", existing.practice_number, incoming.practice_number],
    ["Arrivo", existing.arrival_time ?? existing.outbound_time, incoming.arrival_time],
    ["Ritorno", existing.return_time ?? existing.departure_time, incoming.return_time],
    ["Mezzo", existing.transport_code, incoming.transport_code],
    ["Pax", existing.pax, incoming.pax],
    ["Telefono", existing.phone, incoming.phone],
    ["Hotel", existing.hotel_name, incoming.hotel],
    ["Cliente", existing.customer_name, incoming.customer_name],
    ["Data", existing.date, incoming.date],
  ];

  const rows: DuplicateDiffRow[] = [];
  for (const [label, rawExisting, rawIncoming] of specs) {
    const e = norm(rawExisting);
    const i = norm(rawIncoming);
    if (!e && !i) continue;
    const changed = i !== "" && !rowsEqual(label, e, i);
    rows.push({ label, existing: e, incoming: i, changed });
  }

  const changedLabels = rows.filter((r) => r.changed).map((r) => r.label);
  return { rows, identical: changedLabels.length === 0, changedLabels };
}
