/**
 * Controlli deterministici sul testo PDF Aleste, applicati DOPO l'estrazione
 * Haiku (lib/server/pdf-extract-haiku.ts). Il modello resta la fonte primaria;
 * qui si correggono solo i campi che il testo del documento permette di
 * verificare in modo univoco, e si segnala (reviewWarnings) tutto ciò che non
 * torna — mai una scelta arbitraria.
 *
 * Audit 26/015867 (SAMORI, 6 pax letti come 1): nel testo estratto la colonna
 * PAX è incollata ad altro testo ("...Staff Aleste6 PROGRAMMA", riga tariffa
 * "28,006(1)168,00" = importo 28,00 · pax 6 · num (1) · totale 168,00).
 *
 * Audit 26/015929 (BELOTTI, treno di ritorno preso dal riquadro sbagliato):
 * il treno di ritorno va associato al blocco "TRANSFER HOTEL/STAZIONE" tramite
 * l'orario "Dalle HH:MM", mai tramite la posizione della riga in tabella.
 */

/** Tariffa Aleste transfer stazione-hotel, € per persona per tratta — usata SOLO come controllo di coerenza. */
export const ALESTE_STATION_TRANSFER_EUR_PER_PAX_PER_LEG = 28;

export type AlesteCheckableForm = {
  n_pax: string;
  orario_partenza: string;
  treno_ritorno: string;
  totale_pratica: string;
  tipo_servizio: string;
  data_partenza: string;
};

export type AlesteTariffRow = { unitPrice: number; pax: number; num: number; total: number };

const MONEY = String.raw`\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}`;

function parseEuro(value: string): number {
  return Number(value.replace(/\./g, "").replace(",", "."));
}

function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

function trainDigits(code: string | null | undefined): string | null {
  return String(code ?? "").match(/(\d{3,5})\s*$/)?.[1] ?? null;
}

function normalizeHm(value: string | null | undefined): string | null {
  const match = String(value ?? "").match(/^(\d{1,2})[:.](\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

/** PAX dalla tabella intestazione: il numero subito prima di "PROGRAMMA DESCRIZIONE" (es. "Staff Aleste6 PROGRAMMA"). */
export function extractAlesteHeaderPax(text: string): number | null {
  const match = text.match(/(?<!\d)(\d{1,3})\s*PROGRAMMA\s*DESCRIZIONE/i);
  const pax = match ? Number(match[1]) : NaN;
  return Number.isInteger(pax) && pax > 0 ? pax : null;
}

/**
 * Righe tariffa con PAX incollato, es. "TRANSFER HOTEL/STAZIONE28,006(1)168,00".
 * Una riga è accettata SOLO se l'aritmetica del documento la conferma
 * (importo × pax = totale riga): così lo split delle cifre incollate non è
 * mai indovinato. Più split possibili dell'importo (cifre di un orario
 * incollate davanti, es. "09:4012,502(1)25,00") vengono provati tutti.
 */
export function extractAlesteTariffRows(text: string): AlesteTariffRow[] {
  const rows: AlesteTariffRow[] = [];
  const pattern = new RegExp(String.raw`(\d[\d.]*,\d{2})(\d{1,3})\((\d{1,3})\)(${MONEY})`, "g");
  for (const match of text.matchAll(pattern)) {
    const [, priceRun, paxRaw, numRaw, totalRaw] = match;
    const pax = Number(paxRaw);
    const num = Number(numRaw);
    const total = parseEuro(totalRaw);
    if (!(pax > 0)) continue;
    for (let start = 0; start < priceRun.length - 3; start += 1) {
      const candidate = priceRun.slice(start);
      if (!new RegExp(`^(?:${MONEY})$`).test(candidate)) continue;
      const unitPrice = parseEuro(candidate);
      if (unitPrice > 0 && sameAmount(unitPrice * pax, total)) {
        rows.push({ unitPrice, pax, num, total });
        break;
      }
    }
  }
  return rows;
}

export type AlestePaxResult = {
  pax: number | null;
  headerPax: number | null;
  rows: AlesteTariffRow[];
  conflict: boolean;
};

export function resolveAlestePax(text: string): AlestePaxResult {
  const headerPax = extractAlesteHeaderPax(text);
  const rows = extractAlesteTariffRows(text);
  const rowPax = Array.from(new Set(rows.map((row) => row.pax)));
  if (headerPax !== null && rowPax.length > 0) {
    const agree = rowPax.length === 1 && rowPax[0] === headerPax;
    return { pax: agree ? headerPax : null, headerPax, rows, conflict: !agree };
  }
  if (headerPax !== null) return { pax: headerPax, headerPax, rows, conflict: false };
  if (rowPax.length === 1) return { pax: rowPax[0], headerPax, rows, conflict: false };
  return { pax: null, headerPax, rows, conflict: rowPax.length > 1 };
}

export type AlesteReturnTrainResult = {
  /** Orario "Dalle" del blocco HOTEL/STAZIONE di ritorno scelto. */
  departureTime: string | null;
  /** Codici candidati (deduplicati per numero) associati a quell'orario. */
  candidates: string[];
  /** Codice univoco, oppure null (nessun dato o più candidati). */
  code: string | null;
  ambiguousBlocks: boolean;
};

const RETURN_BLOCK = /TRANSFER\s+HOTEL(?:\s+ISCHIA)?\s*\/\s*STAZIONE([\s\S]*?)(?=\bIl\s*[0-3]?\d-[a-z]{3}-\d{2}|Cliente:|La caparra|-{10}|$)/gi;
const TABLE_TRAIN_CODE = /(ITA|FR|FA|FB|FS|IC|ICN|EC|EN|RV|REG)\s?(\d{3,5})\s*$/;

/** Righe tabella operativa: "2 NAPOLI CENTRALE 17:4511-ott ITALOITA 8524" -> { time: "17:45", code: "ITA 8524" }. */
export function extractAlesteTableTrainRows(text: string): Array<{ time: string; code: string }> {
  const rows: Array<{ time: string; code: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/(\d{1,2}:\d{2})\d{1,2}-[a-z]{3}\s+(.+)$/i);
    if (!match) continue;
    const code = match[2].trim().match(TABLE_TRAIN_CODE);
    if (!code) continue;
    rows.push({ time: normalizeHm(match[1]) as string, code: `${code[1]} ${code[2]}` });
  }
  return rows;
}

/**
 * Treno di ritorno associato per CONTESTO: blocco "TRANSFER HOTEL/STAZIONE",
 * orario "Dalle HH:MM", codici dopo "da:" nel blocco + righe tabella che
 * partono a quello stesso orario. Mai "la riga 2".
 */
export function resolveAlesteReturnTrain(text: string, expectedDepartureTime?: string | null): AlesteReturnTrainResult {
  const blocks = Array.from(text.matchAll(RETURN_BLOCK)).map((match) => {
    const body = match[1] ?? "";
    const time = normalizeHm(body.match(/Dalle\s*(\d{1,2}[:.]\d{2})/i)?.[1]);
    const codes = Array.from(body.matchAll(/da:\s*([A-Z]+(?:\s+[A-Z]+)?)\s*(\d{3,5})\b/g)).map((m) => `${m[1]} ${m[2]}`);
    return { time, codes };
  }).filter((block) => block.time !== null);

  if (blocks.length === 0) return { departureTime: null, candidates: [], code: null, ambiguousBlocks: false };

  let chosen = blocks;
  const blockTimes = new Set(blocks.map((block) => block.time));
  if (blockTimes.size > 1) {
    const expected = normalizeHm(expectedDepartureTime);
    chosen = expected ? blocks.filter((block) => block.time === expected) : [];
    if (chosen.length === 0) return { departureTime: null, candidates: [], code: null, ambiguousBlocks: true };
  }
  const departureTime = chosen[0].time;

  const tableCodes = extractAlesteTableTrainRows(text).filter((row) => row.time === departureTime).map((row) => row.code);
  const blockCodes = chosen.flatMap((block) => block.codes);
  const byDigits = new Map<string, string>();
  // Preferenza di formato: codice tabella ("ITA 8524") poi blocco ("ITALO 8524").
  for (const code of [...tableCodes, ...blockCodes]) {
    const digits = trainDigits(code);
    if (digits && !byDigits.has(digits)) byDigits.set(digits, code);
  }
  const candidates = Array.from(byDigits.values());
  return {
    departureTime,
    candidates,
    code: candidates.length === 1 ? candidates[0] : null,
    ambiguousBlocks: false,
  };
}

export type AlesteChecksResult<T extends AlesteCheckableForm> = { form: T; warnings: string[] };

/**
 * Applica i controlli deterministici al form estratto da Haiku. Corregge solo
 * con un dato letto univocamente dal documento; ogni correzione o incoerenza
 * produce un warning esplicito (revisione manuale). Il totale pratica non
 * viene MAI usato per correggere n_pax, solo per segnalare.
 */
export function applyAlesteDeterministicChecks<T extends AlesteCheckableForm>(form: T, pdfText: string): AlesteChecksResult<T> {
  const warnings: string[] = [];
  const next = { ...form };
  if (!pdfText.trim()) return { form: next, warnings };

  // ── PAX ────────────────────────────────────────────────────────────────
  const aiPax = Number(form.n_pax);
  const pax = resolveAlestePax(pdfText);
  if (pax.conflict) {
    const rowPax = Array.from(new Set(pax.rows.map((row) => row.pax))).join("/");
    warnings.push(
      `PAX non univoco nel PDF (intestazione: ${pax.headerPax ?? "n/d"}, righe tariffa: ${rowPax || "n/d"}): verificare n_pax (estratto ${form.n_pax || "n/d"}).`
    );
  } else if (pax.pax !== null && pax.pax !== aiPax) {
    next.n_pax = String(pax.pax);
    warnings.push(
      `n_pax corretto da ${form.n_pax || "n/d"} a ${pax.pax} (letto da ${pax.headerPax !== null ? "colonna PAX intestazione" : "righe tariffa"} del PDF): verificare.`
    );
  }

  // Coerenza col totale pratica (solo segnalazione, mai correzione).
  const finalPax = Number(next.n_pax);
  const total = form.totale_pratica ? Number(String(form.totale_pratica).replace(",", ".")) : NaN;
  if (Number.isFinite(total) && total > 0 && finalPax > 0) {
    if (pax.rows.length > 0) {
      const rowsTotal = pax.rows.reduce((sum, row) => sum + row.total, 0);
      if (!sameAmount(rowsTotal, total)) {
        warnings.push(`Totale pratica ${total.toFixed(2)} € diverso dalla somma delle righe tariffa (${rowsTotal.toFixed(2)} €): verificare n_pax e importi.`);
      }
    } else if (form.tipo_servizio === "transfer_station_hotel") {
      const legs = form.data_partenza ? 2 : 1;
      const expected = finalPax * legs * ALESTE_STATION_TRANSFER_EUR_PER_PAX_PER_LEG;
      if (!sameAmount(expected, total)) {
        warnings.push(
          `n_pax ${finalPax} non coerente col totale pratica ${total.toFixed(2)} € (atteso ${expected.toFixed(2)} € = ${finalPax} pax × ${legs} tratte × ${ALESTE_STATION_TRANSFER_EUR_PER_PAX_PER_LEG} €): verificare n_pax.`
        );
      }
    }
  }

  // ── Treno di ritorno ───────────────────────────────────────────────────
  const ret = resolveAlesteReturnTrain(pdfText, form.orario_partenza);
  if (ret.ambiguousBlocks) {
    warnings.push("Più blocchi di ritorno HOTEL/STAZIONE con orari diversi: verificare treno e orario di partenza.");
  } else if (ret.departureTime) {
    const aiTime = normalizeHm(form.orario_partenza);
    if (aiTime && aiTime !== ret.departureTime) {
      warnings.push(`Orario partenza estratto ${aiTime} diverso dal blocco di ritorno del PDF (Dalle ${ret.departureTime}): verificare.`);
    }
    if (ret.candidates.length > 1) {
      next.treno_ritorno = "";
      warnings.push(
        `Più treni candidati per la partenza delle ${ret.departureTime} (${ret.candidates.join(", ")}): treno ritorno da indicare manualmente.`
      );
    } else if (ret.code && trainDigits(ret.code) !== trainDigits(form.treno_ritorno)) {
      next.treno_ritorno = ret.code;
      warnings.push(
        `Treno ritorno corretto da ${form.treno_ritorno || "n/d"} a ${ret.code} (associato alla partenza delle ${ret.departureTime} nel PDF): verificare.`
      );
    }
  }

  return { form: next, warnings };
}
