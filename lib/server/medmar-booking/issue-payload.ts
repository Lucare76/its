import { findArTariffAndTax, resolveBigliettoLabel, selectPassengerTariffs, deriveTaxLinkage, TASSA_SBARCO_TIPOLOGIA_PASSEGGERO } from "./live-parser";
import type { MedmarPassengerCategory, PassengerCategorySelection } from "./live-parser";
import type { BigliettoVendibileRaw, MedmarPreflightLeg, MedmarPreflightResult } from "./types";
import type {
  MedmarBookingDetailLine,
  MedmarBookingPayload,
  MedmarIssueConfig,
  MedmarIssueCustomer,
  MedmarIssueSessionContext,
  MedmarIssueServiceRow,
  MedmarLockedTicket,
  MedmarMutationTicketLine,
} from "./issue-types";

export class MedmarIssuePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MedmarIssuePayloadError";
  }
}

function toNumber(value: number | string | null | undefined, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MedmarIssuePayloadError(`${field} non valido.`);
  return parsed;
}

function requiredText(value: string | null | undefined, field: string): string {
  const cleaned = (value ?? "").trim();
  if (!cleaned) throw new MedmarIssuePayloadError(`${field} mancante.`);
  return cleaned;
}

function assertTassaSbarcoTipologia(tax: BigliettoVendibileRaw): void {
  if (tax.id_tipologia_passeggero !== TASSA_SBARCO_TIPOLOGIA_PASSEGGERO) {
    throw new MedmarIssuePayloadError("tassa di sbarco con id_tipologia_passeggero inatteso: dati biglietto incompleti.");
  }
}

function splitName(fullName: string | null): { nome: string; cognome: string } {
  const parts = requiredText(fullName, "nome cliente").split(/\s+/);
  if (parts.length === 1) return { nome: parts[0]!, cognome: parts[0]! };
  return { nome: parts.slice(0, -1).join(" "), cognome: parts.at(-1)! };
}

/**
 * Fase 2B.6 — `email` nel payload Medmar è SEMPRE l'email tecnica ITS
 * (risolta server-side via resolveMedmarTechnicalRecipient, mai da
 * services.customer_email/agencies.*): il cliente Medmar "cliente_sito" è
 * un dato tecnico verso il fornitore, distinto dal destinatario finale ITS
 * (agenzia/cliente) che non entra mai in questo payload.
 */
export function buildIssueCustomer(services: MedmarIssueServiceRow[], technicalEmail: string): MedmarIssueCustomer {
  const first = services[0];
  if (!first) throw new MedmarIssuePayloadError("servizio mancante.");
  const name = splitName(first.customer_name);
  return {
    nome: name.nome,
    cognome: name.cognome,
    telefono_1: requiredText(first.customer_phone, "telefono cliente"),
    email: requiredText(technicalEmail, "email tecnica Medmar"),
  };
}

function legsFromPreflight(preflight: MedmarPreflightResult): Array<{ leg: MedmarPreflightLeg; flagAr: "A" | "R" }> {
  const legs: Array<{ leg: MedmarPreflightLeg; flagAr: "A" | "R" }> = [];
  if (preflight.outward?.id_corsa != null) legs.push({ leg: preflight.outward, flagAr: "A" });
  if (preflight.return?.id_corsa != null) legs.push({ leg: preflight.return, flagAr: "R" });
  if (legs.length === 0) throw new MedmarIssuePayloadError("nessuna gamba live valida.");
  return legs;
}

/**
 * Fase 2B.5 — difesa in profondità: buildLockTickets/buildBookingPayload
 * costruiscono payload di MUTAZIONE reale (usati dall'orchestratore) e
 * gestiscono SOLO adulti (mai bambino/infant — vedi
 * buildMixedPassengerLockTickets più sotto, non wired a nessuna mutazione
 * reale). Il gate primario che impedisce a un gruppo con minori di
 * arrivare qui è in issue-orchestrator.ts (pre-check PRIMA di openTurn);
 * questo throw è un secondo livello indipendente, nel caso queste funzioni
 * vengano mai richiamate da un percorso diverso da quello attuale.
 */
function assertNoMinorsInPreflight(preflight: MedmarPreflightResult): void {
  const children = preflight.passengers?.children ?? 0;
  const infants = preflight.passengers?.infants ?? 0;
  if (children > 0 || infants > 0) {
    throw new MedmarIssuePayloadError("child_issue_payload_not_verified: bambino/infant presenti, payload di mutazione non costruibile.");
  }
}

/**
 * Fase 2D — root cause confermata confrontando il PDF Medmar reale D'ADDIO
 * (One Click, aggregato: 1 riga adulto quantita=2 per gamba, 2 numeri
 * biglietto totali) con il PDF Medmar reale PISCITELLI (2 adulti A/R,
 * struttura Medmar nativa: 4 numeri biglietto distinti, 1 riga adulto
 * quantita=1 + 1 riga tassa quantita=1 PER passeggero PER gamba — 8 righe
 * dettaglio[] totali). Il formato aggregato ha funzionato per D'Addio (booking
 * 735462 completata), ma non riflette la granularità nativa Medmar osservata
 * su un booking manuale strutturalmente identico — questa funzione ora
 * genera una riga (lock) per singolo passeggero, mai un'unica riga
 * aggregata, sia per l'adulto sia per l'eventuale tassa collegata.
 */
export function buildLockTickets(preflight: MedmarPreflightResult, vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>): MedmarMutationTicketLine[] {
  assertNoMinorsInPreflight(preflight);
  const lines: MedmarMutationTicketLine[] = [];
  for (const { leg } of legsFromPreflight(preflight)) {
    const vendibili = vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = findArTariffAndTax(vendibili);
    if (selection.kind !== "found") throw new MedmarIssuePayloadError("tariffa AR live non disponibile.");
    if (selection.taxIssue) {
      throw new MedmarIssuePayloadError(`tassa di sbarco non determinabile con certezza (${selection.taxIssue}).`);
    }
    const adultDescrizione = requiredText(resolveBigliettoLabel(selection.tariff).label, "descrizione biglietto adulto");
    for (let i = 0; i < preflight.pax; i++) {
      lines.push({
        id_corsa: leg.id_corsa!,
        quantita: 1,
        id_log: selection.tariff.id_log ?? "",
        descrizione: adultDescrizione,
      });
    }
    if (selection.tassaSbarco) {
      assertTassaSbarcoTipologia(selection.tassaSbarco);
      const taxDescrizione = requiredText(resolveBigliettoLabel(selection.tassaSbarco).label, "descrizione tassa");
      for (let i = 0; i < preflight.pax; i++) {
        lines.push({
          id_corsa: leg.id_corsa!,
          quantita: 1,
          id_log: selection.tassaSbarco.id_log ?? "",
          descrizione: taxDescrizione,
        });
      }
    }
  }
  return lines;
}

function ticketLineKey(line: { id_corsa: number | string; id_log: number | string; quantita: number; descrizione: string }): string {
  return `${line.id_corsa}|${line.id_log}|${line.quantita}|${line.descrizione}`;
}

/**
 * Fase 2D — con buildLockTickets che ora emette una riga per singolo
 * passeggero (mai più un'unica riga aggregata quantita=pax), più righe
 * richieste possono condividere ESATTAMENTE lo stesso contenuto (stesso
 * id_corsa/id_log/quantita=1/descrizione, un passeggero identico all'altro).
 * Il matching non può più pretendere un candidato unico per riga: raggruppa
 * per contenuto e richiede che il NUMERO di frozen candidati coincida
 * esattamente col numero di richieste identiche — mai una scelta arbitraria
 * su quale frozen vada a quale passeggero (sono interscambiabili per
 * costruzione, stesso id_log/descrizione/quantita).
 */
export function validateAdultFrozenTickets(requestedAdultLines: MedmarMutationTicketLine[], frozen: MedmarLockedTicket[]): MedmarLockedTicket[] {
  const adultLines = requestedAdultLines.filter((line) => /PASSAGGIO PONTE ADULTO/i.test(line.descrizione));

  const requestedCountByKey = new Map<string, number>();
  for (const line of adultLines) {
    const key = ticketLineKey(line);
    requestedCountByKey.set(key, (requestedCountByKey.get(key) ?? 0) + 1);
  }

  const matched: MedmarLockedTicket[] = [];
  for (const [key, count] of requestedCountByKey) {
    const candidates = frozen.filter((row) => ticketLineKey(row) === key);
    if (candidates.length !== count) {
      throw new MedmarIssuePayloadError("frozen adulto mancante o ambiguo.");
    }
    matched.push(...candidates);
  }
  return matched;
}

/** Righe passeggero (adult/child/infant) — MAI tassa, che non richiede frozen (vedi corsa reale 133760: TASSA non compare in output.congelati). */
const PASSENGER_LINE_HINT = /^PASSAGGIO PONTE (ADULTO|BAMBINO|INFANT)\b/i;

/**
 * Fase 2B.5 — generalizzazione di validateAdultFrozenTickets a
 * adult/child/infant (tax esclusa, per costruzione: PASSENGER_LINE_HINT non
 * la matcha mai). Stesso match deterministico: id_corsa + id_log +
 * quantita + descrizione, nessuna ambiguità tollerata. NON sostituisce
 * validateAdultFrozenTickets (che resta invariata per il percorso
 * solo-adulti già in produzione) — usata solo da
 * buildMixedPassengerLockTickets/test, non wired a nessuna mutazione reale.
 */
/**
 * Fase 2D — stesso adattamento a matching-per-conteggio di
 * validateAdultFrozenTickets (vedi commento lì): buildMixedPassengerLockTickets
 * ora emette righe multiple identiche per passeggeri della stessa categoria.
 */
export function validatePassengerFrozenTickets(requestedPassengerLines: MedmarMutationTicketLine[], frozen: MedmarLockedTicket[]): MedmarLockedTicket[] {
  const passengerLines = requestedPassengerLines.filter((line) => PASSENGER_LINE_HINT.test(line.descrizione));

  const requestedCountByKey = new Map<string, number>();
  for (const line of passengerLines) {
    const key = ticketLineKey(line);
    requestedCountByKey.set(key, (requestedCountByKey.get(key) ?? 0) + 1);
  }

  const matched: MedmarLockedTicket[] = [];
  for (const [key, count] of requestedCountByKey) {
    const candidates = frozen.filter((row) => ticketLineKey(row) === key);
    if (candidates.length !== count) {
      throw new MedmarIssuePayloadError("frozen passeggero mancante o ambiguo.");
    }
    matched.push(...candidates);
  }
  return matched;
}

/**
 * Fase 2B.5 — builder FIXTURE per adult/child/infant/tax, coerente con il
 * payload reale osservato (POST /prenotazioni/lock-disponibilita, corsa
 * 133760: 1 adulto + 1 bambino + 1 infant + 1 tax con quantita=2). NON
 * chiamata da issue-orchestrator.ts (grep statico verificabile): serve
 * SOLO a testare che il builder produca righe corrette per i minori senza
 * eseguire alcun lock reale — l'emissione minori resta bloccata dal gate
 * dell'orchestratore molto prima che questa funzione possa essere
 * raggiunta in produzione.
 */
/**
 * Fase 2D — stessa granularità per-passeggero applicata a buildLockTickets
 * (vedi commento lì): una riga quantita=1 per singolo passeggero di ciascuna
 * categoria, mai una riga aggregata quantita=count. Idem per la tassa
 * collegata: una riga quantita=1 per ciascun passeggero a cui risulta
 * collegata (non più un'unica riga con quantita=taxQuantity aggregato).
 * Resta FIXTURE ONLY (non wired a nessuna mutazione reale, vedi commento
 * sulla funzione più sotto) — nessun payload di prenotazione mixed-passenger
 * esiste ancora in produzione, l'emissione minori resta bloccata a monte.
 */
export function buildMixedPassengerLockTickets(
  preflight: MedmarPreflightResult,
  vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>
): MedmarMutationTicketLine[] {
  const passengers = preflight.passengers;
  if (!passengers) throw new MedmarIssuePayloadError("composizione passeggeri non disponibile.");

  const lines: MedmarMutationTicketLine[] = [];
  for (const { leg } of legsFromPreflight(preflight)) {
    const vendibili = vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = selectPassengerTariffs(vendibili);

    const categories: Array<[MedmarPassengerCategory, number, PassengerCategorySelection, string]> = [
      ["adult", passengers.adults, selection.adult, "descrizione biglietto adulto"],
      ["child", passengers.children, selection.child, "descrizione biglietto bambino"],
      ["infant", passengers.infants, selection.infant, "descrizione biglietto infant"],
    ];

    let taxQuantity = 0;
    for (const [category, count, categorySelection, fieldLabel] of categories) {
      if (count <= 0) continue;
      if (categorySelection.kind !== "found") throw new MedmarIssuePayloadError(`tariffa ${category} live non disponibile.`);
      const label = requiredText(resolveBigliettoLabel(categorySelection.ticket).label, fieldLabel);
      for (let i = 0; i < count; i++) {
        lines.push({
          id_corsa: leg.id_corsa!,
          quantita: 1,
          id_log: categorySelection.ticket.id_log ?? "",
          descrizione: label,
        });
      }

      const linkage = deriveTaxLinkage(category, categorySelection.ticket, selection.taxRows);
      if (linkage.linked) taxQuantity += count;
    }

    if (taxQuantity > 0 && selection.taxRows.length === 1) {
      const tax = selection.taxRows[0]!;
      assertTassaSbarcoTipologia(tax);
      const taxLabel = requiredText(resolveBigliettoLabel(tax).label, "descrizione tassa");
      for (let i = 0; i < taxQuantity; i++) {
        lines.push({
          id_corsa: leg.id_corsa!,
          quantita: 1,
          id_log: tax.id_log ?? "",
          descrizione: taxLabel,
        });
      }
    }
  }
  return lines;
}

/**
 * Fase 2D — root cause confermata confrontando D'ADDIO (One Click, aggregato:
 * 1 riga adulto quantita=2, 2 numeri biglietto totali) con PISCITELLI (2
 * adulti A/R, struttura Medmar nativa: 4 numeri biglietto distinti, 1 riga
 * adulto + 1 riga tassa PER passeggero PER gamba = 8 righe totali). Genera
 * ora una riga dettaglio[] per singolo passeggero (mai un'unica riga
 * aggregata quantita=pax), ciascuna col proprio id_biglietto_congelato
 * individuale (mai lo stesso frozen condiviso tra più passeggeri) e la
 * propria riga tassa collegata via id_child_riga.
 */
export function buildBookingPayload(input: {
  preflight: MedmarPreflightResult;
  services: MedmarIssueServiceRow[];
  vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>;
  frozenAdults: MedmarLockedTicket[];
  config: MedmarIssueConfig;
  sessionContext: MedmarIssueSessionContext;
  technicalEmail: string;
}): MedmarBookingPayload {
  assertNoMinorsInPreflight(input.preflight);
  const dettaglio: MedmarBookingDetailLine[] = [];
  let idRiga = 1;

  // Coda di biglietti congelati per corsa: ogni passeggero individuale
  // consuma UN frozen distinto, mai riusato per un altro passeggero della
  // stessa gamba (i frozen adulto sono interscambiabili per costruzione —
  // stesso id_log/descrizione/quantita — quindi l'ordine di consumo non è
  // significativo, ma il CONTEGGIO sì).
  const frozenQueueByCorsa = new Map<string, MedmarLockedTicket[]>();
  for (const row of input.frozenAdults) {
    const key = String(row.id_corsa);
    const queue = frozenQueueByCorsa.get(key) ?? [];
    queue.push(row);
    frozenQueueByCorsa.set(key, queue);
  }

  for (const { leg, flagAr } of legsFromPreflight(input.preflight)) {
    const vendibili = input.vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = findArTariffAndTax(vendibili);
    if (selection.kind !== "found") throw new MedmarIssuePayloadError("tariffa AR live non disponibile.");
    if (selection.taxIssue) {
      throw new MedmarIssuePayloadError(`tassa di sbarco non determinabile con certezza (${selection.taxIssue}).`);
    }
    const adult = selection.tariff;
    const adultLabel = requiredText(resolveBigliettoLabel(adult).label, "label adulto");
    const tax = selection.tassaSbarco;
    if (tax) assertTassaSbarcoTipologia(tax);
    const taxLabel = tax ? requiredText(resolveBigliettoLabel(tax).label, "label tassa") : null;

    const legFrozenQueue = frozenQueueByCorsa.get(String(leg.id_corsa)) ?? [];

    // Fase 2F — id_gruppo allineato alla logica nativa Medmar (osservata nel
    // JS del portale: s[e] = s.AR, incrementato per passeggero "esploso",
    // s.AR = max(s.A, s.R) a fine ciclo — Medmar ricostruisce il pairing A/R
    // cercando lo stesso id_gruppo sulla gamba opposta). Qui equivale a
    // riusare lo STESSO groupId (passengerIndex + 1) identico su andata e
    // ritorno per lo stesso passeggero: la posizione del passeggero nel
    // gruppo (0..pax-1) è deterministica e identica su entrambe le gambe
    // (stesso preflight.pax, stesso ordine di consumo dei frozen), quindi
    // passengerIndex da solo è sufficiente, senza bisogno di un contatore
    // stateful cross-gamba. La tassa collegata eredita SEMPRE lo stesso
    // groupId del proprio passeggero padre (id_child_riga la lega comunque).
    for (let passengerIndex = 0; passengerIndex < input.preflight.pax; passengerIndex++) {
      const frozen = legFrozenQueue.shift();
      if (!frozen || String(frozen.id_log) !== String(adult.id_log)) {
        throw new MedmarIssuePayloadError("id_biglietto_congelato adulto mancante per uno o più passeggeri.");
      }
      const passengerGroupId = passengerIndex + 1;
      const passengerRowId = idRiga;
      dettaglio.push({
        biglietto: adultLabel,
        checkin: true,
        flag_ar: flagAr,
        flag_collegabile: 0,
        flag_targa: 0,
        id_biglietto_congelato: frozen.id_biglietto_congelato,
        id_corsa: leg.id_corsa!,
        id_gruppo: passengerGroupId,
        id_iva: adult.id_iva,
        id_log: adult.id_log ?? "",
        id_riga: passengerRowId,
        id_tariffa: adult.id_tariffa,
        id_tipologia_passeggero: adult.id_tipologia_passeggero,
        prezzo: toNumber(adult.prezzo, "prezzo adulto"),
        prezzo_prevendita: adult.prezzo_prevendita ?? 0,
        quantita: 1,
        re: false,
      });
      idRiga += 1;

      if (tax) {
        dettaglio.push({
          biglietto: taxLabel!,
          flag_ar: flagAr,
          flag_collegabile: 0,
          flag_targa: 0,
          id_child_riga: passengerRowId,
          id_corsa: leg.id_corsa!,
          id_gruppo: passengerGroupId,
          id_iva: tax.id_iva,
          id_log: tax.id_log ?? "",
          id_riga: idRiga,
          id_tariffa: null,
          id_tipologia_passeggero: tax.id_tipologia_passeggero,
          prezzo: tax.prezzo ?? 0,
          prezzo_prevendita: tax.prezzo_prevendita ?? 0,
          quantita: 1,
        });
        idRiga += 1;
      }
    }
  }

  return {
    cliente_sito: buildIssueCustomer(input.services, input.technicalEmail),
    dettaglio,
    dettaglioMezzo: [],
    id_causale: input.config.causaleId,
    id_cliente: input.sessionContext.clienteId,
    id_modalita: input.config.modalitaId,
    id_prenotazione: null,
    id_turno: input.sessionContext.turnoId,
    id_vettore_andata: input.config.vettoreAndataId,
    id_vettore_ritorno: input.config.vettoreRitornoId,
    targa: { dettagli: [] },
    urlPagamento: null,
  };
}

/**
 * Test reale mirato (prenotazione GIANLUCA MEROLA, 2 adulti + 1 infant) —
 * builder di mutazione per gruppi misti, analogo a buildBookingPayload ma
 * generalizzato ad adult/child/infant invece del solo adulto. NON wired a
 * issue-orchestrator.ts (grep statico verificabile): i gate esistenti
 * (child_issue_payload_not_verified nel pre-check orchestrator,
 * can_issue:false forzato nel preflight, assertNoMinorsInPreflight qui sopra)
 * restano tutti attivi e bloccano l'emissione automatica minori in
 * produzione. Questa funzione serve solo a costruire/ispezionare il payload
 * reale con dati Medmar live, per verificare la correttezza prima di
 * decidere se e quando sbloccare il flusso.
 *
 * id_gruppo: stesso schema deterministico usato da buildBookingPayload
 * (indice progressivo del passeggero), esteso su 3 categorie con un
 * contatore condiviso — adulti prima, poi bambini, poi infant — cosicché
 * ogni passeggero fisico riceva lo STESSO id_gruppo su andata e ritorno
 * (stessa composizione, stesso ordine di categoria su entrambe le gambe).
 *
 * Tassa collegata per categoria: derivata da deriveTaxLinkage (fonte
 * collegati[] se disponibile, altrimenti euristica non verificata per
 * adulto/bambino, mai per infant) — MAI un valore fisso, coerente con
 * quanto già usato dal preflight per il ticket_breakdown.
 *
 * Matching frozen: per (id_corsa, id_log) invece che per ordine di arrivo
 * nella coda — la risposta lock (congelati) non garantisce lo stesso ordine
 * di invio delle richieste, mentre id_log identifica univocamente la
 * categoria/tariffa del frozen consumato.
 */
export function buildMixedPassengerBookingPayload(input: {
  preflight: MedmarPreflightResult;
  services: MedmarIssueServiceRow[];
  vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>;
  frozenPassengers: MedmarLockedTicket[];
  config: MedmarIssueConfig;
  sessionContext: MedmarIssueSessionContext;
  technicalEmail: string;
}): MedmarBookingPayload {
  const passengers = input.preflight.passengers;
  if (!passengers) throw new MedmarIssuePayloadError("composizione passeggeri non disponibile.");

  const dettaglio: MedmarBookingDetailLine[] = [];
  let idRiga = 1;

  const frozenByCorsaAndLog = new Map<string, MedmarLockedTicket[]>();
  for (const row of input.frozenPassengers) {
    const key = `${row.id_corsa}|${row.id_log}`;
    const bucket = frozenByCorsaAndLog.get(key) ?? [];
    bucket.push(row);
    frozenByCorsaAndLog.set(key, bucket);
  }

  const categories: Array<[MedmarPassengerCategory, number]> = [
    ["adult", passengers.adults],
    ["child", passengers.children],
    ["infant", passengers.infants],
  ];

  const groupIdsByCategory = new Map<MedmarPassengerCategory, number[]>();
  let nextGroupId = 1;
  for (const [category, count] of categories) {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(nextGroupId);
      nextGroupId += 1;
    }
    groupIdsByCategory.set(category, ids);
  }

  for (const { leg, flagAr } of legsFromPreflight(input.preflight)) {
    const vendibili = input.vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = selectPassengerTariffs(vendibili);

    for (const [category, count] of categories) {
      if (count <= 0) continue;
      const categorySelection = category === "adult" ? selection.adult : category === "child" ? selection.child : selection.infant;
      if (categorySelection.kind !== "found") throw new MedmarIssuePayloadError(`tariffa ${category} live non disponibile.`);
      const ticket = categorySelection.ticket;
      const label = requiredText(resolveBigliettoLabel(ticket).label, `label ${category}`);

      const linkage = deriveTaxLinkage(category, ticket, selection.taxRows);
      const tax = linkage.linked ? linkage.tax : null;
      if (tax) assertTassaSbarcoTipologia(tax);
      const taxLabel = tax ? requiredText(resolveBigliettoLabel(tax).label, "label tassa") : null;

      const groupIds = groupIdsByCategory.get(category)!;
      const frozenBucket = frozenByCorsaAndLog.get(`${leg.id_corsa}|${ticket.id_log}`) ?? [];

      for (let i = 0; i < count; i++) {
        const frozen = frozenBucket.shift();
        if (!frozen) {
          throw new MedmarIssuePayloadError(`id_biglietto_congelato ${category} mancante per uno o più passeggeri.`);
        }
        const passengerGroupId = groupIds[i]!;
        const passengerRowId = idRiga;
        dettaglio.push({
          biglietto: label,
          checkin: true,
          flag_ar: flagAr,
          flag_collegabile: 0,
          flag_targa: 0,
          id_biglietto_congelato: frozen.id_biglietto_congelato,
          id_corsa: leg.id_corsa!,
          id_gruppo: passengerGroupId,
          id_iva: ticket.id_iva,
          id_log: ticket.id_log ?? "",
          id_riga: passengerRowId,
          id_tariffa: ticket.id_tariffa,
          id_tipologia_passeggero: ticket.id_tipologia_passeggero,
          prezzo: toNumber(ticket.prezzo, `prezzo ${category}`),
          prezzo_prevendita: ticket.prezzo_prevendita ?? 0,
          quantita: 1,
          re: false,
        });
        idRiga += 1;

        if (tax) {
          dettaglio.push({
            biglietto: taxLabel!,
            flag_ar: flagAr,
            flag_collegabile: 0,
            flag_targa: 0,
            id_child_riga: passengerRowId,
            id_corsa: leg.id_corsa!,
            id_gruppo: passengerGroupId,
            id_iva: tax.id_iva,
            id_log: tax.id_log ?? "",
            id_riga: idRiga,
            id_tariffa: null,
            id_tipologia_passeggero: tax.id_tipologia_passeggero,
            prezzo: tax.prezzo ?? 0,
            prezzo_prevendita: tax.prezzo_prevendita ?? 0,
            quantita: 1,
          });
          idRiga += 1;
        }
      }
    }
  }

  return {
    cliente_sito: buildIssueCustomer(input.services, input.technicalEmail),
    dettaglio,
    dettaglioMezzo: [],
    id_causale: input.config.causaleId,
    id_cliente: input.sessionContext.clienteId,
    id_modalita: input.config.modalitaId,
    id_prenotazione: null,
    id_turno: input.sessionContext.turnoId,
    id_vettore_andata: input.config.vettoreAndataId,
    id_vettore_ritorno: input.config.vettoreRitornoId,
    targa: { dettagli: [] },
    urlPagamento: null,
  };
}
