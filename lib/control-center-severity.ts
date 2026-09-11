/**
 * Centro Operativo / Controllo Giornata — mappatura pura livello/severità.
 *
 * Traduce le severità NATIVE già calcolate dai motori esistenti (Diagnostica
 * Giornata, group-diagnostics, control-center-extras, /pdf-imports,
 * /admin/system-status) nei tre livelli semaforici mostrati a Mario. Nessuna
 * nuova euristica di dominio: solo soglie esplicite documentate qui.
 *
 * File client-safe (nessun import server-only): usato da
 * app/(app)/controllo-giornata/page.tsx.
 */

export type CardLevel = "ok" | "warning" | "critical";

export type CardStatus = {
  level: CardLevel;
  count: number;
};

const LEVEL_RANK: Record<CardLevel, number> = { ok: 0, warning: 1, critical: 2 };

export function maxLevel(a: CardLevel, b: CardLevel): CardLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// ─── Diagnostica Giornata (/api/ops/diagnostics) ───────────────────────────

type DayDiagnosticSeverity = "info" | "warning" | "error";
export type DayDiagnosticIssueLike = { severity: DayDiagnosticSeverity; category: string };

/**
 * Un issue di severità "info" non fa scattare warning/critical (Mario non
 * deve vedere arancione per una nota informativa) ma viene comunque incluso
 * nel drill-down della card, cosi' l'operatore esperto lo vede.
 */
export function severityFromDayDiagnostics(
  issues: DayDiagnosticIssueLike[],
  categories: readonly string[]
): CardStatus {
  const matched = issues.filter((issue) => categories.includes(issue.category));
  const hasError = matched.some((issue) => issue.severity === "error");
  const hasWarning = matched.some((issue) => issue.severity === "warning");
  const level: CardLevel = hasError ? "critical" : hasWarning ? "warning" : "ok";
  const count = matched.filter((issue) => issue.severity !== "info").length;
  return { level, count };
}

// ─── Servizi da assegnare (control-center-extras) ──────────────────────────

/**
 * V1: sempre WARNING quando > 0, mai CRITICAL. Riusare le finestre
 * temporali di operations-health.ts per un'escalation CRITICAL basata
 * sull'orario è rimandato a un intervento successivo (vedi audit/piano
 * approvato) per non reimplementarle una seconda volta con dati che, in
 * questo endpoint, non sono nemmeno filtrati per stato di assegnazione a
 * monte.
 */
export function severityFromAssignableUnassigned(count: number): CardStatus {
  return { level: count > 0 ? "warning" : "ok", count };
}

// ─── Conflitti operativi (group-diagnostics) ───────────────────────────────

export type GroupDiagnosticsSummaryLike = {
  total_conflicts: number;
  total_warnings: number;
};
export type VehicleDiagnosticsLike = {
  warnings: string[];
  invalid_driver_vehicle_assignments: unknown[];
  vehicle_binding: { driver_vehicle_eligibility_blockers: number };
};

export function severityFromGroupDiagnostics(
  summary: GroupDiagnosticsSummaryLike,
  vehicleDiagnostics: VehicleDiagnosticsLike
): CardStatus {
  const criticalCount =
    summary.total_conflicts +
    vehicleDiagnostics.invalid_driver_vehicle_assignments.length +
    vehicleDiagnostics.vehicle_binding.driver_vehicle_eligibility_blockers;
  if (criticalCount > 0) return { level: "critical", count: criticalCount };

  const warningCount = summary.total_warnings + vehicleDiagnostics.warnings.length;
  if (warningCount > 0) return { level: "warning", count: warningCount };

  return { level: "ok", count: 0 };
}

// ─── Importazioni (/api/email/pdf-imports, solo status 'failed') ──────────

export function severityFromFailedImports(failedCount: number): CardStatus {
  return { level: failedCount > 0 ? "warning" : "ok", count: failedCount };
}

// ─── Prenotazioni agenzia da approvare (control-center-extras) ────────────

/** CRITICAL se almeno un token è già scaduto o scade entro questa soglia. */
export const AGENCY_APPROVAL_TOKEN_CRITICAL_WINDOW_MS = 6 * 60 * 60 * 1000;

export type AgencyApprovalExpiryLike = { token_expires_at: string | null };

export function hasAgencyApprovalNearOrPastExpiry(
  items: readonly AgencyApprovalExpiryLike[],
  now: Date = new Date()
): boolean {
  return items.some((item) => {
    if (!item.token_expires_at) return false;
    const expiresAt = new Date(item.token_expires_at).getTime();
    if (Number.isNaN(expiresAt)) return false;
    return expiresAt - now.getTime() <= AGENCY_APPROVAL_TOKEN_CRITICAL_WINDOW_MS;
  });
}

export function severityFromAgencyApprovals(count: number, hasNearOrPastExpiry: boolean): CardStatus {
  if (count === 0) return { level: "ok", count: 0 };
  return { level: hasNearOrPastExpiry ? "critical" : "warning", count };
}

// ─── Cancellazioni pendenti (control-center-extras) ────────────────────────

/** V1: nessuna escalation temporale, come da istruzione esplicita. */
export function severityFromCancellationsPending(count: number): CardStatus {
  return { level: count > 0 ? "warning" : "ok", count };
}

// ─── WhatsApp falliti (control-center-extras) ──────────────────────────────

/** Un fallimento esplicito verso un cliente è sempre azionabile oggi. */
export function severityFromWhatsAppFailed(count: number): CardStatus {
  return { level: count > 0 ? "critical" : "ok", count };
}

// ─── Servizi da verificare (needs_review, control-center-extras) ──────────

/**
 * `needs_review` (lib/piano-assignable-service.ts) identifica servizi che
 * NON possono essere assegnati automaticamente per dati mancanti/incoerenti
 * (hotel non risolto, meeting point mancante, orario non determinato, ecc.)
 * — categoria DISTINTA da "assignable_unassigned" (servizi strutturalmente
 * a posto ma ancora senza autista). V1 la calcolava ma non la esponeva.
 * Sempre WARNING: richiede una verifica umana ma non è di per sé un servizio
 * bloccato/critico (potrebbe già avere un autista assegnato manualmente).
 */
export function severityFromNeedsReview(count: number): CardStatus {
  return { level: count > 0 ? "warning" : "ok", count };
}

// ─── Gruppi prenotazione incompleti (control-center-extras) ───────────────

/**
 * Un booking_group è "da completare" quando il suo status (dominio già
 * esistente, migration 0263: draft/to_complete/stops_defined/
 * passengers_defined/operational/cancelled) non è ancora 'operational'.
 * Nessuna nuova regola inventata. Sempre WARNING: un gruppo a metà non
 * blocca la giornata odierna finché non arriva a operativizzazione.
 */
export function severityFromIncompleteBookingGroups(count: number): CardStatus {
  return { level: count > 0 ? "warning" : "ok", count };
}

// ─── Totali di riepilogo ("X problemi critici · Y attenzioni") ────────────

export function summarizeTotals(cards: CardStatus[]): { critical: number; warning: number } {
  let critical = 0;
  let warning = 0;
  for (const card of cards) {
    if (card.level === "critical") critical += card.count;
    else if (card.level === "warning") warning += card.count;
  }
  return { critical, warning };
}

// ─── Alert model V2 (FASE 3) ────────────────────────────────────────────────
//
// Un unico tipo coerente per ogni card mostrata a Mario. Le funzioni
// severityFromXxx sopra restano il "motore" delle soglie (invariate); questo
// livello si occupa SOLO di: normalizzare il livello in una severità a 3
// valori, ordinare (critical -> warning -> info) e nascondere/mostrare le
// card senza problemi. Nessuna soglia viene ricalcolata qui.

export type ControlCenterAlertSeverity = "critical" | "warning" | "info";

export type ControlCenterAlert = {
  code: string;
  severity: ControlCenterAlertSeverity;
  count: number;
  title: string;
  description: string;
  action_label: string;
  action_href: string;
  metadata?: Record<string, unknown>;
};

/** "ok" (nessun problema) diventa "info": è comunque un'informazione utile
 *  da mostrare in "Vedi tutto", non un'anomalia. */
export function cardLevelToAlertSeverity(level: CardLevel): ControlCenterAlertSeverity {
  return level === "ok" ? "info" : level;
}

const ALERT_SEVERITY_RANK: Record<ControlCenterAlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Ordina critical -> warning -> info. A parità di severità mantiene l'ordine
 * originale (indice dell'array in input) come tiebreak esplicito, cosi'
 * l'ordinamento resta deterministico indipendentemente dall'implementazione
 * di Array.prototype.sort del runtime.
 */
export function sortAlertsBySeverity<T extends { severity: ControlCenterAlertSeverity }>(alerts: readonly T[]): T[] {
  return alerts
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => ALERT_SEVERITY_RANK[a.alert.severity] - ALERT_SEVERITY_RANK[b.alert.severity] || a.index - b.index)
    .map(({ alert }) => alert);
}

/** Default: solo le card con un problema reale (critical/warning). `showAll`
 *  (toggle "Vedi tutto" in UI) fa comparire anche quelle "info" (count=0). */
export function filterVisibleAlerts<T extends { severity: ControlCenterAlertSeverity }>(
  alerts: readonly T[],
  showAll: boolean
): T[] {
  return showAll ? [...alerts] : alerts.filter((alert) => alert.severity !== "info");
}

export type ControlCenterDayStatus = {
  level: CardLevel;
  headline: string;
  subline?: string;
};

function pluralIt(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/**
 * Fascia "Stato Giornata": una frase umana, mai un termine tecnico. Se ci
 * sono sia critical che warning, il critical vince come frase principale e
 * i warning residui compaiono come sottotesto breve (mai il contrario:
 * un problema urgente non deve mai essere oscurato da "N cose da verificare").
 */
export function buildControlCenterDayStatus(
  alerts: readonly Pick<ControlCenterAlert, "severity" | "count">[]
): ControlCenterDayStatus {
  const critical = alerts.filter((a) => a.severity === "critical").reduce((sum, a) => sum + a.count, 0);
  const warning = alerts.filter((a) => a.severity === "warning").reduce((sum, a) => sum + a.count, 0);

  if (critical > 0) {
    return {
      level: "critical",
      headline: `${critical} ${pluralIt(critical, "problema urgente", "problemi urgenti")}`,
      subline: warning > 0 ? `+ ${warning} da verificare` : undefined,
    };
  }
  if (warning > 0) {
    return {
      level: "warning",
      headline: `${warning} ${pluralIt(warning, "cosa da verificare", "cose da verificare")}`,
    };
  }
  return {
    level: "ok",
    headline: "Giornata sotto controllo",
    subline: "Nessun problema operativo rilevante",
  };
}
