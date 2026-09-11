"use client";

/**
 * Centro Operativo / Controllo Giornata — V2.
 *
 * Risponde a UNA domanda per Mario: "cosa devo guardare adesso?" — non
 * "quanti record ci sono nel database?". Tre livelli, in quest'ordine:
 *   A. Stato Giornata — una frase umana (mai un termine tecnico).
 *   B. Priorità operative — solo le card con un problema reale (count>0) di
 *      default, ordinate critical -> warning -> info; "Vedi tutto" mostra
 *      anche quelle a posto.
 *   C. Riepilogo — le statistiche sintetiche, SOTTO le priorità (mai sopra).
 *
 * Nessuna logica di soglia qui: ogni card compone dati già calcolati da
 * motori esistenti (Diagnostica Giornata, group-diagnostics, control-center-
 * extras, /pdf-imports) — le soglie vivono in lib/control-center-severity.ts
 * (severityFromXxx = motore; sortAlertsBySeverity/filterVisibleAlerts/
 * buildControlCenterDayStatus = assemblaggio, entrambi centralizzati e
 * testati separatamente dalla UI).
 *
 * Nessuna scrittura: questa pagina non chiama mai un endpoint di mutazione.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, hasSupabaseEnv } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { DateInput, PageHeader, StatCard } from "@/components/ui";
import {
  buildControlCenterDayStatus,
  cardLevelToAlertSeverity,
  filterVisibleAlerts,
  hasAgencyApprovalNearOrPastExpiry,
  severityFromAgencyApprovals,
  severityFromAssignableUnassigned,
  severityFromCancellationsPending,
  severityFromDayDiagnostics,
  severityFromFailedImports,
  severityFromGroupDiagnostics,
  severityFromIncompleteBookingGroups,
  severityFromNeedsReview,
  severityFromWhatsAppFailed,
  sortAlertsBySeverity,
  type CardLevel,
  type ControlCenterAlert,
} from "@/lib/control-center-severity";

// ─── Tipi minimi delle risposte riusate (solo i campi che consumiamo) ──────

type DayDiagnosticIssue = {
  serviceId?: string;
  severity: "info" | "warning" | "error";
  category: string;
  title: string;
  message: string;
};
type DiagnosticsResponse = { ok: boolean; issues?: DayDiagnosticIssue[]; error?: string };

type GroupDiagnosticsResponse = {
  ok: boolean;
  summary?: { total_conflicts: number; total_warnings: number };
  vehicle_diagnostics?: {
    warnings: string[];
    invalid_driver_vehicle_assignments: Array<{ group_id: string; driver_name: string | null; vehicle_label: string | null; message: string }>;
    vehicle_binding: { driver_vehicle_eligibility_blockers: number };
  };
  error?: string;
};

type PdfImportRow = { inbound_email_id: string; status: string; customer: string | null; linked_service_id: string | null; created_at: string };
type PdfImportsResponse = { ok: boolean; rows?: PdfImportRow[]; error?: string };

type ControlCenterExtras = {
  ok: boolean;
  header?: { services_count: number; pax_total: number; drivers_in_use_count: number; buses_in_use_count: number; groups_count: number };
  assignable_unassigned?: {
    assignable_count: number;
    assignable_unassigned_count: number;
    assignable_unassigned: Array<{ service_id: string; customer_name: string | null; operational_time: string | null }>;
  };
  needs_review?: {
    count: number;
    items: Array<{ service_id: string; customer_name: string | null; operational_time: string | null; review_reasons: string[] }>;
  };
  incomplete_booking_groups?: {
    count: number;
    items: Array<{ id: string; name: string; status: string; kind: string; missing_bus: boolean }>;
  };
  agency_approvals_pending?: { count: number; items: Array<{ service_id: string; customer_name: string | null; date: string | null; token_expires_at: string | null }> };
  cancellation_requests_pending?: { count: number; items: Array<{ id: string; service_id: string; status: string }> };
  whatsapp_failed?: { count: number; items: Array<{ service_id: string; to_phone: string | null; status: string }> };
  error?: string;
};

type SystemStatusResponse = {
  ok: boolean;
  overall_health?: string;
  job_health?: Array<{ job_key: string; health: string; reason: string }>;
  error?: string;
};

// ─── Modello card (ControlCenterAlert + campi di rendering) ────────────────

type DrillDownItem = { id: string; label: string; sublabel?: string; href?: string };
type CardModel = ControlCenterAlert & {
  available: boolean;
  unavailableReason?: string;
  items: DrillDownItem[];
};

// Data operativa: Europe/Rome, non l'orologio del browser (che a Roma alle
// 23:30 UTC in inverno o alle 22:30 UTC in estate mostrerebbe già "domani"
// per un utente con TZ diversa, o "oggi" per un fuso indietro rispetto a
// Roma). Stesso pattern di todayIsoDate() in app/api/shuttle-schedules/
// [id]/route.ts, qui client-safe perché serve al default di <DateInput>.
const ROME_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Rome",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function todayRome(): string {
  return ROME_DATE_FORMATTER.format(new Date());
}

function serviceHref(serviceId: string | null | undefined) {
  return serviceId ? `/services/${serviceId}/edit` : undefined;
}

const LEVEL_ICON: Record<CardLevel, string> = { ok: "🟢", warning: "🟠", critical: "🔴" };
const LEVEL_LABEL: Record<CardLevel, string> = { ok: "OK", warning: "Attenzione", critical: "Critico" };

async function fetchJson<T>(url: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const json = (await res.json().catch(() => null)) as (T & { ok?: boolean }) | null;
    if (!res.ok || json?.ok === false) return null;
    return json;
  } catch {
    return null;
  }
}

export default function ControlloGiornataPage() {
  const [date, setDate] = useState(todayRome);
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [groupDiagnostics, setGroupDiagnostics] = useState<GroupDiagnosticsResponse | null>(null);
  const [pdfImports, setPdfImports] = useState<PdfImportsResponse | null>(null);
  const [pdfImportsAvailable, setPdfImportsAvailable] = useState(true);
  const [extras, setExtras] = useState<ControlCenterExtras | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      setLoading(true);
      setSessionError(null);
      const session = await getClientSessionContext();
      if (!hasSupabaseEnv || !supabase || !session.userId || !session.tenantId) {
        if (active) { setSessionError("Login richiesto."); setLoading(false); }
        return;
      }
      const { data: s } = await supabase.auth.getSession();
      const tok = s.session?.access_token ?? null;
      if (!tok) { if (active) { setSessionError("Sessione non valida."); setLoading(false); } return; }
      if (!active) return;
      setToken(tok);
      setRole(session.role);
    };
    void boot();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    const load = async () => {
      setLoading(true);
      const canSeeImports = role !== "supervisor";
      setPdfImportsAvailable(canSeeImports);

      const [diag, group, extra] = await Promise.all([
        fetchJson<DiagnosticsResponse>(`/api/ops/diagnostics?date=${date}`, token),
        fetchJson<GroupDiagnosticsResponse>(`/api/ops/piano-giorno/group-diagnostics?date=${date}`, token),
        fetchJson<ControlCenterExtras>(`/api/ops/control-center-extras?date=${date}`, token),
      ]);
      // ?status=failed lato server: la pagina non deve più filtrare lato
      // client (evita di scaricare righe che verrebbero comunque scartate).
      const pdf = canSeeImports ? await fetchJson<PdfImportsResponse>("/api/email/pdf-imports?status=failed", token) : null;
      const system = role === "admin" ? await fetchJson<SystemStatusResponse>("/api/admin/system-status", token) : null;

      if (!active) return;
      setDiagnostics(diag);
      setGroupDiagnostics(group);
      setPdfImports(pdf);
      setExtras(extra);
      setSystemStatus(system);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [token, role, date, reloadKey]);

  const handleRefresh = useCallback(() => setReloadKey((k) => k + 1), []);

  const cards: CardModel[] = useMemo(() => {
    const issues = diagnostics?.issues ?? [];

    const pickupIssues = issues.filter((i) => ["pickup", "ferry", "hotel", "time", "cancellation", "linked_service"].includes(i.category));
    const pickupStatus = severityFromDayDiagnostics(pickupIssues, ["pickup", "ferry", "hotel", "time", "cancellation", "linked_service"]);

    const duplicateIssues = issues.filter((i) => i.category === "duplicate");
    const duplicateStatus = severityFromDayDiagnostics(duplicateIssues, ["duplicate"]);

    const busIssues = issues.filter((i) => i.category === "bus");
    const busStatus = severityFromDayDiagnostics(busIssues, ["bus"]);

    const unassignedItems = extras?.assignable_unassigned?.assignable_unassigned ?? [];
    const unassignedStatus = severityFromAssignableUnassigned(extras?.assignable_unassigned?.assignable_unassigned_count ?? 0);

    // DISTINTO da "unassigned": needs_review sono servizi non assegnabili
    // per dati mancanti/incoerenti (review_reasons), mai gli stessi service_id
    // di assignable_unassigned (mutuamente esclusivi per costruzione, vedi
    // lib/piano-assignable-service.ts — resolveAssignableService).
    const needsReviewItems = extras?.needs_review?.items ?? [];
    const needsReviewStatus = severityFromNeedsReview(extras?.needs_review?.count ?? 0);

    const groupSummary = groupDiagnostics?.summary ?? { total_conflicts: 0, total_warnings: 0 };
    const vehicleDiagnostics = groupDiagnostics?.vehicle_diagnostics ?? {
      warnings: [],
      invalid_driver_vehicle_assignments: [],
      vehicle_binding: { driver_vehicle_eligibility_blockers: 0 },
    };
    const conflictStatus = severityFromGroupDiagnostics(groupSummary, vehicleDiagnostics);
    const conflictItems = vehicleDiagnostics.invalid_driver_vehicle_assignments;

    const failedImportRows = pdfImports?.rows ?? [];
    const importsStatus = severityFromFailedImports(failedImportRows.length);

    const agencyItems = extras?.agency_approvals_pending?.items ?? [];
    const agencyNearExpiry = hasAgencyApprovalNearOrPastExpiry(
      agencyItems.map((item) => ({ service_id: item.service_id, customer_name: item.customer_name, date: item.date, created_at: null, token_expires_at: item.token_expires_at }))
    );
    const agencyStatus = severityFromAgencyApprovals(extras?.agency_approvals_pending?.count ?? 0, agencyNearExpiry);

    const cancellationItems = extras?.cancellation_requests_pending?.items ?? [];
    const cancellationStatus = severityFromCancellationsPending(extras?.cancellation_requests_pending?.count ?? 0);

    const whatsappItems = extras?.whatsapp_failed?.items ?? [];
    const whatsappStatus = severityFromWhatsAppFailed(extras?.whatsapp_failed?.count ?? 0);

    const groupItems = extras?.incomplete_booking_groups?.items ?? [];
    const groupsStatus = severityFromIncompleteBookingGroups(extras?.incomplete_booking_groups?.count ?? 0);

    const list: CardModel[] = [
      {
        code: "pickup",
        title: "Pickup e dati operativi",
        description: "Ferry, hotel, orari o pickup da controllare",
        action_label: "Apri diagnostica",
        action_href: "/ops-diagnostics",
        severity: diagnostics ? cardLevelToAlertSeverity(pickupStatus.level) : "info",
        count: pickupStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: pickupIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
      },
      {
        code: "duplicates",
        title: "Duplicati",
        description: "Servizi che sembrano duplicati",
        action_label: "Apri diagnostica",
        action_href: "/ops-diagnostics",
        severity: diagnostics ? cardLevelToAlertSeverity(duplicateStatus.level) : "info",
        count: duplicateStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: duplicateIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
      },
      {
        code: "unassigned",
        title: "Servizi da assegnare",
        description: "Servizi pronti ma ancora senza autista",
        action_label: "Apri Piano Giorno",
        action_href: "/piano-giorno",
        severity: extras ? cardLevelToAlertSeverity(unassignedStatus.level) : "info",
        count: unassignedStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: unassignedItems.map((s) => ({
          id: s.service_id,
          label: s.customer_name ?? "Cliente",
          sublabel: s.operational_time ?? undefined,
          href: serviceHref(s.service_id),
        })),
      },
      {
        code: "needs_review",
        title: "Servizi da verificare",
        description: "Dati mancanti o incoerenti: non assegnabili in automatico",
        action_label: "Apri Piano Giorno",
        action_href: "/piano-giorno",
        severity: extras ? cardLevelToAlertSeverity(needsReviewStatus.level) : "info",
        count: needsReviewStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: needsReviewItems.map((s) => ({
          id: s.service_id,
          label: s.customer_name ?? "Cliente",
          sublabel: s.review_reasons.join(", ") || s.operational_time || undefined,
          href: serviceHref(s.service_id),
        })),
        metadata: { review_reasons_present: needsReviewItems.length > 0 },
      },
      {
        code: "conflicts",
        title: "Conflitti operativi",
        description: "Autisti/mezzi con conflitti o vincoli non rispettati",
        action_label: "Apri Piano Giorno",
        action_href: "/piano-giorno",
        severity: groupDiagnostics ? cardLevelToAlertSeverity(conflictStatus.level) : "info",
        count: conflictStatus.count,
        available: Boolean(groupDiagnostics),
        unavailableReason: groupDiagnostics ? undefined : "Dati non disponibili al momento.",
        items: conflictItems.map((c) => ({ id: c.group_id, label: c.driver_name ?? "Autista", sublabel: c.message, href: "/piano-giorno" })),
      },
      {
        code: "bus_capacity",
        title: "Bus / capacità",
        description: "Mezzi vicini o oltre la capacità",
        action_label: "Apri diagnostica",
        action_href: "/ops-diagnostics",
        severity: diagnostics ? cardLevelToAlertSeverity(busStatus.level) : "info",
        count: busStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: busIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
      },
      {
        code: "imports",
        title: "Importazioni",
        description: "Importazioni PDF non riuscite",
        action_label: "Apri importazioni",
        action_href: "/pdf-imports",
        severity: pdfImportsAvailable && pdfImports ? cardLevelToAlertSeverity(importsStatus.level) : "info",
        count: importsStatus.count,
        available: pdfImportsAvailable && Boolean(pdfImports),
        unavailableReason: !pdfImportsAvailable
          ? "Non disponibile per il tuo ruolo (richiesto admin/operator)."
          : pdfImports ? undefined : "Dati non disponibili al momento.",
        items: failedImportRows.map((row) => ({
          id: row.inbound_email_id,
          label: row.customer ?? "Importazione",
          sublabel: "Import fallito",
          href: row.linked_service_id ? serviceHref(row.linked_service_id) : "/pdf-imports",
        })),
      },
      {
        code: "booking_groups",
        title: "Gruppi da completare",
        description: "Gruppi prenotazione non ancora operativi (fermate, nominativi o bus mancanti)",
        action_label: "Apri gruppi",
        action_href: "/booking-groups",
        severity: extras ? cardLevelToAlertSeverity(groupsStatus.level) : "info",
        count: groupsStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: groupItems.map((g) => ({
          id: g.id,
          label: g.name,
          sublabel: g.missing_bus ? "Bus non riservato" : `Stato: ${g.status}`,
          href: "/booking-groups",
        })),
      },
      {
        code: "agency_approvals",
        title: "Prenotazioni da approvare",
        description: "Prenotazioni agenzia in attesa di conferma operatore",
        action_label: "Apri richieste agenzia",
        action_href: "/agency-requests",
        severity: extras ? cardLevelToAlertSeverity(agencyStatus.level) : "info",
        count: agencyStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: agencyItems.map((item) => ({
          id: item.service_id,
          label: item.customer_name ?? "Prenotazione",
          sublabel: item.date ?? undefined,
          href: serviceHref(item.service_id),
        })),
      },
      {
        code: "cancellations",
        title: "Cancellazioni pendenti",
        description: "Richieste di cancellazione da valutare",
        action_label: "Apri notifiche",
        action_href: "/notifications",
        severity: extras ? cardLevelToAlertSeverity(cancellationStatus.level) : "info",
        count: cancellationStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: cancellationItems.map((item) => ({
          id: item.id,
          label: "Richiesta cancellazione",
          sublabel: item.status,
          href: serviceHref(item.service_id),
        })),
      },
      {
        code: "whatsapp",
        title: "WhatsApp falliti",
        description: "Messaggi WhatsApp non consegnati",
        action_label: "Apri WhatsApp",
        action_href: "/whatsapp",
        severity: extras ? cardLevelToAlertSeverity(whatsappStatus.level) : "info",
        count: whatsappStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: whatsappItems.map((item) => ({
          id: item.service_id,
          label: item.to_phone ?? "Numero sconosciuto",
          sublabel: "Invio fallito",
          href: serviceHref(item.service_id),
        })),
      },
    ];

    return list;
  }, [diagnostics, groupDiagnostics, pdfImports, pdfImportsAvailable, extras]);

  // Ordinamento centralizzato (critical -> warning -> info, tiebreak stabile)
  // + filtro default "solo problemi" — entrambi in lib/control-center-severity.ts,
  // mai ricalcolati qui.
  const sortedCards = useMemo(() => sortAlertsBySeverity(cards) as CardModel[], [cards]);
  const visibleCards = useMemo(() => filterVisibleAlerts(sortedCards, showAll) as CardModel[], [sortedCards, showAll]);
  const dayStatus = useMemo(
    () => buildControlCenterDayStatus(cards.filter((c) => c.available).map((c) => ({ severity: c.severity, count: c.count }))),
    [cards]
  );
  const hasHiddenOkCards = !showAll && cards.some((c) => c.severity === "info");

  const header = extras?.header;

  const systemJobIssues = (systemStatus?.job_health ?? []).filter((j) => j.health !== "healthy");
  const systemLevel: CardLevel = systemStatus?.overall_health === "critical"
    ? "critical"
    : systemStatus?.overall_health === "warning" || systemJobIssues.length > 0
      ? "warning"
      : "ok";

  const toggleExpanded = useCallback((id: string) => {
    setExpandedCardId((current) => (current === id ? null : id));
  }, []);

  if (sessionError) {
    return (
      <section className="page-section">
        <PageHeader title="Controllo Giornata" />
        <p className="mt-4 text-sm text-rose-600">{sessionError}</p>
      </section>
    );
  }

  const dayStatusStyle: Record<CardLevel, string> = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warning: "border-amber-200 bg-amber-50 text-amber-800",
    critical: "border-rose-200 bg-rose-50 text-rose-800",
  };

  return (
    <section className="page-section space-y-4">
      <PageHeader
        title="Controllo Giornata"
        subtitle="Sola lettura — nessuna correzione automatica. Ogni card apre il punto giusto dell'app per intervenire."
        actions={
          <div className="flex items-center gap-2">
            <DateInput value={date} onChange={setDate} className="input-saas" />
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              ⟳ Aggiorna
            </button>
          </div>
        }
      />

      {/* A. STATO GIORNATA — una frase umana, mai tecnica. */}
      <div className={`card border p-4 ${dayStatusStyle[dayStatus.level]}`}>
        {loading ? (
          <p className="text-sm">Caricamento controlli…</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-lg font-bold">
                {LEVEL_ICON[dayStatus.level]} {dayStatus.headline}
              </p>
              {dayStatus.subline ? <p className="mt-0.5 text-sm opacity-80">{dayStatus.subline}</p> : null}
            </div>
            {dayStatus.level !== "ok" ? (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="rounded-md border border-current bg-white/60 px-3 py-1.5 text-sm font-semibold hover:bg-white"
              >
                {showAll ? "Solo i problemi" : "Vedi tutto"}
              </button>
            ) : null}
          </div>
        )}
      </div>

      {/* B. PRIORITÀ OPERATIVE — solo le card con un problema, di default. */}
      <div className="space-y-2">
        {visibleCards.map((card) => (
          <div key={card.code} className="card overflow-hidden">
            <button
              type="button"
              onClick={() => toggleExpanded(card.code)}
              className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-lg leading-none">{LEVEL_ICON[card.severity === "info" ? "ok" : card.severity]}</span>
                <div className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-800">{card.title}</span>
                  {card.severity !== "info" ? <span className="block truncate text-xs text-slate-500">{card.description}</span> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {!card.available ? (
                  <span className="max-w-[220px] whitespace-normal text-right text-xs text-slate-400 sm:max-w-none">{card.unavailableReason}</span>
                ) : card.severity === "info" ? (
                  <span className="text-xs font-medium text-emerald-600">OK</span>
                ) : (
                  <span className="text-xl font-bold text-slate-800">
                    {card.count}
                    <span className="ml-1 text-xs font-semibold text-slate-500">{LEVEL_LABEL[card.severity]}</span>
                  </span>
                )}
                <a
                  href={card.action_href}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  {card.action_label} →
                </a>
              </div>
            </button>
            {expandedCardId === card.code && card.items.length > 0 ? (
              <div className="space-y-1 border-t border-slate-100 bg-slate-50/60 px-4 py-2">
                {card.items.slice(0, 20).map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-2 text-xs text-slate-600">
                    <span className="truncate">
                      {item.label}
                      {item.sublabel ? <span className="text-slate-400"> · {item.sublabel}</span> : null}
                    </span>
                    {item.href ? (
                      <a href={item.href} className="shrink-0 font-semibold text-blue-600 hover:underline">
                        Apri
                      </a>
                    ) : null}
                  </div>
                ))}
                {card.items.length > 20 ? (
                  <p className="text-[11px] text-slate-400">…e altri {card.items.length - 20}. Apri la vista completa per il dettaglio.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {!loading && visibleCards.length === 0 ? (
          <div className="card p-6 text-center">
            <p className="text-base font-semibold text-emerald-700">🟢 Nessuna categoria richiede attenzione</p>
          </div>
        ) : null}
        {!loading && hasHiddenOkCards ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="w-full rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50"
          >
            Vedi tutto ({cards.filter((c) => c.severity === "info").length} categorie a posto nascoste)
          </button>
        ) : null}
      </div>

      {/* C. RIEPILOGO — statistiche sintetiche, sempre dopo le priorità. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Servizi" value={loading ? "…" : String(header?.services_count ?? 0)} hint="Servizi confermati oggi" loading={loading} />
        <StatCard label="Pax" value={loading ? "…" : String(header?.pax_total ?? 0)} hint="Totale passeggeri" loading={loading} />
        <StatCard label="Bus" value={loading ? "…" : String(header?.buses_in_use_count ?? 0)} hint="Mezzi con assegnazione" loading={loading} />
        <StatCard label="Autisti" value={loading ? "…" : String(header?.drivers_in_use_count ?? 0)} hint="Autisti con assegnazione" loading={loading} />
        <StatCard label="Gruppi" value={loading ? "…" : String(header?.groups_count ?? 0)} hint="Gruppi prenotazione della giornata" loading={loading} />
      </div>
      {/* "Completati / da fare" NON è incluso: services.status ha 11 valori
          (new/assigned/partito/arrivato/completato/problema/cancelled/
          needs_review/pending_cancellation/caricato/scaricato) che non si
          riducono in modo affidabile a un binario completato/da-fare senza
          inventare una regola di dominio — gap dichiarato, non implementato. */}

      {role === "admin" ? (
        <div className="card p-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">Stato sistema</h2>
          <p className="mt-1 text-xs text-slate-500">Non conteggiato nelle anomalie operative sopra — riguarda backup e job automatici, non i servizi di oggi.</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold text-slate-700">
              {LEVEL_ICON[systemLevel]} {systemStatus ? (systemStatus.overall_health ?? "sconosciuto") : "—"}
            </span>
            {systemJobIssues.map((job) => (
              <span key={job.job_key} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-700">
                {job.job_key}: {job.reason}
              </span>
            ))}
            <a href="/settings/system" className="text-xs font-semibold text-blue-600 hover:underline">Apri stato sistema →</a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
