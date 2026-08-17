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

export function buildLockTickets(preflight: MedmarPreflightResult, vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>): MedmarMutationTicketLine[] {
  assertNoMinorsInPreflight(preflight);
  const lines: MedmarMutationTicketLine[] = [];
  for (const { leg } of legsFromPreflight(preflight)) {
    const vendibili = vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = findArTariffAndTax(vendibili);
    if (selection.kind !== "found") throw new MedmarIssuePayloadError("tariffa AR live non disponibile.");
    const label = resolveBigliettoLabel(selection.tariff).label;
    lines.push({
      id_corsa: leg.id_corsa!,
      quantita: preflight.pax,
      id_log: selection.tariff.id_log ?? "",
      descrizione: requiredText(label, "descrizione biglietto adulto"),
    });
    if (selection.tassaSbarco) {
      assertTassaSbarcoTipologia(selection.tassaSbarco);
      const taxLabel = resolveBigliettoLabel(selection.tassaSbarco).label;
      lines.push({
        id_corsa: leg.id_corsa!,
        quantita: preflight.pax,
        id_log: selection.tassaSbarco.id_log ?? "",
        descrizione: requiredText(taxLabel, "descrizione tassa"),
      });
    }
  }
  return lines;
}

export function validateAdultFrozenTickets(requestedAdultLines: MedmarMutationTicketLine[], frozen: MedmarLockedTicket[]): MedmarLockedTicket[] {
  const adultLines = requestedAdultLines.filter((line) => /PASSAGGIO PONTE ADULTO/i.test(line.descrizione));
  const matched: MedmarLockedTicket[] = [];
  for (const line of adultLines) {
    const candidates = frozen.filter((row) =>
      String(row.id_corsa) === String(line.id_corsa) &&
      String(row.id_log) === String(line.id_log) &&
      row.quantita === line.quantita &&
      row.descrizione === line.descrizione
    );
    if (candidates.length !== 1) {
      throw new MedmarIssuePayloadError("frozen adulto mancante o ambiguo.");
    }
    matched.push(candidates[0]!);
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
export function validatePassengerFrozenTickets(requestedPassengerLines: MedmarMutationTicketLine[], frozen: MedmarLockedTicket[]): MedmarLockedTicket[] {
  const passengerLines = requestedPassengerLines.filter((line) => PASSENGER_LINE_HINT.test(line.descrizione));
  const matched: MedmarLockedTicket[] = [];
  for (const line of passengerLines) {
    const candidates = frozen.filter((row) =>
      String(row.id_corsa) === String(line.id_corsa) &&
      String(row.id_log) === String(line.id_log) &&
      row.quantita === line.quantita &&
      row.descrizione === line.descrizione
    );
    if (candidates.length !== 1) {
      throw new MedmarIssuePayloadError("frozen passeggero mancante o ambiguo.");
    }
    matched.push(candidates[0]!);
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
      const label = resolveBigliettoLabel(categorySelection.ticket).label;
      lines.push({
        id_corsa: leg.id_corsa!,
        quantita: count,
        id_log: categorySelection.ticket.id_log ?? "",
        descrizione: requiredText(label, fieldLabel),
      });

      const linkage = deriveTaxLinkage(category, categorySelection.ticket, selection.taxRows);
      if (linkage.linked) taxQuantity += count;
    }

    if (taxQuantity > 0 && selection.taxRows.length === 1) {
      const tax = selection.taxRows[0]!;
      assertTassaSbarcoTipologia(tax);
      const taxLabel = resolveBigliettoLabel(tax).label;
      lines.push({
        id_corsa: leg.id_corsa!,
        quantita: taxQuantity,
        id_log: tax.id_log ?? "",
        descrizione: requiredText(taxLabel, "descrizione tassa"),
      });
    }
  }
  return lines;
}

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
  for (const { leg, flagAr } of legsFromPreflight(input.preflight)) {
    const vendibili = input.vendibiliByCorsa.get(String(leg.id_corsa)) ?? [];
    const selection = findArTariffAndTax(vendibili);
    if (selection.kind !== "found") throw new MedmarIssuePayloadError("tariffa AR live non disponibile.");
    const adult = selection.tariff;
    const adultLabel = requiredText(resolveBigliettoLabel(adult).label, "label adulto");
    const frozen = input.frozenAdults.find((row) => String(row.id_corsa) === String(leg.id_corsa) && String(row.id_log) === String(adult.id_log));
    if (!frozen) throw new MedmarIssuePayloadError("id_biglietto_congelato adulto mancante.");
    const adultRowId = idRiga;
    dettaglio.push({
      biglietto: adultLabel,
      checkin: true,
      flag_ar: flagAr,
      flag_collegabile: 0,
      flag_targa: 0,
      id_biglietto_congelato: frozen.id_biglietto_congelato,
      id_corsa: leg.id_corsa!,
      id_gruppo: 1,
      id_iva: adult.id_iva,
      id_log: adult.id_log ?? "",
      id_riga: adultRowId,
      id_tariffa: adult.id_tariffa,
      id_tipologia_passeggero: adult.id_tipologia_passeggero,
      prezzo: toNumber(adult.prezzo, "prezzo adulto"),
      prezzo_prevendita: adult.prezzo_prevendita ?? 0,
      quantita: input.preflight.pax,
      re: false,
    });
    idRiga += 1;

    if (selection.tassaSbarco) {
      const tax = selection.tassaSbarco;
      assertTassaSbarcoTipologia(tax);
      dettaglio.push({
        biglietto: requiredText(resolveBigliettoLabel(tax).label, "label tassa"),
        flag_ar: flagAr,
        flag_collegabile: 0,
        flag_targa: 0,
        id_child_riga: adultRowId,
        id_corsa: leg.id_corsa!,
        id_gruppo: 1,
        id_iva: tax.id_iva,
        id_log: tax.id_log ?? "",
        id_riga: idRiga,
        id_tariffa: null,
        id_tipologia_passeggero: tax.id_tipologia_passeggero,
        prezzo: tax.prezzo ?? 0,
        prezzo_prevendita: tax.prezzo_prevendita ?? 0,
        quantita: input.preflight.pax,
      });
      idRiga += 1;
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
