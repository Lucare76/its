/**
 * Client HTTP server-side verso il portale Medmar.
 *
 * Fase 1.5 "Preflight live": 2 endpoint READ-ONLY reali, verificati
 * manualmente sul portale Medmar (risposta HTTP 200):
 *
 *   GET {prefix}/corse/{id_tratta}?partenza_data_dal=YYYY-MM-DD&dopo_le=HH:MM:SS&vendibile=1
 *   GET {prefix}/biglietti/vendibili/{id_corsa}?id_tariffa=&id_biglietto=
 *
 * Flusso reale completo osservato manualmente (per contesto — SOLO gli step
 * 1-2 sono implementati qui, gli altri restano bloccati per sempre in questa
 * fase):
 *   1. ricerca corse                              (READ-ONLY — implementato)
 *   2. recupero biglietti vendibili                (READ-ONLY — implementato)
 *   3. costruzione dettagli biglietti
 *   4. POST /prenotazioni/lock-disponibilita       (MUTATIVO — congela posti)
 *   5. POST /prenotazioni                          (MUTATIVO)
 *   6. chiamata "manuale" (pagamento/id_modalita)  (MUTATIVO)
 *
 * Guard fail-safe: qualunque path che contenga il segmento "prenotazioni"
 * (in qualunque punto, con qualunque prefisso) viene bloccato in modo
 * assoluto, PRIMA di controllare la whitelist read-only. Questo copre
 * lock-disponibilita, prenotazioni, manuale, scongela e qualunque futuro
 * sotto-path sotto /prenotazioni, indipendentemente da flag env.
 *
 * Nessuna funzione di questo modulo espone un metodo HTTP generico
 * (get/post arbitrari): solo GET fisso, e solo verso i 2 endpoint whitelisted.
 */

import { getMedmarAuthProvider } from "./auth";
import { parseCorsePage, parseBigliettiVendibiliResponse } from "./live-parser";
import type { CorsaMedmarRaw, BigliettoVendibileRaw } from "./types";

const MEDMAR_API_BASE_URL = process.env.MEDMAR_API_BASE_URL?.trim() || null;

/** Prefisso reale osservato manualmente sul portale Medmar. */
export const MEDMAR_API_PATH_PREFIX = "/production/biglietteria_api/public/index.php/api";

const LIVE_FETCH_TIMEOUT_MS = 6_000;

/**
 * Cap assoluto di pagine seguite per una singola ricerca corse. La risposta
 * reale osservata ha avuto last_page=27: il cap è un margine di sicurezza,
 * MAI un valore su cui appoggiarsi come limite "normale" — se viene
 * raggiunto, il preflight fallisce esplicitamente (fail-closed), non
 * prosegue silenziosamente con dati incompleti.
 */
const MAX_CORSE_PAGES = 30;

/** Budget di tempo complessivo sull'intero ciclo di paginazione (non per singola richiesta). */
const PAGINATION_TOTAL_BUDGET_MS = 30_000;

export class MedmarMutationBlockedError extends Error {
  constructor(path: string) {
    super(`Chiamata mutativa Medmar bloccata: il preflight può usare solo endpoint READ-ONLY (path: ${path}).`);
    this.name = "MedmarMutationBlockedError";
  }
}

export class MedmarPathNotAllowedError extends Error {
  constructor(path: string) {
    super(`Path Medmar non presente nella whitelist READ-ONLY verificata: ${path}`);
    this.name = "MedmarPathNotAllowedError";
  }
}

export class MedmarNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarNotAvailableError";
  }
}

/** 401/403 dalla risposta Medmar anche dopo un retry con token rinnovato: sessione scaduta/non autorizzata. */
export class MedmarAuthExpiredError extends Error {
  constructor() {
    super("Sessione Medmar scaduta o non autorizzata (401/403).");
    this.name = "MedmarAuthExpiredError";
  }
}

/** Risposta Medmar 5xx o corpo non interpretabile. */
export class MedmarBadResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarBadResponseError";
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function isMutativePath(pathname: string): boolean {
  // Tutto il flusso mutativo osservato (lock-disponibilita, prenotazioni,
  // manuale, scongela) vive sotto il segmento "prenotazioni": bloccarlo
  // ovunque compaia è più sicuro che elencare ogni sotto-path singolarmente.
  return pathSegments(pathname).some((segment) => segment.toLowerCase() === "prenotazioni");
}

const API_PREFIX_SEGMENTS = pathSegments(MEDMAR_API_PATH_PREFIX);

/**
 * Verifica che il path, oltre al tail atteso, inizi ESATTAMENTE col prefisso
 * API noto e non contenga altri segmenti intermedi (Fase 1.7 hardening: la
 * versione precedente controllava solo il tail, permettendo in astratto a un
 * path con prefisso arbitrario ma tail corretto di superare il guard).
 */
function hasExactPrefix(segs: string[]): boolean {
  return API_PREFIX_SEGMENTS.every((seg, i) => segs[i] === seg);
}

function isCorseReadonlyPath(pathname: string): boolean {
  const segs = pathSegments(pathname);
  if (segs.length !== API_PREFIX_SEGMENTS.length + 2) return false;
  if (!hasExactPrefix(segs)) return false;
  const tail = segs.slice(API_PREFIX_SEGMENTS.length);
  return tail[0] === "corse" && /^\d+$/.test(tail[1]!);
}

function isBigliettiVendibiliReadonlyPath(pathname: string): boolean {
  const segs = pathSegments(pathname);
  if (segs.length !== API_PREFIX_SEGMENTS.length + 3) return false;
  if (!hasExactPrefix(segs)) return false;
  const tail = segs.slice(API_PREFIX_SEGMENTS.length);
  return tail[0] === "biglietti" && tail[1] === "vendibili" && /^\d+$/.test(tail[2]!);
}

const CORSE_ALLOWED_QUERY_KEYS = new Set(["id_tratta", "partenza_data_dal", "dopo_le", "vendibile", "page"]);
const VENDIBILI_ALLOWED_QUERY_KEYS = new Set(["id_tariffa", "id_biglietto"]);

function assertAllowedQueryKeys(path: string, url: URL, allowed: Set<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new MedmarPathNotAllowedError(path);
    }
  }
}

/**
 * Guard esplicito: lancia SEMPRE per path mutativi, indipendentemente da
 * qualunque env flag. Lancia anche per path non in whitelist read-only o
 * con query param non whitelisted. Esportato per essere usato anche come
 * sensitivity test.
 *
 * Il path viene sempre normalizzato tramite URL() prima del confronto, così
 * eventuali tentativi di path traversal (es. "/corse/../prenotazioni")
 * vengono risolti al path reale PRIMA del controllo — e quindi bloccati
 * comunque dal controllo "prenotazioni".
 */
export function assertReadOnlyPath(path: string): void {
  const url = new URL(path, "http://medmar.internal");
  const pathname = url.pathname;

  if (isMutativePath(pathname)) {
    throw new MedmarMutationBlockedError(path);
  }

  if (isCorseReadonlyPath(pathname)) {
    assertAllowedQueryKeys(path, url, CORSE_ALLOWED_QUERY_KEYS);
    return;
  }

  if (isBigliettiVendibiliReadonlyPath(pathname)) {
    assertAllowedQueryKeys(path, url, VENDIBILI_ALLOWED_QUERY_KEYS);
    return;
  }

  throw new MedmarPathNotAllowedError(path);
}

type GuardedRequestResult = { kind: "ok"; json: unknown } | { kind: "unauthorized" };

/**
 * Esegue UNA richiesta GET verso Medmar con l'header Authorization già
 * pronto. Non lancia mai per 401/403: li restituisce nel risultato, così è
 * medmarReadonlyFetch (unico chiamante) a decidere se ritentare — vedi lì
 * per il perché il retry vive un livello sopra, non qui.
 */
async function performGuardedRequest(path: string, bearerToken: string): Promise<GuardedRequestResult> {
  let response: Response;
  try {
    response = await fetch(`${MEDMAR_API_BASE_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearerToken}` },
      signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    // Rete/timeout: mai includere il token nel messaggio di errore.
    throw new MedmarNotAvailableError(err instanceof Error && err.name === "TimeoutError" ? "Timeout chiamata Medmar." : "Errore di rete verso Medmar.");
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized" };
  }
  if (!response.ok) {
    throw new MedmarBadResponseError(`Medmar ha risposto con errore ${response.status}.`);
  }

  try {
    return { kind: "ok", json: await response.json() };
  } catch {
    throw new MedmarBadResponseError("Risposta Medmar non interpretabile (JSON non valido).");
  }
}

/**
 * Fetch guardato verso l'API Medmar. Metodo sempre GET (nessun override
 * possibile), nessuna funzione pubblica generica: solo i 2 wrapper dedicati
 * sotto. Il token Medmar non viene MAI loggato qui.
 *
 * Su 401/403: invalida la sessione, richiede un nuovo token e ritenta la
 * STESSA richiesta ESATTAMENTE una volta. assertReadOnlyPath viene
 * rieseguito prima di ogni tentativo, sempre sullo stesso `path` (mai
 * mutato tra i due tentativi) — nessuna finestra in cui una richiesta parte
 * senza essere appena passata dal guard. Se anche il secondo tentativo è
 * 401/403: MedmarAuthExpiredError, fail-closed, nessun ulteriore retry.
 */
async function medmarReadonlyFetch(path: string): Promise<unknown> {
  assertReadOnlyPath(path);

  if (!MEDMAR_API_BASE_URL) {
    throw new MedmarNotAvailableError("MEDMAR_API_BASE_URL non configurato.");
  }

  const provider = getMedmarAuthProvider();

  const firstSession = await provider.getValidToken();
  const first = await performGuardedRequest(path, firstSession.bearerToken);
  if (first.kind === "ok") {
    return first.json;
  }

  // Primo tentativo 401/403: invalida e ritenta UNA sola volta (mai un loop).
  provider.invalidateToken();
  assertReadOnlyPath(path);
  const secondSession = await provider.getValidToken();
  const second = await performGuardedRequest(path, secondSession.bearerToken);
  if (second.kind === "ok") {
    return second.json;
  }

  throw new MedmarAuthExpiredError();
}

function buildCorsePagePath(params: { idTratta: number; partenzaDataDal: string; dopoLe: string }, page: number): string {
  const search = new URLSearchParams({
    id_tratta: String(params.idTratta),
    partenza_data_dal: params.partenzaDataDal,
    dopo_le: params.dopoLe,
    vendibile: "1",
    page: String(page),
  });
  return `${MEDMAR_API_PATH_PREFIX}/corse/${params.idTratta}?${search.toString()}`;
}

/**
 * Ricerca corse Medmar per tratta/data (READ-ONLY, verificato manualmente).
 *
 * La risposta è paginata (stile Laravel): questa funzione segue le pagine
 * necessarie fino a MAX_CORSE_PAGES o al budget di tempo complessivo
 * PAGINATION_TOTAL_BUDGET_MS, qualunque limite venga raggiunto prima —
 * fail-closed (MedmarBadResponseError) se il cap viene raggiunto senza aver
 * completato la paginazione, MAI un risultato parziale silenzioso.
 *
 * Ogni pagina viene ricostruita dal MEDMAR_API_BASE_URL configurato + il
 * parametro "page": next_page_url (URL assoluto restituito da Medmar) non
 * viene MAI usato per la richiesta, per evitare che un valore controllato
 * dal server remoto (anche se non malevolo) determini l'host/porta a cui
 * viene inviato il Bearer token.
 *
 * Il numero di pagina è deciso e incrementato solo da questo client (mai
 * dal valore "current_page" restituito da Medmar): un loop infinito o un
 * ciclo di pagine è quindi strutturalmente impossibile, indipendentemente
 * da quanto sia malformata la risposta.
 */
export async function fetchCorseReadOnly(params: {
  idTratta: number;
  partenzaDataDal: string;
  dopoLe: string;
}): Promise<CorsaMedmarRaw[]> {
  const deadline = Date.now() + PAGINATION_TOTAL_BUDGET_MS;
  const collected: CorsaMedmarRaw[] = [];

  for (let page = 1; page <= MAX_CORSE_PAGES; page += 1) {
    if (Date.now() > deadline) {
      throw new MedmarNotAvailableError("Timeout complessivo nella paginazione delle corse Medmar.");
    }

    const path = buildCorsePagePath(params, page);
    const json = await medmarReadonlyFetch(path);
    const { rows, pagination, schemaValid, schemaError } = parseCorsePage(json);
    // Fail-closed per-pagina: uno schema incompatibile su QUALUNQUE pagina
    // (anche a metà paginazione) deve restare distinguibile da "nessuna
    // corsa trovata" — mai troncare silenziosamente la raccolta a un
    // risultato parziale che sembrerebbe completo.
    if (!schemaValid) {
      throw new MedmarBadResponseError(`Risposta Medmar corse non conforme allo schema atteso (${schemaError}) — fail-closed.`);
    }
    collected.push(...rows);

    if (!pagination || pagination.lastPage === null) {
      // Nessuna paginazione riconoscibile: si tratta come pagina unica.
      return collected;
    }
    const lastPage = pagination.lastPage;
    const currentPage = pagination.currentPage ?? page;
    if (currentPage >= lastPage) {
      return collected;
    }

    // Stop deterministico: se tutte le righe di questa pagina hanno una
    // partenza_data successiva alla data richiesta, assumendo ordinamento
    // cronologico crescente le pagine successive conterranno solo date
    // ancora più lontane — non serve continuare.
    if (rows.length > 0 && rows.every((r) => r.partenza_data !== null && r.partenza_data > params.partenzaDataDal)) {
      return collected;
    }
  }

  throw new MedmarBadResponseError(`Superato il numero massimo di pagine Medmar consentite (${MAX_CORSE_PAGES}) senza completare la paginazione.`);
}

/**
 * Biglietti vendibili per una corsa (READ-ONLY, verificato manualmente).
 */
export async function fetchBigliettiVendibiliReadOnly(idCorsa: number | string): Promise<BigliettoVendibileRaw[]> {
  const search = new URLSearchParams({ id_tariffa: "", id_biglietto: "" });
  const path = `${MEDMAR_API_PATH_PREFIX}/biglietti/vendibili/${idCorsa}?${search.toString()}`;
  const json = await medmarReadonlyFetch(path);
  const { rows, schemaValid, schemaError } = parseBigliettiVendibiliResponse(json);
  if (!schemaValid) {
    throw new MedmarBadResponseError(`Risposta Medmar biglietti/vendibili non conforme allo schema atteso (${schemaError}) — fail-closed.`);
  }
  return rows;
}
