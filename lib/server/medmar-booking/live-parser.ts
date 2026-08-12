/**
 * Parsing delle risposte live Medmar.
 *
 * GET .../api/corse/{id_tratta}: schema reale CONFERMATO da risposte JSON
 * reali (Fase 1.5B) — si usano SOLO i nomi di campo reali, nessun alias
 * inventato. Risposta paginata stile Laravel: { data: [...], current_page,
 * last_page, total, ... }.
 *
 * GET .../api/biglietti/vendibili/{id_corsa}: schema reale CONFERMATO da
 * risposte JSON reali (Fase 1.6). Parsing STRETTO: ogni campo viene letto
 * dalla sua chiave reale esatta, MAI da un elenco di alias alternativi. Se
 * l'envelope della risposta non è riconoscibile (né array, né { data: [...] }),
 * il parsing fallisce esplicitamente (fail closed) — vedi schemaValid.
 *
 * Nessun valore viene mai inventato: se un campo non è presente, resta null
 * e va segnalato come warning dal chiamante (preflight.ts).
 */

import type { CorsaMedmarRaw, BigliettoVendibileRaw, MedmarPaginatedEnvelope } from "./types";

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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

function extractBigliettiRows(json: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(json)) return json as Record<string, unknown>[];
  if (json && typeof json === "object" && Array.isArray((json as Record<string, unknown>).data)) {
    return (json as Record<string, unknown>).data as Record<string, unknown>[];
  }
  return null;
}

function parseBigliettoRow(row: Record<string, unknown>): BigliettoVendibileRaw {
  return {
    id_corsa: asStringOrNumber(row.id_corsa),
    id_biglietto: asStringOrNumber(row.id_biglietto),
    id_tipologia_passeggero: asNumber(row.id_tipologia_passeggero),
    id_tariffa: asStringOrNumber(row.id_tariffa),
    id_log: asStringOrNumber(row.id_log),
    id_iva: asStringOrNumber(row.id_iva),
    id_gruppo: asStringOrNumber(row.id_gruppo),
    biglietto: asString(row.biglietto),
    prezzo: asNumber(row.prezzo),
    prezzo_prevendita: asNumber(row.prezzo_prevendita),
    quantita: asNumber(row.quantita),
    flag_ar: asString(row.flag_ar),
    flag_collegabile: asFlag(row.flag_collegabile),
    flag_targa: asFlag(row.flag_targa),
    checkin: asBoolean(row.checkin),
    re: row.re ?? null,
  };
}

/**
 * Parsa GET .../api/biglietti/vendibili/{id_corsa}. schemaValid=false se
 * l'envelope non è riconoscibile (né array, né { data: [...] }): il
 * chiamante (client.ts) deve fail-closed in quel caso, non trattare come
 * "0 biglietti". Righe singole con campi mancanti restano con quei campi a
 * null (mai un valore indovinato) — è la selezione (findArTariffAndTax) a
 * decidere se i dati disponibili bastano per can_issue.
 */
export function parseBigliettiVendibiliResponse(json: unknown): { rows: BigliettoVendibileRaw[]; schemaValid: boolean } {
  const rawRows = extractBigliettiRows(json);
  if (rawRows === null) {
    return { rows: [], schemaValid: false };
  }
  return { rows: rawRows.map(parseBigliettoRow), schemaValid: true };
}

/** id_tipologia_passeggero osservato per l'adulto sulla tariffa AR (esempio reale verificato). */
export const ADULT_TIPOLOGIA_PASSEGGERO = 1;
/** id_tipologia_passeggero osservato per la tassa di sbarco in emissioni reali. */
export const TASSA_SBARCO_TIPOLOGIA_PASSEGGERO = 32;

const AR_TARIFF_LABEL_HINT = /PASSAGGIO PONTE ADULTO.*TARIFFA SPECIALE AR/i;
const TASSA_SBARCO_HINT = /TASSA\s+DI\s+SBARCO/i;

function isRoundTripFlag(flagAr: string | null): boolean {
  return flagAr?.trim().toUpperCase() === "R";
}

export type ArTariffSelectionResult =
  | { kind: "not_found" }
  | { kind: "unsupported_passenger_type"; row: BigliettoVendibileRaw }
  | {
      kind: "found";
      tariff: BigliettoVendibileRaw;
      tassaSbarco: BigliettoVendibileRaw | null;
      /** Non-null quando una tassa di sbarco è stata individuata nella risposta ma i dati non bastano a determinarla con certezza. */
      taxIssue: "ambiguous" | "price_missing" | null;
    };

/**
 * Individua il biglietto "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" e
 * l'eventuale "TASSA DI SBARCO" tra i biglietti vendibili di una corsa.
 *
 * Fonte primaria di selezione: descrizione (biglietto) + flag_ar + tipologia
 * passeggero live — MAI un id_biglietto/id_tariffa hardcoded come regola
 * assoluta (possono cambiare tra listini/configurazioni). Gli ID live
 * vengono comunque riportati nel risultato per un'eventuale Fase 2.
 *
 * Se un candidato corrisponde per descrizione+flag_ar ma la sua tipologia
 * passeggero non è quella adulto nota (1), il gestionale contiene una
 * tipologia non ancora mappata: kind "unsupported_passenger_type", mai
 * accettata silenziosamente come adulto.
 */
export function findArTariffAndTax(rows: BigliettoVendibileRaw[]): ArTariffSelectionResult {
  const candidates = rows.filter((r) => r.biglietto && AR_TARIFF_LABEL_HINT.test(r.biglietto) && isRoundTripFlag(r.flag_ar));

  if (candidates.length === 0) {
    return { kind: "not_found" };
  }

  const adult = candidates.find((r) => r.id_tipologia_passeggero === ADULT_TIPOLOGIA_PASSEGGERO);
  if (!adult) {
    return { kind: "unsupported_passenger_type", row: candidates[0]! };
  }

  const taxMatches = rows.filter((r) => r.biglietto && TASSA_SBARCO_HINT.test(r.biglietto));
  let tassaSbarco: BigliettoVendibileRaw | null = null;
  let taxIssue: "ambiguous" | "price_missing" | null = null;

  if (taxMatches.length > 1) {
    taxIssue = "ambiguous";
  } else if (taxMatches.length === 1) {
    tassaSbarco = taxMatches[0]!;
    if (tassaSbarco.prezzo == null) {
      taxIssue = "price_missing";
    }
  }

  return { kind: "found", tariff: adult, tassaSbarco, taxIssue };
}
