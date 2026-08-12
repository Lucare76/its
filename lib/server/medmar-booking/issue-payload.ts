import { findArTariffAndTax, resolveBigliettoLabel, TASSA_SBARCO_TIPOLOGIA_PASSEGGERO } from "./live-parser";
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

export function buildIssueCustomer(services: MedmarIssueServiceRow[]): MedmarIssueCustomer {
  const first = services[0];
  if (!first) throw new MedmarIssuePayloadError("servizio mancante.");
  const name = splitName(first.customer_name);
  return {
    nome: name.nome,
    cognome: name.cognome,
    telefono_1: requiredText(first.customer_phone, "telefono cliente"),
    email: requiredText(first.customer_email, "email cliente"),
  };
}

function legsFromPreflight(preflight: MedmarPreflightResult): Array<{ leg: MedmarPreflightLeg; flagAr: "A" | "R" }> {
  const legs: Array<{ leg: MedmarPreflightLeg; flagAr: "A" | "R" }> = [];
  if (preflight.outward?.id_corsa != null) legs.push({ leg: preflight.outward, flagAr: "A" });
  if (preflight.return?.id_corsa != null) legs.push({ leg: preflight.return, flagAr: "R" });
  if (legs.length === 0) throw new MedmarIssuePayloadError("nessuna gamba live valida.");
  return legs;
}

export function buildLockTickets(preflight: MedmarPreflightResult, vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>): MedmarMutationTicketLine[] {
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

export function buildBookingPayload(input: {
  preflight: MedmarPreflightResult;
  services: MedmarIssueServiceRow[];
  vendibiliByCorsa: Map<string, BigliettoVendibileRaw[]>;
  frozenAdults: MedmarLockedTicket[];
  config: MedmarIssueConfig;
  sessionContext: MedmarIssueSessionContext;
}): MedmarBookingPayload {
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
    cliente_sito: buildIssueCustomer(input.services),
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
