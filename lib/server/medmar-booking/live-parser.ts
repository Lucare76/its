/**
 * Parsing delle risposte live Medmar.
 *
 * GET .../api/corse/{id_tratta}: schema reale CONFERMATO da risposte JSON
 * reali (Fase 1.5B) — si usano SOLO i nomi di campo reali, nessun alias
 * inventato. Risposta paginata stile Laravel: { data: [...], current_page,
 * last_page, total, ... }.
 *
 * GET .../api/biglietti/vendibili/{id_corsa}: schema NON ancora confermato
 * da una risposta reale in questa fase — resta parsing permissivo
 * multi-chiave (stesso pattern di lib/server/radius-adapter.ts), da
 * restringere quando anche questo endpoint sarà verificato.
 *
 * Nessun valore viene mai inventato: se un campo non è presente, resta null
 * e va segnalato come warning dal chiamante (preflight.ts).
 */

import type { CorsaMedmarRaw, BigliettoVendibileRaw, MedmarPaginatedEnvelope } from "./types";

function asArray(json: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    for (const key of keys) {
      const val = (json as Record<string, unknown>)[key];
      if (Array.isArray(val)) return val;
    }
  }
  return [];
}

function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

function asStringOrNumber(value: unknown): number | string | null {
  if (typeof value === "number" || typeof value === "string") return value;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asFlag(value: unknown): boolean | number | null {
  if (typeof value === "boolean" || typeof value === "number") return value;
  return null;
}

function parseCorsaRow(row: Record<string, unknown>): CorsaMedmarRaw {
  return {
    id_corsa: asStringOrNumber(row.id_corsa),
    id_tratta: asNumber(row.id_tratta),
    partenza_data: asString(row.partenza_data),
    partenza_ora: asString(row.partenza_ora),
    flag_chiuso: asFlag(row.flag_chiuso),
    flag_sospeso: asFlag(row.flag_sospeso),
    id_porto_partenza: asNumber(row.id_porto_partenza),
    id_porto_arrivo: asNumber(row.id_porto_arrivo),
    porto_partenza: asString(row.porto_partenza),
    porto_arrivo: asString(row.porto_arrivo),
    nave: asString(row.nave),
  };
}

/**
 * Estrae righe corsa e metadati di paginazione da una singola pagina della
 * risposta GET .../api/corse/{id_tratta}. Se l'envelope di paginazione non è
 * riconoscibile (risposta malformata), pagination è null e il chiamante deve
 * trattarla come pagina unica (nessun crash, nessuna pagina inventata).
 */
export function parseCorsePage(json: unknown): { rows: CorsaMedmarRaw[]; pagination: { currentPage: number | null; lastPage: number | null; total: number | null } | null } {
  if (!json || typeof json !== "object" || !Array.isArray((json as Record<string, unknown>).data)) {
    return { rows: [], pagination: null };
  }
  const envelope = json as MedmarPaginatedEnvelope<Record<string, unknown>>;
  const rows = envelope.data.map(parseCorsaRow);
  const currentPage = asNumber(envelope.current_page);
  const lastPage = asNumber(envelope.last_page);
  const total = asNumber(envelope.total);
  const pagination = currentPage === null && lastPage === null && total === null ? null : { currentPage, lastPage, total };
  return { rows, pagination };
}

export function parseBigliettiVendibiliResponse(json: unknown): BigliettoVendibileRaw[] {
  const rows = asArray(json, "biglietti", "data", "results", "items") as Record<string, unknown>[];
  return rows.map((row) => {
    const rawPrice = pick(row, "prezzo", "prezzo_cents", "price", "importo");
    const priceNumber = typeof rawPrice === "number" ? rawPrice : typeof rawPrice === "string" ? Number(rawPrice.replace(",", ".")) : null;
    // Se il valore sembra già espresso in centesimi (intero grande) lo si
    // lascia come tale è impossibile saperlo con certezza senza una risposta
    // reale: qui si assume EURO (come da esempio "10.25" osservato nella
    // memoria ticket esistente) e si converte in centesimi.
    const priceCents = priceNumber !== null && Number.isFinite(priceNumber) ? Math.round(priceNumber * 100) : null;

    return {
      id_biglietto: asStringOrNumber(pick(row, "id_biglietto", "idBiglietto")),
      id_tariffa: asStringOrNumber(pick(row, "id_tariffa", "idTariffa")),
      label: asString(pick(row, "label", "descrizione", "tariffa_label", "nome")),
      prezzo_cents: priceCents,
    };
  });
}

export type ArTariffMatch = {
  tariff: BigliettoVendibileRaw | null;
  tassaSbarco: BigliettoVendibileRaw | null;
};

const AR_TARIFF_LABEL_HINT = /PASSAGGIO PONTE ADULTO.*TARIFFA SPECIALE AR/i;
const TASSA_SBARCO_HINT = /TASSA\s+DI\s+SBARCO/i;

/**
 * Individua la tariffa "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" e
 * l'eventuale riga collegata "TASSA DI SBARCO" tra i biglietti vendibili
 * restituiti da Medmar. Match primario sul label; id_biglietto=370/id_tariffa=6
 * (osservati realmente in un esempio) sono usati solo come conferma
 * secondaria, MAI come unico criterio (potrebbero non essere invarianti).
 */
export function findArTariffAndTax(rows: BigliettoVendibileRaw[]): ArTariffMatch {
  const tariff =
    rows.find((r) => r.label && AR_TARIFF_LABEL_HINT.test(r.label)) ??
    rows.find((r) => String(r.id_biglietto) === "370" && String(r.id_tariffa) === "6") ??
    null;

  const tassaSbarco = rows.find((r) => r.label && TASSA_SBARCO_HINT.test(r.label)) ?? null;

  return { tariff, tassaSbarco };
}
