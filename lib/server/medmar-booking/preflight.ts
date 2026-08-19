/**
 * Orchestrazione del preflight Medmar One Click — Fase 1.6 "mappatura
 * completa tratte + schema reale biglietti vendibili".
 *
 * Usa le 2 chiamate READ-ONLY reali verso Medmar (ricerca corse, biglietti
 * vendibili) per determinare corsa/tariffa. course-matcher.ts (orari
 * statici locali) resta SOLO come confronto diagnostico (warning), non
 * determina mai più can_issue=true da solo.
 *
 * FAIL-CLOSED: se Medmar non risponde (rete/timeout/5xx) o il token è
 * scaduto (401/403), can_issue è SEMPRE false, indipendentemente da quello
 * che direbbe il fallback locale. Lo stesso vale per dati strutturali
 * incoerenti (route_mismatch), tipologie passeggero non mappate
 * (unsupported_passenger_type) e prezzi/tasse live mancanti o ambigui.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { matchCourseByRouteAndTime } from "./course-matcher";
import { resolveLegRouteCode } from "./port-resolution";
import { mapTariffFromTicketMemory } from "./ticket-mapper";
import { getIdTrattaForRouteCode, getExpectedPortsForRouteCode } from "./route-mapping";
import type { CorsaMedmarRaw } from "./types";
import type { MedmarTicketRouteCode } from "@/lib/medmar-ticket-memory";
import {
  fetchCorseReadOnly,
  fetchBigliettiVendibiliReadOnly,
  MedmarAuthExpiredError,
  MedmarNotAvailableError,
  MedmarBadResponseError,
} from "./client";
import { MedmarNotConfiguredError, MedmarAuthFailedError } from "./auth";
import { findArTariffAndTax, resolveBigliettoLabel, selectPassengerTariffs, deriveTaxLinkage } from "./live-parser";
import type { PassengerCategorySelection, PassengerTariffSelection, MedmarPassengerCategory as LiveParserPassengerCategory } from "./live-parser";
import { resolvePassengerComposition } from "./passenger-composition";
import { getRouteDefinition } from "@/lib/medmar-ticket-memory";
import type {
  MedmarPreflightLeg,
  MedmarPreflightResult,
  MedmarPreflightServiceRow,
  MedmarPreflightWarning,
  MedmarPreflightTariff,
  MedmarPreflightTaxLine,
  MedmarPreflightPassengerTicket,
  MedmarPreflightTaxBreakdown,
  MedmarPreflightTicketBreakdown,
} from "./types";

const CANCELLED_STATUSES = new Set(["cancelled", "pending_cancellation"]);

function centsFromPrezzo(prezzo: number | null): number | null {
  return prezzo != null && Number.isFinite(prezzo) ? Math.round(prezzo * 100) : null;
}

/**
 * Fase 2B.5: costruisce la riga ticket_breakdown per una categoria
 * (adult/child/infant). count=0 -> null (categoria assente dal gruppo, non
 * un errore). count>0 ma tariffa non trovata/ambigua/non mappata -> prezzo
 * unitario/totale null, MAI un valore indovinato — visibile comunque per
 * diagnostica.
 */
function buildCategoryTicket(count: number, selection: PassengerCategorySelection): MedmarPreflightPassengerTicket | null {
  if (count <= 0) return null;
  if (selection.kind !== "found") {
    return { count, id_biglietto: null, id_log: null, label: null, unit_price_cents: null, total_cents: null };
  }
  const unit = centsFromPrezzo(selection.ticket.prezzo);
  return {
    count,
    id_biglietto: selection.ticket.id_biglietto,
    id_log: selection.ticket.id_log,
    label: resolveBigliettoLabel(selection.ticket).label,
    unit_price_cents: unit,
    total_cents: unit != null ? unit * count : null,
  };
}

/**
 * Fase 2B.5: quantità tax = numero di titoli (per categoria) che risultano
 * REALMENTE collegati alla tassa (deriveTaxLinkage), mai il totale pax del
 * gruppo. Ambiguità sul collegamento (più righe tax candidate) azzera il
 * conteggio invece di indovinare quale tassa si applica.
 */
function buildTaxBreakdown(
  counts: { adult: number; child: number; infant: number },
  selection: PassengerTariffSelection
): MedmarPreflightTaxBreakdown | null {
  if (selection.taxRows.length === 0) return null;

  const categories: Array<[LiveParserPassengerCategory, number, PassengerCategorySelection]> = [
    ["adult", counts.adult, selection.adult],
    ["child", counts.child, selection.child],
    ["infant", counts.infant, selection.infant],
  ];

  let taxCount = 0;
  let ambiguous = false;
  for (const [category, count, categorySelection] of categories) {
    if (count <= 0 || categorySelection.kind !== "found") continue;
    const linkage = deriveTaxLinkage(category, categorySelection.ticket, selection.taxRows);
    if (!linkage.linked) {
      if (linkage.source === "ambiguous") ambiguous = true;
      continue;
    }
    taxCount += count;
  }

  if (ambiguous) return { count: 0, label: null, unit_amount_cents: null, total_amount_cents: null };

  const taxRow = selection.taxRows.length === 1 ? selection.taxRows[0]! : null;
  const unit = taxRow ? centsFromPrezzo(taxRow.prezzo) : null;
  return {
    count: taxCount,
    label: taxRow ? resolveBigliettoLabel(taxRow).label : null,
    unit_amount_cents: unit,
    total_amount_cents: unit != null ? unit * taxCount : null,
  };
}

/** null se un componente ha count>0 ma prezzo non determinabile — mai un totale parziale indovinato. */
function sumTicketBreakdownTotal(breakdown: MedmarPreflightTicketBreakdown): number | null {
  let total = 0;
  for (const part of [breakdown.adult, breakdown.child, breakdown.infant] as const) {
    if (!part) continue;
    if (part.total_cents == null) return null;
    total += part.total_cents;
  }
  if (breakdown.taxes) {
    if (breakdown.taxes.total_amount_cents == null) return null;
    total += breakdown.taxes.total_amount_cents;
  }
  return total;
}

function extractPratica(notes: string | null): string | null {
  const match = (notes ?? "").match(/\[practice:([^\]]+)\]/);
  return match?.[1] ?? null;
}

function normalizeGroupKey(customerName: string | null, pratica: string | null): string {
  if (pratica) return pratica;
  return (customerName ?? "sconosciuto").trim().toLowerCase().replace(/\s+/g, " ");
}

function isMedmarService(row: MedmarPreflightServiceRow): boolean {
  return (row.vessel ?? "").toLowerCase().includes("medmar");
}

function toDopoLe(time: string | null): string {
  if (!time) return "00:00:00";
  const match = time.match(/^(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}:00` : "00:00:00";
}

function normalizeMedmarClockTime(time: string | null | undefined): string | null {
  const match = String(time ?? "").trim().match(/^([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) return null;
  return `${match[1]!.padStart(2, "0")}:${match[2]}`;
}

function resolveBookedFerryTime(row: MedmarPreflightServiceRow, direction: "outward" | "return") {
  const raw = direction === "return"
    ? row.orario_barca ?? row.return_time ?? null
    : row.outbound_time ?? row.time ?? null;
  return { raw, normalized: normalizeMedmarClockTime(raw) };
}

function isFlagSet(flag: boolean | number | null): boolean {
  return flag === true || flag === 1;
}

/**
 * Una corsa è candidata solo se: non chiusa, non sospesa, sulla tratta e
 * data richieste. La nave è descrittiva e NON entra nel matching.
 */
function isCandidateCorsa(c: CorsaMedmarRaw, expected: { idTratta: number; date: string }): boolean {
  if (isFlagSet(c.flag_chiuso)) return false;
  if (isFlagSet(c.flag_sospeso)) return false;
  if (c.id_tratta !== null && c.id_tratta !== expected.idTratta) return false;
  if (c.partenza_data !== null && c.partenza_data !== expected.date) return false;
  return true;
}

/**
 * Verifica strutturale BLOCCANTE della corsa candidata: id_tratta è già
 * garantito da isCandidateCorsa, qui si controllano id_porto_partenza,
 * id_porto_arrivo e la presenza di partenza_ora. Una corsa non viene MAI
 * accettata solo perché id_tratta coincide se i port IDs non coincidono —
 * qualunque incoerenza produce route_mismatch (can_issue sempre false), non
 * un semplice warning.
 */
function findStructuralMismatches(c: CorsaMedmarRaw, routeCode: MedmarTicketRouteCode): MedmarPreflightWarning[] {
  const mismatches: MedmarPreflightWarning[] = [];
  const expectedPorts = getExpectedPortsForRouteCode(routeCode);
  if (expectedPorts) {
    if (c.id_porto_partenza !== null && c.id_porto_partenza !== expectedPorts.idPortoPartenza) {
      mismatches.push({ code: "port_mismatch", message: `id_porto_partenza della corsa (${c.id_porto_partenza}) diverso da quello atteso per la tratta (${expectedPorts.idPortoPartenza}).` });
    }
    if (c.id_porto_arrivo !== null && c.id_porto_arrivo !== expectedPorts.idPortoArrivo) {
      mismatches.push({ code: "port_mismatch", message: `id_porto_arrivo della corsa (${c.id_porto_arrivo}) diverso da quello atteso per la tratta (${expectedPorts.idPortoArrivo}).` });
    }
  }
  if (c.partenza_ora === null) {
    mismatches.push({ code: "route_structural_incomplete", message: "partenza_ora mancante nella corsa restituita da Medmar: dati strutturali incompleti." });
  }
  return mismatches;
}

type LiveLegStatus = "ok" | "no_match" | "ambiguous" | "route_mismatch" | "manual_review" | "medmar_unavailable" | "medmar_auth_expired" | "medmar_auth_not_configured";

/**
 * Fase 2B.6 — vero solo per il "modello single-row" (vedi commento su
 * MedmarPreflightServiceRow.departure_date): la stessa riga porta sia i dati
 * di andata (date/time/vessel) sia quelli di ritorno (departure_date +
 * orario_barca/return_time), senza una seconda riga direction="departure".
 * Se manca uno qualunque di questi due segnali, la prenotazione resta
 * genuinamente sola andata (comportamento invariato).
 */
function hasEmbeddedReturnData(row: MedmarPreflightServiceRow): boolean {
  return Boolean(row.departure_date) && Boolean(row.orario_barca ?? row.return_time);
}

/**
 * Fase 2B.6 — ricostruisce la gamba di ritorno per il modello single-row,
 * SENZA creare alcuna riga services reale: la riga sintetica vive solo in
 * memoria e viene passata a resolveLegLive con lo stesso row.id, quindi
 * leg.service_ids resta [row.id] esattamente come per la gamba di andata.
 *
 * formula_medmar_napoli: il porto isolano di ritorno è sempre Ischia
 * (resolveIslandPort lo risolve così per costruzione, senza dipendere da
 * meeting_point) — nessuna ambiguità, si procede con il matching live.
 *
 * formula_medmar_pozzuoli: il porto isolano di ritorno dipende da
 * meeting_point (Ischia vs Casamicciola), ma nel modello single-row esiste
 * UN SOLO meeting_point sulla riga (quello dell'andata) — riusarlo per il
 * ritorno sarebbe un'assunzione silenziosa (l'andata potrebbe essere da
 * Casamicciola e il ritorno verso Ischia, o viceversa). Fail-closed:
 * manual_review, mai un porto indovinato.
 */
async function resolveEmbeddedReturnLeg(
  row: MedmarPreflightServiceRow,
  warnings: MedmarPreflightWarning[]
): Promise<{ leg: MedmarPreflightLeg; liveStatus: LiveLegStatus }> {
  if (row.booking_service_kind === "formula_medmar_pozzuoli") {
    warnings.push({
      code: "embedded_return_island_port_ambiguous",
      leg: "return",
      message:
        "Ritorno imbarcato nella stessa riga services (modello single-row) su tratta Pozzuoli: il porto isolano del ritorno non è determinabile da un campo distinto (l'unico meeting_point disponibile è quello dell'andata) — nessun fallback verso Ischia/Casamicciola, revisione manuale richiesta.",
    });
    return {
      leg: {
        direction: "return",
        route_code: null,
        route: null,
        mainland_port: null,
        island_port: null,
        date: row.departure_date ?? row.date,
        requested_time: null,
        matched_departure_time: null,
        candidate_count: null,
        match_source: null,
        vessel: row.vessel,
        service_ids: [row.id],
        id_corsa: null,
        source: null,
      },
      liveStatus: "manual_review",
    };
  }

  warnings.push({
    code: "embedded_return_leg_used",
    leg: "return",
    message:
      "Ritorno ricostruito dai campi departure_date/departure_time/orario_barca della stessa riga services (modello single-row, nessuna seconda riga direction=\"departure\" collegata).",
  });

  const syntheticDepartureRow: MedmarPreflightServiceRow = {
    ...row,
    date: row.departure_date ?? row.date,
    direction: "departure",
    orario_barca: row.orario_barca ?? row.return_time ?? null,
  };

  return resolveLegLive(syntheticDepartureRow, "return", warnings);
}

async function resolveLegLive(
  row: MedmarPreflightServiceRow,
  direction: "outward" | "return",
  warnings: MedmarPreflightWarning[]
): Promise<{ leg: MedmarPreflightLeg; liveStatus: LiveLegStatus }> {
  const resolution = resolveLegRouteCode({
    bookingServiceKind: row.booking_service_kind,
    direction: row.direction,
    meetingPoint: row.meeting_point,
  });

  const leg: MedmarPreflightLeg = {
    direction,
    route_code: resolution.status === "resolved" ? resolution.routeCode : null,
    route: null,
    mainland_port: resolution.status === "resolved" ? (resolution.mainlandPort as "napoli" | "pozzuoli") : null,
    island_port: resolution.status === "resolved" ? (resolution.islandPort as "ischia" | "casamicciola") : null,
    date: row.date,
    requested_time: null,
    matched_departure_time: null,
    candidate_count: null,
    match_source: null,
    vessel: row.vessel,
    service_ids: [row.id],
    id_corsa: null,
    source: null,
  };

  if (resolution.status === "unknown") {
    warnings.push({
      code: "route_not_determined",
      leg: direction,
      message: `Tratta Medmar non determinabile in modo affidabile dai dati del servizio (motivo: ${resolution.reason}; booking_service_kind=${row.booking_service_kind ?? "null"}; meeting_point=${row.meeting_point ?? "null"}). Nessun porto viene assunto per default: revisione manuale richiesta.`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const routeCode = resolution.routeCode;
  const def = getRouteDefinition(routeCode);
  leg.route = {
    from: def.departurePortKeywords[0]?.toUpperCase() ?? "?",
    to: def.arrivalPortKeywords[0]?.toUpperCase() ?? "?",
  };
  warnings.push({
    code: "island_port_resolved",
    leg: direction,
    message: `Porto isolano risolto = ${resolution.islandPort} (porto terraferma = ${resolution.mainlandPort}), da dati strutturati booking_service_kind + meeting_point.`,
  });

  const idTratta = getIdTrattaForRouteCode(routeCode);
  if (idTratta == null) {
    warnings.push({
      code: "route_not_mapped",
      leg: direction,
      message: `Nessun id_tratta Medmar verificato per la tratta ${leg.route.from} → ${leg.route.to}: revisione manuale richiesta (nessun ID inventato).`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const requestedFerryTime = resolveBookedFerryTime(row, direction);
  leg.requested_time = requestedFerryTime.normalized ?? requestedFerryTime.raw ?? null;
  if (!requestedFerryTime.raw) {
    warnings.push({
      code: "booked_ferry_time_missing",
      leg: direction,
      message: `Orario nave prenotato mancante per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
    });
    return { leg, liveStatus: "manual_review" };
  }
  if (!requestedFerryTime.normalized) {
    warnings.push({
      code: "booked_ferry_time_invalid",
      leg: direction,
      message: `Orario nave prenotato non valido per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const localDiagnostic = () => {
    const local = matchCourseByRouteAndTime(routeCode, requestedFerryTime.normalized);
    if (local.status === "matched") {
      warnings.push({
        code: "local_schedule_diagnostic",
        leg: direction,
        message: `Orario locale noto compatibile: ${local.matchedTime} (solo diagnostico, non usato per determinare can_issue).`,
      });
      return local.matchedTime;
    }
    return null;
  };

  try {
    const corse = await fetchCorseReadOnly({ idTratta, partenzaDataDal: row.date, dopoLe: toDopoLe(requestedFerryTime.normalized) });
    const candidates = corse.filter((c) => isCandidateCorsa(c, { idTratta, date: row.date }));

    if (candidates.length === 0) {
      localDiagnostic();
      return { leg, liveStatus: "no_match" };
    }

    const structurallyValid: CorsaMedmarRaw[] = [];
    const structuralWarnings: MedmarPreflightWarning[] = [];
    for (const candidate of candidates) {
      const mismatches = findStructuralMismatches(candidate, routeCode);
      if (mismatches.length === 0) structurallyValid.push(candidate);
      else structuralWarnings.push(...mismatches);
    }
    if (structurallyValid.length === 0) {
      warnings.push(...structuralWarnings.map((w) => ({ ...w, leg: direction })));
      leg.candidate_count = 0;
      return { leg, liveStatus: "route_mismatch" };
    }

    const exactTimeMatches = structurallyValid.filter(
      (candidate) => normalizeMedmarClockTime(candidate.partenza_ora) === requestedFerryTime.normalized
    );
    leg.candidate_count = exactTimeMatches.length;

    if (exactTimeMatches.length === 0) {
      localDiagnostic();
      return { leg, liveStatus: "no_match" };
    }
    if (exactTimeMatches.length > 1) {
      warnings.push({
        code: "course_ambiguous",
        leg: direction,
        message: `Più corse Medmar live compatibili per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
      });
      return { leg, liveStatus: "ambiguous" };
    }

    const only = exactTimeMatches[0]!;
    leg.id_corsa = only.id_corsa;
    leg.vessel = only.nave ?? leg.vessel;
    leg.matched_departure_time = only.partenza_ora;
    leg.match_source = "booked_ferry_time";
    leg.source = "live";

    const localMatchedTime = localDiagnostic();
    if (localMatchedTime && only.partenza_ora && normalizeMedmarClockTime(localMatchedTime) !== normalizeMedmarClockTime(only.partenza_ora)) {
      warnings.push({
        code: "local_schedule_mismatch",
        leg: direction,
        message: `L'orario Medmar live (${only.partenza_ora}) differisce dall'orario noto localmente (${localMatchedTime}).`,
      });
    }

    return { leg, liveStatus: "ok" };
  } catch (err) {
    if (err instanceof MedmarNotConfiguredError) {
      return { leg, liveStatus: "medmar_auth_not_configured" };
    }
    if (err instanceof MedmarAuthExpiredError) {
      return { leg, liveStatus: "medmar_auth_expired" };
    }
    warnings.push({
      code: "medmar_live_unavailable",
      leg: direction,
      message: err instanceof MedmarNotAvailableError || err instanceof MedmarBadResponseError || err instanceof MedmarAuthFailedError
        ? err.message
        : "Errore imprevisto nella chiamata Medmar live.",
    });
    leg.matched_departure_time = localDiagnostic();
    if (leg.matched_departure_time) leg.source = "local_fallback";
    return { leg, liveStatus: "medmar_unavailable" };
  }
}

export async function runMedmarPreflight(
  admin: SupabaseClient,
  tenantId: string,
  serviceIds: string[]
): Promise<MedmarPreflightResult> {
  const warnings: MedmarPreflightWarning[] = [];

  const { data, error } = await admin
    .from("services")
    .select("id, tenant_id, date, time, outbound_time, return_time, orario_barca, customer_name, pax, vessel, notes, booking_service_kind, direction, status, meeting_point, ferry_details, departure_date, departure_time")
    .in("id", serviceIds)
    .eq("tenant_id", tenantId);

  if (error) {
    return errorResult("db_error", "Errore nel recupero dei servizi.", serviceIds);
  }

  const rows = (data ?? []) as MedmarPreflightServiceRow[];
  if (rows.length === 0 || rows.length !== serviceIds.length) {
    return errorResult("service_not_found", "Uno o più servizi non sono stati trovati per questo tenant.", serviceIds);
  }

  if (rows.some((r) => CANCELLED_STATUSES.has(r.status ?? ""))) {
    return errorResult("service_cancelled", "Uno o più servizi selezionati sono stati cancellati.", serviceIds);
  }

  if (rows.some((r) => !isMedmarService(r))) {
    return {
      ok: true, can_issue: false, status: "not_medmar",
      group_key: normalizeGroupKey(rows[0]!.customer_name, extractPratica(rows[0]!.notes)),
      customer_name: rows[0]!.customer_name, pratica: extractPratica(rows[0]!.notes),
      pax: Math.max(...rows.map((r) => r.pax ?? 1)),
      outward: null, return: null, tariff: null, taxes: [], expected_total_cents: null, is_live: false,
      warnings: [{ code: "not_medmar", message: "Uno o più servizi selezionati non sono servizi Medmar (campo vessel)." }],
      error: null,
      passengers: null,
      ticket_breakdown: null,
    };
  }

  const groupKeys = new Set(rows.map((r) => normalizeGroupKey(r.customer_name, extractPratica(r.notes))));
  if (groupKeys.size > 1) {
    return errorResult("group_incoherent", "I servizi selezionati non appartengono allo stesso cliente/pratica.", serviceIds);
  }

  const first = rows[0]!;
  const pratica = extractPratica(first.notes);
  const groupKey = normalizeGroupKey(first.customer_name, pratica);
  const pax = Math.max(...rows.map((r) => r.pax ?? 1));
  // Fase 2B.5 — fonte strutturata (services.ferry_details), MAI dedotta da
  // notes. Fallback adults=pax/children=0/infants=0 quando non valorizzata
  // (prenotazioni precedenti alla Fase 2B.5): preserva byte-per-byte il
  // comportamento "solo adulti" già in produzione.
  const passengers = resolvePassengerComposition(rows.map((r) => ({ pax: r.pax, ferry_details: r.ferry_details })));
  const hasMinors = passengers.children > 0 || passengers.infants > 0;
  if (passengers.source === "medmar_counts" && passengers.adults + passengers.children + passengers.infants !== pax) {
    warnings.push({
      code: "passenger_count_mismatch",
      message: `Somma passeggeri per categoria (${passengers.adults + passengers.children + passengers.infants}) diversa dal campo pax del servizio (${pax}): verificare i dati di prenotazione.`,
    });
  }

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const arrivalRow = sorted.find((r) => r.direction === "arrival") ?? null;
  const departureRow = sorted.find((r) => r.direction === "departure") ?? null;

  if (!arrivalRow && !departureRow) {
    return errorResult("no_leg_recognized", "Nessuna direzione (arrivo/partenza) riconosciuta nei servizi selezionati.", serviceIds);
  }

  // Fase 2B.6 — modello single-row: solo quando l'UNICO servizio selezionato
  // è una riga arrival che porta anche i dati di ritorno nei suoi stessi
  // campi (nessuna riga departure reale nel gruppo). Limitato a rows.length
  // === 1 per non alterare in alcun modo il comportamento già testato del
  // modello a due righe, anche in presenza di dati departure_date storici
  // "orfani" su una riga che fa comunque parte di un gruppo a 2+ righe.
  const embeddedReturnRow =
    rows.length === 1 && arrivalRow && !departureRow && hasEmbeddedReturnData(arrivalRow) ? arrivalRow : null;

  const outwardOutcome = arrivalRow ? await resolveLegLive(arrivalRow, "outward", warnings) : null;
  const returnOutcome = departureRow
    ? await resolveLegLive(departureRow, "return", warnings)
    : embeddedReturnRow
      ? await resolveEmbeddedReturnLeg(embeddedReturnRow, warnings)
      : null;

  const legStatuses = [outwardOutcome?.liveStatus, returnOutcome?.liveStatus].filter((s): s is LiveLegStatus => Boolean(s));

  // Fase 2G — un A/R Medmar è valido se andata e ritorno condividono lo
  // stesso porto mainland (stessa "famiglia" formula_medmar_napoli /
  // formula_medmar_pozzuoli): la direzione opposta rispetto al continente è
  // già garantita per costruzione da resolveLegRouteCode (arrival = sempre
  // mainland->island, departure = sempre island->mainland), quindi non va
  // riverificata qui. Il porto ISOLANO può invece differire tra le due gambe
  // (operatività reale: arrivo su Casamicciola, ripartenza da Ischia, o
  // viceversa) — non più bloccante, solo un warning informativo per
  // l'operatore. Resta bloccante SOLO un mainland diverso tra le due gambe
  // (route non supportata/famiglia diversa — es. Napoli vs Pozzuoli).
  const outwardMainland = outwardOutcome?.leg.mainland_port ?? null;
  const returnMainland = returnOutcome?.leg.mainland_port ?? null;
  const outwardIsland = outwardOutcome?.leg.island_port ?? null;
  const returnIsland = returnOutcome?.leg.island_port ?? null;
  const legRouteMismatch =
    outwardMainland !== null && returnMainland !== null && outwardMainland !== returnMainland;
  if (legRouteMismatch) {
    warnings.push({
      code: "leg_route_mismatch",
      message: `La tratta di andata (${outwardOutcome?.leg.route_code}) e quella di ritorno (${returnOutcome?.leg.route_code}) non condividono lo stesso porto terraferma (${outwardMainland} vs ${returnMainland}): revisione manuale richiesta.`,
    });
  } else if (outwardIsland !== null && returnIsland !== null && outwardIsland !== returnIsland) {
    warnings.push({
      code: "island_port_differs_between_legs",
      message: `Il porto isolano di arrivo e quello di ripartenza sono diversi: ${outwardIsland === "casamicciola" ? "Casamicciola" : "Ischia"} → ${returnIsland === "casamicciola" ? "Casamicciola" : "Ischia"}. Verificare che sia voluto.`,
    });
  }

  let status: MedmarPreflightResult["status"];
  if (legStatuses.includes("medmar_auth_not_configured")) status = "medmar_auth_not_configured";
  else if (legStatuses.includes("medmar_auth_expired")) status = "medmar_auth_expired";
  else if (legStatuses.includes("medmar_unavailable")) status = "medmar_unavailable";
  else if (legStatuses.includes("route_mismatch")) status = "route_mismatch";
  else if (legStatuses.includes("no_match")) status = "no_match";
  else if (legStatuses.includes("ambiguous")) status = "ambiguous";
  else if (legStatuses.includes("manual_review")) status = "manual_review";
  else if (legRouteMismatch) status = "manual_review";
  else status = "ok";

  const baseResult: MedmarPreflightResult = {
    ok: true, can_issue: false, status, group_key: groupKey,
    customer_name: first.customer_name, pratica, pax,
    outward: outwardOutcome?.leg ?? null, return: returnOutcome?.leg ?? null,
    tariff: null, taxes: [], expected_total_cents: null, is_live: false,
    warnings, error: null,
    passengers,
    ticket_breakdown: null,
  };

  if (status !== "ok") {
    return baseResult;
  }

  // Tutte le gambe live "ok": recupera tariffa/tasse per OGNI gamba
  // separatamente (Fase 2B.7 — bugfix: la versione precedente leggeva
  // biglietti/vendibili di UNA SOLA corsa "di riferimento" e moltiplicava
  // solo per pax, perdendo silenziosamente il prezzo della seconda gamba su
  // un vero A/R). Ogni gamba ha la propria id_corsa e la propria risposta
  // vendibili: nessun prezzo viene mai riusato tra andata e ritorno.
  const legsToPrice = [outwardOutcome?.leg ?? null, returnOutcome?.leg ?? null].filter(
    (l): l is MedmarPreflightLeg => l != null && l.id_corsa != null
  );
  if (legsToPrice.length === 0) {
    return { ...baseResult, status: "manual_review", warnings: [...warnings, { code: "no_id_corsa", message: "Nessun id_corsa live disponibile per recuperare la tariffa." }] };
  }

  try {
    const priced: Array<{
      leg: MedmarPreflightLeg;
      tariff: MedmarPreflightTariff;
      taxes: MedmarPreflightTaxLine[];
      ticketBreakdown: MedmarPreflightTicketBreakdown;
      totalCents: number;
    }> = [];

    for (const leg of legsToPrice) {
      const legLabel = leg.direction === "outward" ? "andata" : "ritorno";
      const vendibili = await fetchBigliettiVendibiliReadOnly(leg.id_corsa!);
      const selection = findArTariffAndTax(vendibili);

      if (selection.kind === "not_found") {
        const fallback = await mapTariffFromTicketMemory(admin, tenantId, serviceIds);
        return {
          ...baseResult,
          tariff: fallback.tariff,
          expected_total_cents: fallback.expectedTotalCents,
          is_live: false,
          warnings: [...warnings, ...fallback.warnings, { code: "ar_tariff_not_found_live", leg: leg.direction, message: `Tariffa AR non trovata nella risposta Medmar live per la gamba di ${legLabel}: usata memoria ticket come riferimento diagnostico (non sufficiente per emissione).` }],
        };
      }

      if (selection.kind === "unsupported_passenger_type") {
        return {
          ...baseResult,
          status: "unsupported_passenger_type",
          warnings: [...warnings, { code: "unsupported_passenger_type", leg: leg.direction, message: `Trovato un biglietto AR compatibile per descrizione ma con id_tipologia_passeggero=${selection.row.id_tipologia_passeggero} non mappato (atteso adulto) sulla gamba di ${legLabel}: revisione manuale richiesta.` }],
        };
      }

      if (selection.kind === "ambiguous_tariff") {
        return {
          ...baseResult,
          status: "manual_review",
          warnings: [...warnings, { code: "ar_tariff_ambiguous", leg: leg.direction, message: `Più righe candidate per la tariffa AR adulto nella risposta Medmar live sulla gamba di ${legLabel}: nessuna scelta arbitraria, revisione manuale richiesta.` }],
        };
      }

      const { tariff: tariffRow, labelSource, tassaSbarco, taxIssue } = selection;
      if (labelSource === "nome") {
        // La label primaria (descrizione) mancava su questa riga: la tariffa
        // è comunque stata identificata correttamente (stessa regex sulla
        // label secondaria), ma il caso è raro/inatteso e va segnalato per
        // diagnostica — non blocca can_issue.
        warnings.push({ code: "ar_label_from_nome", leg: leg.direction, message: `Etichetta della tariffa AR risolta dal campo 'nome' sulla gamba di ${legLabel} (campo 'descrizione' assente o vuoto sulla riga): verificare se atteso.` });
      }

      // Prezzo live mancante, nullo o incoerente: mai can_issue=true su dati incompleti.
      if (tariffRow.prezzo == null || !Number.isFinite(tariffRow.prezzo)) {
        return {
          ...baseResult,
          status: "manual_review",
          warnings: [...warnings, { code: "ticket_data_incomplete", leg: leg.direction, message: `Prezzo della tariffa AR mancante o non numerico nella risposta Medmar live sulla gamba di ${legLabel}: dati insufficienti per l'emissione.` }],
        };
      }

      if (taxIssue) {
        return {
          ...baseResult,
          status: "manual_review",
          warnings: [
            ...warnings,
            {
              code: "ticket_data_incomplete",
              leg: leg.direction,
              message: (taxIssue === "ambiguous"
                ? "Più righe TASSA DI SBARCO trovate nella risposta Medmar live"
                : "Tassa di sbarco individuata ma senza prezzo nella risposta Medmar live") + ` sulla gamba di ${legLabel}: impossibile calcolare il totale con certezza.`,
            },
          ],
        };
      }

      const taxes: MedmarPreflightTaxLine[] = tassaSbarco
        ? [{ label: resolveBigliettoLabel(tassaSbarco).label ?? "TASSA DI SBARCO", amount_cents: Math.round(tassaSbarco.prezzo! * 100) }]
        : [];

      const unitPriceCents = Math.round(tariffRow.prezzo * 100);
      // Totale di QUESTA gamba soltanto: unit_price × pax. Il totale A/R è
      // la somma dei totali per-gamba fatta più sotto — MAI un'unica
      // moltiplicazione unit_price × pax condivisa tra andata e ritorno.
      const legTotalCents = (unitPriceCents + (taxes[0]?.amount_cents ?? 0)) * pax;

      const tariff: MedmarPreflightTariff = {
        id_biglietto: tariffRow.id_biglietto,
        id_tariffa: tariffRow.id_tariffa,
        label: resolveBigliettoLabel(tariffRow).label,
        unit_price_cents: unitPriceCents,
        source: "medmar_live",
      };

      // Fase 2B.5/2B.7 — classificazione adult/child/infant/tax sulla STESSA
      // risposta vendibili di QUESTA gamba (nessuna seconda chiamata Medmar
      // per lo stesso id_corsa, ma una chiamata indipendente per gamba).
      const passengerSelection = selectPassengerTariffs(vendibili);
      const ticketBreakdown: MedmarPreflightTicketBreakdown = {
        adult: buildCategoryTicket(passengers.adults, passengerSelection.adult),
        child: buildCategoryTicket(passengers.children, passengerSelection.child),
        infant: buildCategoryTicket(passengers.infants, passengerSelection.infant),
        taxes: buildTaxBreakdown({ adult: passengers.adults, child: passengers.children, infant: passengers.infants }, passengerSelection),
      };

      if (hasMinors) {
        if (passengerSelection.child.kind === "ambiguous" || passengerSelection.infant.kind === "ambiguous") {
          warnings.push({ code: "child_issue_payload_not_verified", leg: leg.direction, message: `Più righe candidate per bambino/infant nella risposta Medmar live sulla gamba di ${legLabel}: revisione manuale richiesta oltre al blocco emissione minori.` });
        }
        if (passengers.children > 0 && passengerSelection.child.kind !== "found") {
          warnings.push({ code: "child_ticket_not_found_live", leg: leg.direction, message: `Bambino presente nel gruppo ma nessun biglietto BAMBINO corrispondente trovato nella risposta Medmar live sulla gamba di ${legLabel}.` });
        }
        if (passengers.infants > 0 && passengerSelection.infant.kind !== "found") {
          warnings.push({ code: "infant_ticket_not_found_live", leg: leg.direction, message: `Infant presente nel gruppo ma nessun biglietto INFANT corrispondente trovato nella risposta Medmar live sulla gamba di ${legLabel}.` });
        }
      }

      priced.push({ leg, tariff, taxes, ticketBreakdown, totalCents: legTotalCents });
    }

    // Ogni gamba di legsToPrice ha prodotto una riga in priced (altrimenti la
    // funzione sarebbe già uscita con un return anticipato sopra): la somma
    // è quindi sempre determinabile con certezza qui — mai un A/R "ok" con
    // una gamba non prezzata. expected_total_cents = somma dei totali
    // per-gamba, MAI unit_price × pax calcolato una sola volta.
    const expectedTotalCents = priced.reduce((sum, p) => sum + p.totalCents, 0);

    const outwardPriced = priced.find((p) => p.leg.direction === "outward") ?? null;
    const returnPriced = priced.find((p) => p.leg.direction === "return") ?? null;
    const referencePriced = outwardPriced ?? returnPriced!;

    const outwardLeg = outwardOutcome?.leg
      ? { ...outwardOutcome.leg, ticket_breakdown: outwardPriced?.ticketBreakdown ?? null, total_cents: outwardPriced?.totalCents ?? null }
      : null;
    const returnLeg = returnOutcome?.leg
      ? { ...returnOutcome.leg, ticket_breakdown: returnPriced?.ticketBreakdown ?? null, total_cents: returnPriced?.totalCents ?? null }
      : null;

    if (!hasMinors) {
      return {
        ...baseResult,
        outward: outwardLeg,
        return: returnLeg,
        can_issue: true,
        tariff: referencePriced.tariff,
        taxes: referencePriced.taxes,
        expected_total_cents: expectedTotalCents,
        is_live: true,
        ticket_breakdown: referencePriced.ticketBreakdown,
      };
    }

    // Bambino/infant presenti: preflight e prezzo possono essere completi,
    // ma l'emissione resta VOLUTAMENTE fail-closed (Fase 2B.5 non abilita
    // ancora l'emissione automatica minori) — can_issue sempre false qui,
    // indipendentemente da quanto sia completo ticket_breakdown.
    warnings.push({
      code: "child_issue_payload_not_verified",
      message: "Il prezzo Medmar è stato verificato, ma l'emissione automatica dei minori non è ancora abilitata: revisione/emissione manuale richiesta.",
    });

    const minorsAwareTotals = priced.map((p) => sumTicketBreakdownTotal(p.ticketBreakdown));
    const minorsAwareTotal = minorsAwareTotals.every((t) => t != null)
      ? minorsAwareTotals.reduce<number>((sum, t) => sum + (t as number), 0)
      : null;

    return {
      ...baseResult,
      outward: outwardLeg,
      return: returnLeg,
      can_issue: false,
      status: "passenger_payload_pending_verification",
      tariff: referencePriced.tariff,
      taxes: referencePriced.taxes,
      expected_total_cents: minorsAwareTotal ?? expectedTotalCents,
      is_live: true,
      ticket_breakdown: referencePriced.ticketBreakdown,
      warnings,
    };
  } catch (err) {
    if (err instanceof MedmarNotConfiguredError) {
      return { ...baseResult, status: "medmar_auth_not_configured" };
    }
    if (err instanceof MedmarAuthExpiredError) {
      return { ...baseResult, status: "medmar_auth_expired" };
    }
    return {
      ...baseResult,
      status: "medmar_unavailable",
      warnings: [...warnings, { code: "medmar_live_unavailable", message: err instanceof MedmarNotAvailableError || err instanceof MedmarBadResponseError || err instanceof MedmarAuthFailedError ? err.message : "Errore imprevisto nel recupero biglietti vendibili." }],
    };
  }
}

function errorResult(code: string, message: string, serviceIds: string[]): MedmarPreflightResult {
  return {
    ok: false, can_issue: false, status: "error", group_key: serviceIds.join(","),
    customer_name: null, pratica: null, pax: 0, outward: null, return: null,
    tariff: null, taxes: [], expected_total_cents: null, is_live: false,
    warnings: [], error: `${code}: ${message}`,
    passengers: null,
    ticket_breakdown: null,
  };
}
