/**
 * Parsing delle risposte live Medmar.
 *
 * Fase 2A.2 — schema REALE riallineato dopo lo smoke test reale (Fase 2A.1),
 * che ha dimostrato che lo schema Fase 1.5B/1.6 non era mai stato verificato
 * contro l'envelope corretto. Tutte le risposte reali Medmar osservate
 * (login, GET corse, GET biglietti/vendibili) condividono lo stesso
 * envelope esterno: { return: true, output: ... } (vedi MedmarApiEnvelope
 * in types.ts, e lo stesso pattern già usato da medmar-auth-provider.ts).
 *
 * GET .../api/corse/{id_tratta}: righe in output.data (stile paginazione
 * Laravel, ma annidato sotto output — { return, output: { data: [...],
 * current_page, last_page, total, ... } }).
 *
 * GET .../api/biglietti/vendibili/{id_corsa}: array DIRETTO sotto output
 * ({ return, output: [...] }), non output.data.
 *
 * Parsing STRETTO su entrambi: return !== true, output mancante/malformato,
 * o l'array atteso (output.data / output) non essendo un array producono
 * SEMPRE schemaValid=false con un motivo (schemaError) — mai [] silenzioso.
 * Uno schema incompatibile deve restare distinguibile da "nessuna riga
 * trovata" (envelope valido, array vuoto): quest'ultimo è l'UNICO caso in
 * cui rows=[] è accompagnato da schemaValid=true.
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

/**
 * Valida l'envelope esterno comune { return: true, output }. Ritorna
 * l'`output` grezzo se valido, altrimenti un motivo di fallimento esplicito
 * (mai un valore indovinato). Stesso criterio stretto già usato per
 * /authenticate (return === true, confronto stretto).
 */
function validateApiEnvelope(json: unknown): { valid: true; output: unknown } | { valid: false; error: string } {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { valid: false, error: "envelope_not_object" };
  }
  const obj = json as Record<string, unknown>;
  if (obj.return !== true) {
    return { valid: false, error: "return_not_true" };
  }
  if (!("output" in obj) || obj.output === undefined || obj.output === null) {
    return { valid: false, error: "output_missing" };
  }
  return { valid: true, output: obj.output };
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
 * Estrae righe corsa e metadati di paginazione dalla risposta reale GET
 * .../api/corse/{id_tratta} ({ return: true, output: { data: [...],
 * current_page, last_page, total } }). schemaValid=false (con schemaError)
 * per QUALUNQUE envelope non riconosciuto — incluso il vecchio formato Fase
 * 1.5B { data: [...] } a livello radice, che NON è mai stato reale e non
 * deve più essere accettato. Il chiamante (client.ts) deve fail-closed su
 * schemaValid=false, mai trattarlo come "nessuna corsa".
 */
export function parseCorsePage(json: unknown): {
  rows: CorsaMedmarRaw[];
  pagination: { currentPage: number | null; lastPage: number | null; total: number | null } | null;
  schemaValid: boolean;
  schemaError: string | null;
} {
  const envelope = validateApiEnvelope(json);
  if (!envelope.valid) {
    return { rows: [], pagination: null, schemaValid: false, schemaError: envelope.error };
  }

  const output = envelope.output;
  if (!output || typeof output !== "object" || Array.isArray(output) || !Array.isArray((output as Record<string, unknown>).data)) {
    return { rows: [], pagination: null, schemaValid: false, schemaError: "output_data_not_array" };
  }

  const payload = output as MedmarPaginatedEnvelope<Record<string, unknown>>;
  const rows = payload.data.map(parseCorsaRow);
  const currentPage = asNumber(payload.current_page);
  const lastPage = asNumber(payload.last_page);
  const total = asNumber(payload.total);
  const pagination = currentPage === null && lastPage === null && total === null ? null : { currentPage, lastPage, total };
  return { rows, pagination, schemaValid: true, schemaError: null };
}

function parseBigliettoRow(row: Record<string, unknown>): BigliettoVendibileRaw {
  return {
    id_corsa: asStringOrNumber(row.id_corsa),
    id_biglietto: asStringOrNumber(row.id_biglietto),
    id_tipologia_passeggero: asNumber(row.id_tipologia_passeggero),
    id_tariffa: asStringOrNumber(row.id_tariffa),
    id_iva: asStringOrNumber(row.id_iva),
    id_log: asStringOrNumber(row.id_log),
    nome: asString(row.nome),
    descrizione: asString(row.descrizione),
    prezzo: asNumber(row.prezzo),
    prezzo_ar: asNumber(row.prezzo_ar),
    prezzo_prevendita: asNumber(row.prezzo_prevendita),
    flag_ar_obbligatorio: asFlag(row.flag_ar_obbligatorio),
    flag_targa: asFlag(row.flag_targa),
    quantita_min_per_esclusivo: asNumber(row.quantita_min_per_esclusivo),
    quantita_max_per_esclusivo: asNumber(row.quantita_max_per_esclusivo),
    // Fase 2B.5: grezzo, non validato — vedi commento sul campo in types.ts.
    collegati: "collegati" in row ? row.collegati ?? null : null,
  };
}

/**
 * Parsa GET .../api/biglietti/vendibili/{id_corsa} ({ return: true, output:
 * [...] } — array DIRETTO sotto output, non output.data). schemaValid=false
 * (con schemaError) per qualunque envelope non riconosciuto, inclusi i
 * vecchi formati Fase 1.6 (array alla radice, o { data: [...] } alla
 * radice) che NON sono mai stati reali. Righe singole con campi mancanti
 * restano con quei campi a null (mai un valore indovinato) — è la
 * selezione (findArTariffAndTax) a decidere se i dati disponibili bastano
 * per can_issue.
 */
export function parseBigliettiVendibiliResponse(json: unknown): {
  rows: BigliettoVendibileRaw[];
  schemaValid: boolean;
  schemaError: string | null;
} {
  const envelope = validateApiEnvelope(json);
  if (!envelope.valid) {
    return { rows: [], schemaValid: false, schemaError: envelope.error };
  }
  if (!Array.isArray(envelope.output)) {
    return { rows: [], schemaValid: false, schemaError: "output_not_array" };
  }
  const rawRows = envelope.output as Record<string, unknown>[];
  return { rows: rawRows.map(parseBigliettoRow), schemaValid: true, schemaError: null };
}

/** id_tipologia_passeggero osservato per l'adulto sulla tariffa AR (esempio reale verificato). */
export const ADULT_TIPOLOGIA_PASSEGGERO = 1;
/** id_tipologia_passeggero osservato per la tassa di sbarco in emissioni reali. */
export const TASSA_SBARCO_TIPOLOGIA_PASSEGGERO = 32;

const AR_TARIFF_LABEL_HINT = /PASSAGGIO PONTE ADULTO.*TARIFFA SPECIALE AR/i;
const TASSA_SBARCO_HINT = /TASSA\s+DI\s+SBARCO/i;

export type BigliettoLabelResolution =
  | { label: string; source: "descrizione" | "nome" }
  | { label: null; source: null };

/**
 * Risolve l'etichetta di un biglietto con precedenza deterministica FISSA
 * (nessuna alias-list): descrizione (fonte primaria, etichetta estesa) se
 * presente e non vuota, altrimenti nome (fonte secondaria, etichetta
 * breve), altrimenti null. Esportata perché usata sia per identificare
 * AR/tassa di sbarco (findArTariffAndTax) sia per la label mostrata nel
 * risultato del preflight.
 */
export function resolveBigliettoLabel(row: BigliettoVendibileRaw): BigliettoLabelResolution {
  const descrizione = row.descrizione?.trim();
  if (descrizione) {
    return { label: descrizione, source: "descrizione" };
  }
  const nome = row.nome?.trim();
  if (nome) {
    return { label: nome, source: "nome" };
  }
  return { label: null, source: null };
}

export type ArTariffSelectionResult =
  | { kind: "not_found" }
  | { kind: "unsupported_passenger_type"; row: BigliettoVendibileRaw }
  /** Più righe candidate per l'adulto AR: nessuna scelta arbitraria, revisione manuale richiesta. */
  | { kind: "ambiguous_tariff" }
  | {
      kind: "found";
      tariff: BigliettoVendibileRaw;
      /** Quale campo ha prodotto la label del biglietto selezionato — solo diagnostico. */
      labelSource: "descrizione" | "nome";
      tassaSbarco: BigliettoVendibileRaw | null;
      /** Non-null quando una tassa di sbarco è stata individuata nella risposta ma i dati non bastano a determinarla con certezza. */
      taxIssue: "ambiguous" | "price_missing" | null;
    };

/**
 * Fase 2C — converte una entry grezza di collegati[] (struttura osservata
 * live, diversa da una riga vendibili top-level: contiene anche id_master/
 * unita_allocata/quantita/cumulativo/orePrevendita, non modellati) in un
 * BigliettoVendibileRaw parziale, riusando gli stessi reader difensivi di
 * parseBigliettoRow. Campi non presenti nella struttura collegati
 * (flag_ar_obbligatorio, quantita_min/max_per_esclusivo) restano null: non
 * sono mai stati osservati lì e non vanno indovinati. collegati annidati
 * dentro un collegato non sono supportati (mai osservati, un solo livello
 * di nesting è quanto confermato dai dati reali).
 */
function parseCollegatoRow(row: Record<string, unknown>): BigliettoVendibileRaw {
  return {
    id_corsa: asStringOrNumber(row.id_corsa),
    id_biglietto: asStringOrNumber(row.id_biglietto),
    id_tipologia_passeggero: asNumber(row.id_tipologia_passeggero),
    id_tariffa: asStringOrNumber(row.id_tariffa),
    id_iva: asStringOrNumber(row.id_iva),
    id_log: asStringOrNumber(row.id_log),
    nome: asString(row.nome),
    descrizione: asString(row.descrizione),
    prezzo: asNumber(row.prezzo),
    prezzo_ar: asNumber(row.prezzo_ar),
    prezzo_prevendita: asNumber(row.prezzo_prevendita),
    flag_ar_obbligatorio: null,
    flag_targa: asFlag(row.flag_targa),
    quantita_min_per_esclusivo: null,
    quantita_max_per_esclusivo: null,
    collegati: null,
  };
}

/**
 * Fase 2C — estrae i candidati tassa di sbarco annidati in passengerRow.collegati.
 *
 * Root cause confermata su dati live reali (corsa 132178/131721, GERARDO
 * D'ADDIO): Medmar può esprimere la tassa di sbarco SOLO come entry dentro
 * collegati[] della tariffa passeggero, senza alcuna riga sorella top-level
 * nella risposta biglietti/vendibili — findArTariffAndTax cercava la tassa
 * SOLO a livello top-level e la perdeva silenziosamente in questo caso.
 *
 * Criterio di identificazione (nessun hardcode di id_biglietto/id_log,
 * sempre derivati dalla risposta live): id_tipologia_passeggero === 32
 * (TASSA_SBARCO_TIPOLOGIA_PASSEGGERO) e/o label coerente con "TASSA DI
 * SBARCO" — stesso doppio segnale già usato altrove nel file (mai un solo
 * criterio come regola assoluta).
 */
function extractNestedTaxCandidates(passengerRow: BigliettoVendibileRaw): BigliettoVendibileRaw[] {
  if (!Array.isArray(passengerRow.collegati)) return [];
  const parsed = passengerRow.collegati
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .map(parseCollegatoRow);
  return parsed.filter((row) => {
    if (row.id_tipologia_passeggero === TASSA_SBARCO_TIPOLOGIA_PASSEGGERO) return true;
    const label = resolveBigliettoLabel(row).label;
    return label !== null && TASSA_SBARCO_HINT.test(label);
  });
}

function taxIdentity(row: BigliettoVendibileRaw): string | null {
  if (row.id_biglietto != null) return `id_biglietto:${row.id_biglietto}`;
  if (row.id_log != null) return `id_log:${row.id_log}`;
  return null;
}

/**
 * Fase 2C — unifica la tassa individuata dentro collegati[] (fonte
 * primaria, riflette la struttura live reale) con quella individuata dalla
 * ricerca top-level esistente (fallback, compatibile con risposte Medmar
 * legacy/altre corse dove la tassa è davvero una riga sorella — vedi corsa
 * 133760 nei test, comportamento INVARIATO in quel caso).
 *
 * - più di un candidato su UNA SOLA delle due fonti -> ambiguous (nessuna
 *   scelta arbitraria tra più tasse candidate).
 * - un candidato su entrambe le fonti -> devono riferirsi alla STESSA tassa
 *   (stesso id_biglietto, o id_log se id_biglietto assente su un lato):
 *   coerenti -> un'unica tassa logica; discordanti o non confrontabili
 *   (identità non derivabile su un lato) -> ambiguous, fail-closed.
 * - un candidato su una sola fonte -> quello, nessuna preferenza arbitraria
 *   dato che le fonti non si sovrappongono in questo caso.
 * - zero candidati su entrambe -> nessuna tassa (comportamento invariato
 *   per corse senza tassa).
 *
 * Prezzo mancante sulla tassa selezionata -> price_missing, SEMPRE
 * controllato dopo la selezione (mai silenzioso).
 */
function unifyTaxSelection(
  nested: BigliettoVendibileRaw[],
  topLevel: BigliettoVendibileRaw[]
): { tax: BigliettoVendibileRaw | null; issue: "ambiguous" | "price_missing" | null } {
  if (nested.length > 1 || topLevel.length > 1) {
    return { tax: null, issue: "ambiguous" };
  }

  let selected: BigliettoVendibileRaw | null = null;
  if (nested.length === 1 && topLevel.length === 1) {
    const nestedId = taxIdentity(nested[0]!);
    const topLevelId = taxIdentity(topLevel[0]!);
    if (nestedId === null || topLevelId === null || nestedId !== topLevelId) {
      return { tax: null, issue: "ambiguous" };
    }
    selected = nested[0]!;
  } else if (nested.length === 1) {
    selected = nested[0]!;
  } else if (topLevel.length === 1) {
    selected = topLevel[0]!;
  } else {
    return { tax: null, issue: null };
  }

  if (selected.prezzo == null) {
    return { tax: selected, issue: "price_missing" };
  }
  return { tax: selected, issue: null };
}

/**
 * Individua il biglietto "PASSAGGIO PONTE ADULTO - TARIFFA SPECIALE AR" e
 * l'eventuale "TASSA DI SBARCO" tra i biglietti vendibili di una corsa.
 *
 * Fonte primaria di selezione: label risolta da resolveBigliettoLabel
 * (descrizione, o nome se descrizione assente) — MAI un id_biglietto/
 * id_tariffa hardcoded come regola assoluta (possono cambiare tra
 * listini/configurazioni). Gli ID live vengono comunque riportati nel
 * risultato per diagnostica.
 *
 * flag_ar_obbligatorio è un segnale SECONDARIO, mai discriminante da solo:
 * la sua semantica reale osservata ("obbligatorio" per un solo esempio) è
 * compatibile con un vincolo di vendita, non con "questo è il biglietto
 * AR" — usarlo come condizione bloccante produrrebbe falsi negativi non
 * verificati. Non viene quindi filtrato, solo letto e riportato.
 *
 * Se un candidato corrisponde per label ma la sua tipologia passeggero non
 * è quella adulto nota (1), il gestionale contiene una tipologia non
 * ancora mappata: kind "unsupported_passenger_type", mai accettata
 * silenziosamente come adulto. Se più di un candidato adulto corrisponde,
 * kind "ambiguous_tariff": scegliere il primo silenziosamente sarebbe un
 * falso positivo potenziale, non un fail-safe.
 *
 * Tassa di sbarco (Fase 2C): individuata unificando collegati[] della
 * tariffa adulto selezionata (fonte primaria, vedi extractNestedTaxCandidates)
 * con la ricerca top-level storica (fallback legacy) — vedi unifyTaxSelection.
 */
export function findArTariffAndTax(rows: BigliettoVendibileRaw[]): ArTariffSelectionResult {
  const withLabel = rows.map((row) => ({ row, resolved: resolveBigliettoLabel(row) }));

  const candidates = withLabel.filter(
    ({ resolved }) => resolved.label !== null && AR_TARIFF_LABEL_HINT.test(resolved.label)
  );

  if (candidates.length === 0) {
    return { kind: "not_found" };
  }

  const adults = candidates.filter(({ row }) => row.id_tipologia_passeggero === ADULT_TIPOLOGIA_PASSEGGERO);
  if (adults.length === 0) {
    return { kind: "unsupported_passenger_type", row: candidates[0]!.row };
  }
  if (adults.length > 1) {
    return { kind: "ambiguous_tariff" };
  }
  const { row: adult, resolved: adultLabel } = adults[0]!;

  const topLevelTaxMatches = withLabel
    .filter(({ resolved }) => resolved.label !== null && TASSA_SBARCO_HINT.test(resolved.label))
    .map(({ row }) => row);
  const nestedTaxCandidates = extractNestedTaxCandidates(adult);
  const unified = unifyTaxSelection(nestedTaxCandidates, topLevelTaxMatches);

  return {
    kind: "found",
    tariff: adult,
    labelSource: adultLabel.source as "descrizione" | "nome",
    tassaSbarco: unified.tax,
    taxIssue: unified.issue,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Fase 2B.5 — classificazione passeggero adult/child/infant/tax
// ─────────────────────────────────────────────────────────────────────────

/** id_biglietto/id_tipologia_passeggero osservato per BAMBINO (4-12 anni) sulla corsa reale 133760 — SOLO diagnostico, mai la regola di classificazione. */
export const CHILD_LABEL_HINT = /^PASSAGGIO PONTE BAMBINO\b/i;
/** Idem per INFANT (0-4 anni). */
export const INFANT_LABEL_HINT = /^PASSAGGIO PONTE INFANT\b/i;

export type MedmarPassengerCategory = "adult" | "child" | "infant";

export type PassengerTicketClassification =
  | { kind: MedmarPassengerCategory | "tax"; row: BigliettoVendibileRaw; labelSource: "descrizione" | "nome" }
  | { kind: "unsupported"; row: BigliettoVendibileRaw; reason: "no_label_match" | "tipologia_mismatch" };

/**
 * Classifica un singolo biglietto vendibile come adult/child/infant/tax/
 * unsupported. Criterio deterministico FISSO (Fase 2B.5), in quest'ordine:
 *
 * 1. descrizione/nome (via resolveBigliettoLabel, stessa precedenza usata
 *    ovunque nel file) contro 4 regex ANCORATE e reciprocamente esclusive
 *    (nessuna può mai matchare la stessa stringa di un'altra): questo è
 *    l'UNICO segnale che decide la categoria. Adulto riusa
 *    AR_TARIFF_LABEL_HINT byte-per-byte — stessa identica selezione già in
 *    uso da findArTariffAndTax, per garanzia di non-regressione sul flusso
 *    solo-adulti.
 * 2. id_tipologia_passeggero è SOLO un sanity check SUCCESSIVO: nei dati
 *    reali osservati (corsa 133760) adulto, bambino e infant condividono
 *    TUTTI id_tipologia_passeggero=1 — usarlo per SCEGLIERE tra queste tre
 *    categorie sarebbe il bug storico che questa fase corregge. Qui può
 *    solo DECLASSARE un match a "unsupported" (tipologia_mismatch), mai
 *    promuovere/riclassificare una categoria.
 *
 * Righe che non combaciano con nessuna delle 4 etichette (auto, moto,
 * animale, "INT PASSEGGERO" o qualunque altra dicitura) restano
 * "unsupported"/"no_label_match" per costruzione: nessun match parziale o
 * fuzzy, nessun fallback su id_biglietto/id_log come regola primaria.
 */
export function classifyPassengerTicket(row: BigliettoVendibileRaw): PassengerTicketClassification {
  const resolved = resolveBigliettoLabel(row);
  if (resolved.label === null) {
    return { kind: "unsupported", row, reason: "no_label_match" };
  }
  const label = resolved.label;
  const labelSource = resolved.source;

  if (AR_TARIFF_LABEL_HINT.test(label)) {
    if (row.id_tipologia_passeggero !== ADULT_TIPOLOGIA_PASSEGGERO) {
      return { kind: "unsupported", row, reason: "tipologia_mismatch" };
    }
    return { kind: "adult", row, labelSource };
  }
  if (CHILD_LABEL_HINT.test(label)) {
    if (row.id_tipologia_passeggero !== ADULT_TIPOLOGIA_PASSEGGERO) {
      return { kind: "unsupported", row, reason: "tipologia_mismatch" };
    }
    return { kind: "child", row, labelSource };
  }
  if (INFANT_LABEL_HINT.test(label)) {
    if (row.id_tipologia_passeggero !== ADULT_TIPOLOGIA_PASSEGGERO) {
      return { kind: "unsupported", row, reason: "tipologia_mismatch" };
    }
    return { kind: "infant", row, labelSource };
  }
  if (TASSA_SBARCO_HINT.test(label)) {
    if (row.id_tipologia_passeggero !== TASSA_SBARCO_TIPOLOGIA_PASSEGGERO) {
      return { kind: "unsupported", row, reason: "tipologia_mismatch" };
    }
    return { kind: "tax", row, labelSource };
  }
  return { kind: "unsupported", row, reason: "no_label_match" };
}

export type PassengerCategorySelection =
  | { kind: "not_found" }
  | { kind: "found"; ticket: BigliettoVendibileRaw; labelSource: "descrizione" | "nome" }
  | { kind: "ambiguous" }
  | { kind: "unsupported_passenger_type"; row: BigliettoVendibileRaw };

function selectCategory(
  classified: PassengerTicketClassification[],
  category: MedmarPassengerCategory | "tax"
): PassengerCategorySelection {
  const matches = classified.filter((c): c is Extract<PassengerTicketClassification, { kind: typeof category }> => c.kind === category);
  if (matches.length === 1) return { kind: "found", ticket: matches[0]!.row, labelSource: matches[0]!.labelSource };
  if (matches.length > 1) return { kind: "ambiguous" };

  // Nessun match diretto: se un'etichetta compatibile esiste ma con
  // id_tipologia_passeggero inatteso, riportalo come segnale diagnostico
  // (stesso trattamento già riservato all'adulto da findArTariffAndTax)
  // invece di un generico "not_found" silenzioso.
  const mismatched = classified.find(
    (c) => c.kind === "unsupported" && c.reason === "tipologia_mismatch" && labelMatchesCategory(c.row, category)
  );
  if (mismatched) return { kind: "unsupported_passenger_type", row: mismatched.row };

  return { kind: "not_found" };
}

function labelMatchesCategory(row: BigliettoVendibileRaw, category: MedmarPassengerCategory | "tax"): boolean {
  const resolved = resolveBigliettoLabel(row);
  if (resolved.label === null) return false;
  if (category === "adult") return AR_TARIFF_LABEL_HINT.test(resolved.label);
  if (category === "child") return CHILD_LABEL_HINT.test(resolved.label);
  if (category === "infant") return INFANT_LABEL_HINT.test(resolved.label);
  return TASSA_SBARCO_HINT.test(resolved.label);
}

export type PassengerTariffSelection = {
  adult: PassengerCategorySelection;
  child: PassengerCategorySelection;
  infant: PassengerCategorySelection;
  /** Tutte le righe classificate "tax" nella risposta (di norma 0 o 1). */
  taxRows: BigliettoVendibileRaw[];
};

/**
 * Applica classifyPassengerTicket a tutte le righe di una risposta
 * biglietti/vendibili e seleziona, per ciascuna categoria passeggero, la
 * riga corrispondente (found/not_found/ambiguous/unsupported_passenger_type
 * — stessa semantica di findArTariffAndTax, generalizzata a 3 categorie).
 * Non sostituisce findArTariffAndTax (che resta l'unica selezione usata dal
 * percorso solo-adulti in issue-payload.ts): questa funzione serve al
 * preflight per costruire ticket_breakdown.
 */
export function selectPassengerTariffs(rows: BigliettoVendibileRaw[]): PassengerTariffSelection {
  const classified = rows.map(classifyPassengerTicket);
  return {
    adult: selectCategory(classified, "adult"),
    child: selectCategory(classified, "child"),
    infant: selectCategory(classified, "infant"),
    taxRows: classified.filter((c) => c.kind === "tax").map((c) => c.row),
  };
}

export type TaxLinkageResult =
  | { linked: true; tax: BigliettoVendibileRaw; source: "collegati" | "heuristic_unverified" }
  | { linked: false; source: "none" | "ambiguous" };

function extractCollegatiTicketIds(collegati: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(collegati)) return ids;
  for (const entry of collegati) {
    if (entry && typeof entry === "object" && "id_biglietto" in (entry as Record<string, unknown>)) {
      const idVal = (entry as Record<string, unknown>).id_biglietto;
      if (typeof idVal === "number" || typeof idVal === "string") ids.add(String(idVal));
    }
  }
  return ids;
}

/**
 * Deriva se una categoria passeggero (adult/child/infant) ha una tassa di
 * sbarco collegata, per il titolo passeggero SPECIFICO passato.
 *
 * Fonte primaria (mai indovinata): passengerRow.collegati, se presente come
 * array, confrontato per id_biglietto contro le righe classificate "tax"
 * nella stessa risposta vendibili. Se collegati è un array (anche vuoto) e
 * NON contiene l'id_biglietto della tassa, il risultato è "non collegata" —
 * un dato osservato, non un'assunzione.
 *
 * Fallback (SOLO quando collegati non è un array, cioè il dato non è
 * disponibile): usa l'evidenza osservata sui dati reali (corsa 133760:
 * adulto e bambino pagano la tassa, infant no), ma SEMPRE etichettata
 * "heuristic_unverified" — mai silenziosamente equivalente a un
 * collegamento confermato via collegati[]. Con più di una riga tax nella
 * risposta il collegamento è ambiguo per costruzione: nessuna scelta
 * arbitraria.
 */
export function deriveTaxLinkage(
  category: MedmarPassengerCategory,
  passengerRow: BigliettoVendibileRaw,
  taxRows: BigliettoVendibileRaw[]
): TaxLinkageResult {
  if (taxRows.length === 0) return { linked: false, source: "none" };
  if (taxRows.length > 1) return { linked: false, source: "ambiguous" };
  const tax = taxRows[0]!;
  const taxId = tax.id_biglietto != null ? String(tax.id_biglietto) : null;

  if (Array.isArray(passengerRow.collegati)) {
    const linkedIds = extractCollegatiTicketIds(passengerRow.collegati);
    return taxId != null && linkedIds.has(taxId) ? { linked: true, tax, source: "collegati" } : { linked: false, source: "none" };
  }

  if (category === "adult" || category === "child") {
    return { linked: true, tax, source: "heuristic_unverified" };
  }
  return { linked: false, source: "none" };
}
