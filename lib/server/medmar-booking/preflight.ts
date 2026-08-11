/**
 * Orchestrazione del preflight Medmar One Click — Fase 1.5 "preflight live".
 *
 * Usa le 2 chiamate READ-ONLY reali verso Medmar (ricerca corse, biglietti
 * vendibili) per determinare corsa/tariffa. course-matcher.ts (orari
 * statici locali) resta SOLO come confronto diagnostico (warning), non
 * determina mai più can_issue=true da solo.
 *
 * FAIL-CLOSED: se Medmar non risponde (rete/timeout/5xx) o il token è
 * scaduto (401/403), can_issue è SEMPRE false, indipendentemente da quello
 * che direbbe il fallback locale.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveRouteCodeFromService, matchCourseByRouteAndTime } from "./course-matcher";
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
import { findArTariffAndTax } from "./live-parser";
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

function checkPortMismatch(c: CorsaMedmarRaw, routeCode: MedmarTicketRouteCode, warnings: MedmarPreflightWarning[]): void {
  const expectedPorts = getExpectedPortsForRouteCode(routeCode);
  if (!expectedPorts) return;
  if (c.id_porto_partenza !== null && c.id_porto_partenza !== expectedPorts.idPortoPartenza) {
    warnings.push({ code: "port_mismatch", message: `id_porto_partenza della corsa (${c.id_porto_partenza}) diverso da quello atteso per la tratta (${expectedPorts.idPortoPartenza}).` });
  }
  if (c.id_porto_arrivo !== null && c.id_porto_arrivo !== expectedPorts.idPortoArrivo) {
    warnings.push({ code: "port_mismatch", message: `id_porto_arrivo della corsa (${c.id_porto_arrivo}) diverso da quello atteso per la tratta (${expectedPorts.idPortoArrivo}).` });
  }
}

type LiveLegStatus = "ok" | "no_match" | "ambiguous" | "manual_review" | "medmar_unavailable" | "medmar_auth_expired";

async function resolveLegLive(
  row: MedmarPreflightServiceRow,
  direction: "outward" | "return",
  warnings: MedmarPreflightWarning[]
): Promise<{ leg: MedmarPreflightLeg; liveStatus: LiveLegStatus }> {
  const routeCode = resolveRouteCodeFromService({
    bookingServiceKind: row.booking_service_kind,
    direction: row.direction,
  });

  const leg: MedmarPreflightLeg = {
    direction,
    route_code: routeCode,
    route: null,
    date: row.date,
    requested_time: row.time,
    matched_departure_time: null,
    vessel: row.vessel,
    service_ids: [row.id],
    id_corsa: null,
    source: null,
  };

  if (!routeCode) {
    warnings.push({
      code: "route_not_determined",
      message: `Tratta Medmar non determinabile dai dati del servizio (booking_service_kind=${row.booking_service_kind ?? "null"}).`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const def = getRouteDefinition(routeCode);
  leg.route = {
    from: def.departurePortKeywords[0]?.toUpperCase() ?? "?",
    to: def.arrivalPortKeywords[0]?.toUpperCase() ?? "?",
  };
  warnings.push({
    code: "island_port_assumed",
    message: "Porto isolano assunto = Ischia (i dati service non distinguono Casamicciola): verificare manualmente se necessario.",
  });

  const idTratta = getIdTrattaForRouteCode(routeCode);
  if (idTratta == null) {
    warnings.push({
      code: "route_not_mapped",
      message: `Nessun id_tratta Medmar verificato per la tratta ${leg.route.from} → ${leg.route.to}: revisione manuale richiesta (nessun ID inventato).`,
    });
    return { leg, liveStatus: "manual_review" };
  }

  const localDiagnostic = () => {
    const local = matchCourseByRouteAndTime(routeCode, row.time);
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
    const corse = await fetchCorseReadOnly({ idTratta, partenzaDataDal: row.date, dopoLe: toDopoLe(row.time) });
    const candidates = corse.filter((c) => isCandidateCorsa(c, { idTratta, date: row.date }));

    if (candidates.length === 0) {
      localDiagnostic();
      return { leg, liveStatus: "no_match" };
    }
    if (candidates.length > 1) {
      warnings.push({
        code: "course_ambiguous",
        message: `Più corse Medmar live compatibili per ${direction === "outward" ? "andata" : "ritorno"}: revisione manuale richiesta.`,
      });
      return { leg, liveStatus: "ambiguous" };
    }

    const only = candidates[0]!;
    checkPortMismatch(only, routeCode, warnings);
    leg.id_corsa = only.id_corsa;
    leg.vessel = only.nave ?? leg.vessel;
    leg.matched_departure_time = only.partenza_ora;
    leg.source = "live";

    const localMatchedTime = localDiagnostic();
    if (localMatchedTime && only.partenza_ora && localMatchedTime !== only.partenza_ora) {
      warnings.push({
        code: "local_schedule_mismatch",
        message: `L'orario Medmar live (${only.partenza_ora}) differisce dall'orario noto localmente (${localMatchedTime}).`,
      });
    }

    return { leg, liveStatus: "ok" };
  } catch (err) {
    if (err instanceof MedmarAuthExpiredError) {
      return { leg, liveStatus: "medmar_auth_expired" };
    }
    warnings.push({
      code: "medmar_live_unavailable",
      message: err instanceof MedmarNotAvailableError || err instanceof MedmarBadResponseError
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
    .select("id, tenant_id, date, time, customer_name, pax, vessel, notes, booking_service_kind, direction, status")
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

  let status: MedmarPreflightResult["status"];
  if (legStatuses.includes("medmar_auth_expired")) status = "medmar_auth_expired";
  else if (legStatuses.includes("medmar_unavailable")) status = "medmar_unavailable";
  else if (legStatuses.includes("no_match")) status = "no_match";
  else if (legStatuses.includes("ambiguous")) status = "ambiguous";
  else if (legStatuses.includes("manual_review")) status = "manual_review";
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
    const { tariff: tariffRow, tassaSbarco } = findArTariffAndTax(vendibili);

    if (!tariffRow) {
      const fallback = await mapTariffFromTicketMemory(admin, tenantId, serviceIds);
      return {
        ...baseResult,
        tariff: fallback.tariff,
        expected_total_cents: fallback.expectedTotalCents,
        is_live: false,
        warnings: [...warnings, ...fallback.warnings, { code: "ar_tariff_not_found_live", message: "Tariffa AR non trovata nella risposta Medmar live: usata memoria ticket come riferimento diagnostico (non sufficiente per emissione)." }],
      };
    }

    const taxes: MedmarPreflightTaxLine[] = tassaSbarco
      ? [{ label: tassaSbarco.label ?? "TASSA DI SBARCO", amount_cents: tassaSbarco.prezzo_cents }]
      : [];

    const unitTotal = (tariffRow.prezzo_cents ?? 0) + (tassaSbarco?.prezzo_cents ?? 0);
    const expectedTotalCents = tariffRow.prezzo_cents != null ? unitTotal * pax : null;

    return {
      ...baseResult,
      can_issue: true,
      tariff: {
        id_biglietto: tariffRow.id_biglietto,
        id_tariffa: tariffRow.id_tariffa,
        label: tariffRow.label,
        unit_price_cents: tariffRow.prezzo_cents,
        source: "medmar_live",
      },
      taxes,
      expected_total_cents: expectedTotalCents,
      is_live: true,
    };
  } catch (err) {
    if (err instanceof MedmarAuthExpiredError) {
      return { ...baseResult, status: "medmar_auth_expired" };
    }
    return {
      ...baseResult,
      status: "medmar_unavailable",
      warnings: [...warnings, { code: "medmar_live_unavailable", message: err instanceof MedmarNotAvailableError || err instanceof MedmarBadResponseError ? err.message : "Errore imprevisto nel recupero biglietti vendibili." }],
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
