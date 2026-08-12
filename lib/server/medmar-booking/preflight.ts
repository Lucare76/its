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
import { getIdTrattaForRouteCode, getExpectedPortsForRouteCode, isMirrorRouteCode } from "./route-mapping";
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
import { findArTariffAndTax, resolveBigliettoLabel } from "./live-parser";
import { getRouteDefinition } from "@/lib/medmar-ticket-memory";
import type {
  MedmarPreflightLeg,
  MedmarPreflightResult,
  MedmarPreflightServiceRow,
  MedmarPreflightWarning,
  MedmarPreflightTaxLine,
} from "./types";

const CANCELLED_STATUSES = new Set(["cancelled", "pending_cancellation"]);

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
    message: `Porto isolano risolto = ${resolution.islandPort} (porto terraferma = ${resolution.mainlandPort}), da dati strutturati booking_service_kind + meeting_point.`,
  });

  const idTratta = getIdTrattaForRouteCode(routeCode);
  if (idTratta == null) {
    warnings.push({
      code: "route_not_mapped",
      message: `Nessun id_tratta Medmar verificato per la tratta ${leg.route.from} → ${leg.route.to}: revisione manuale richiesta (nessun ID inventato).`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const requestedFerryTime = resolveBookedFerryTime(row, direction);
  leg.requested_time = requestedFerryTime.normalized ?? requestedFerryTime.raw ?? null;
  if (!requestedFerryTime.raw) {
    warnings.push({
      code: "booked_ferry_time_missing",
      message: `Orario nave prenotato mancante per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
    });
    return { leg, liveStatus: "manual_review" };
  }
  if (!requestedFerryTime.normalized) {
    warnings.push({
      code: "booked_ferry_time_invalid",
      message: `Orario nave prenotato non valido per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const localDiagnostic = () => {
    const local = matchCourseByRouteAndTime(routeCode, requestedFerryTime.normalized);
    if (local.status === "matched") {
      warnings.push({
        code: "local_schedule_diagnostic",
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
      warnings.push(...structuralWarnings);
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
    .select("id, tenant_id, date, time, outbound_time, return_time, orario_barca, customer_name, pax, vessel, notes, booking_service_kind, direction, status, meeting_point")
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

  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const arrivalRow = sorted.find((r) => r.direction === "arrival") ?? null;
  const departureRow = sorted.find((r) => r.direction === "departure") ?? null;

  if (!arrivalRow && !departureRow) {
    return errorResult("no_leg_recognized", "Nessuna direzione (arrivo/partenza) riconosciuta nei servizi selezionati.", serviceIds);
  }

  const outwardOutcome = arrivalRow ? await resolveLegLive(arrivalRow, "outward", warnings) : null;
  const returnOutcome = departureRow ? await resolveLegLive(departureRow, "return", warnings) : null;

  const legStatuses = [outwardOutcome?.liveStatus, returnOutcome?.liveStatus].filter((s): s is LiveLegStatus => Boolean(s));

  // Con 6 tratte mappate, andata e ritorno potrebbero risolvere su porti
  // diversi (es. andata Napoli->Ischia + ritorno Ischia->Pozzuoli): la
  // tariffa AR è pensata per un vero andata/ritorno sulla stessa coppia di
  // porti, quindi un gruppo con gambe non speculari richiede revisione
  // manuale, non un id_corsa di riferimento scelto arbitrariamente.
  const outwardRouteCode = outwardOutcome?.leg.route_code ?? null;
  const returnRouteCode = returnOutcome?.leg.route_code ?? null;
  const legRouteMismatch =
    outwardRouteCode !== null && returnRouteCode !== null && !isMirrorRouteCode(outwardRouteCode, returnRouteCode);
  if (legRouteMismatch) {
    warnings.push({
      code: "leg_route_mismatch",
      message: `La tratta di andata (${outwardRouteCode}) e quella di ritorno (${returnRouteCode}) non sono l'una lo specchio dell'altra: revisione manuale richiesta.`,
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
  };

  if (status !== "ok") {
    return baseResult;
  }

  // Tutte le gambe live "ok": recupera tariffa/tasse dalla corsa determinata.
  const referenceLeg = outwardOutcome?.leg.id_corsa != null ? outwardOutcome.leg : returnOutcome?.leg ?? null;
  if (!referenceLeg?.id_corsa) {
    return { ...baseResult, status: "manual_review", warnings: [...warnings, { code: "no_id_corsa", message: "Nessun id_corsa live disponibile per recuperare la tariffa." }] };
  }

  try {
    const vendibili = await fetchBigliettiVendibiliReadOnly(referenceLeg.id_corsa);
    const selection = findArTariffAndTax(vendibili);

    if (selection.kind === "not_found") {
      const fallback = await mapTariffFromTicketMemory(admin, tenantId, serviceIds);
      return {
        ...baseResult,
        tariff: fallback.tariff,
        expected_total_cents: fallback.expectedTotalCents,
        is_live: false,
        warnings: [...warnings, ...fallback.warnings, { code: "ar_tariff_not_found_live", message: "Tariffa AR non trovata nella risposta Medmar live: usata memoria ticket come riferimento diagnostico (non sufficiente per emissione)." }],
      };
    }

    if (selection.kind === "unsupported_passenger_type") {
      return {
        ...baseResult,
        status: "unsupported_passenger_type",
        warnings: [...warnings, { code: "unsupported_passenger_type", message: `Trovato un biglietto AR compatibile per descrizione ma con id_tipologia_passeggero=${selection.row.id_tipologia_passeggero} non mappato (atteso adulto): revisione manuale richiesta.` }],
      };
    }

    if (selection.kind === "ambiguous_tariff") {
      return {
        ...baseResult,
        status: "manual_review",
        warnings: [...warnings, { code: "ar_tariff_ambiguous", message: "Più righe candidate per la tariffa AR adulto nella risposta Medmar live: nessuna scelta arbitraria, revisione manuale richiesta." }],
      };
    }

    const { tariff: tariffRow, labelSource, tassaSbarco, taxIssue } = selection;
    if (labelSource === "nome") {
      // La label primaria (descrizione) mancava su questa riga: la tariffa
      // è comunque stata identificata correttamente (stessa regex sulla
      // label secondaria), ma il caso è raro/inatteso e va segnalato per
      // diagnostica — non blocca can_issue.
      warnings.push({ code: "ar_label_from_nome", message: "Etichetta della tariffa AR risolta dal campo 'nome' (campo 'descrizione' assente o vuoto sulla riga): verificare se atteso." });
    }

    // Prezzo live mancante, nullo o incoerente: mai can_issue=true su dati incompleti.
    if (tariffRow.prezzo == null || !Number.isFinite(tariffRow.prezzo)) {
      return {
        ...baseResult,
        status: "manual_review",
        warnings: [...warnings, { code: "ticket_data_incomplete", message: "Prezzo della tariffa AR mancante o non numerico nella risposta Medmar live: dati insufficienti per l'emissione." }],
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
            message: taxIssue === "ambiguous"
              ? "Più righe TASSA DI SBARCO trovate nella risposta Medmar live: impossibile identificarla con certezza."
              : "Tassa di sbarco individuata ma senza prezzo nella risposta Medmar live: impossibile calcolare il totale con certezza.",
          },
        ],
      };
    }

    const taxes: MedmarPreflightTaxLine[] = tassaSbarco
      ? [{ label: resolveBigliettoLabel(tassaSbarco).label ?? "TASSA DI SBARCO", amount_cents: Math.round(tassaSbarco.prezzo! * 100) }]
      : [];

    const unitPriceCents = Math.round(tariffRow.prezzo * 100);
    const unitTotal = unitPriceCents + (taxes[0]?.amount_cents ?? 0);
    const expectedTotalCents = unitTotal * pax;

    return {
      ...baseResult,
      can_issue: true,
      tariff: {
        id_biglietto: tariffRow.id_biglietto,
        id_tariffa: tariffRow.id_tariffa,
        label: resolveBigliettoLabel(tariffRow).label,
        unit_price_cents: unitPriceCents,
        source: "medmar_live",
      },
      taxes,
      expected_total_cents: expectedTotalCents,
      is_live: true,
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
  };
}
