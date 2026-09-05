"use client";

/**
 * Centro Operativo / Controllo Giornata — V1 READ-ONLY.
 *
 * Risponde a UNA domanda per Mario: "la giornata è pronta o c'è qualcosa
 * che richiede attenzione?". Nessuna logica nuova: ogni card compone dati
 * già calcolati da motori esistenti (Diagnostica Giornata, group-
 * diagnostics, /pdf-imports, control-center-extras) — vedi
 * lib/control-center-severity.ts per la sola traduzione livello/colore.
 *
 * Nessuna scrittura: questa pagina non chiama mai un endpoint di mutazione.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, hasSupabaseEnv } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { DateInput, PageHeader, StatCard } from "@/components/ui";
import {
  hasAgencyApprovalNearOrPastExpiry,
  severityFromAgencyApprovals,
  severityFromAssignableUnassigned,
  severityFromCancellationsPending,
  severityFromDayDiagnostics,
  severityFromFailedImports,
  severityFromGroupDiagnostics,
  severityFromWhatsAppFailed,
  summarizeTotals,
  type CardLevel,
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
  header?: { services_count: number; pax_total: number; drivers_in_use_count: number; buses_in_use_count: number };
  assignable_unassigned?: {
    assignable_count: number;
    assignable_unassigned_count: number;
    assignable_unassigned: Array<{ service_id: string; customer_name: string | null; operational_time: string | null }>;
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

// ─── Modello card ───────────────────────────────────────────────────────────

type DrillDownItem = { id: string; label: string; sublabel?: string; href?: string };
type CardModel = {
  id: string;
  label: string;
  level: CardLevel;
  count: number;
  available: boolean;
  unavailableReason?: string;
  items: DrillDownItem[];
  fallbackHref: string;
};

function today() {
  return new Date().toISOString().slice(0, 10);
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
  const [date, setDate] = useState(today);
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
  const [showOnlyIssues, setShowOnlyIssues] = useState(false);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

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
      const pdf = canSeeImports ? await fetchJson<PdfImportsResponse>("/api/email/pdf-imports", token) : null;
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
  }, [token, role, date]);

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

    const groupSummary = groupDiagnostics?.summary ?? { total_conflicts: 0, total_warnings: 0 };
    const vehicleDiagnostics = groupDiagnostics?.vehicle_diagnostics ?? {
      warnings: [],
      invalid_driver_vehicle_assignments: [],
      vehicle_binding: { driver_vehicle_eligibility_blockers: 0 },
    };
    const conflictStatus = severityFromGroupDiagnostics(groupSummary, vehicleDiagnostics);
    const conflictItems = vehicleDiagnostics.invalid_driver_vehicle_assignments;

    const failedImportRows = (pdfImports?.rows ?? []).filter((row) => row.status === "failed");
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

    const list: CardModel[] = [
      {
        id: "pickup",
        label: "Pickup e dati operativi",
        level: diagnostics ? pickupStatus.level : "ok",
        count: pickupStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: pickupIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
        fallbackHref: "/ops-diagnostics",
      },
      {
        id: "duplicates",
        label: "Duplicati",
        level: diagnostics ? duplicateStatus.level : "ok",
        count: duplicateStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: duplicateIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
        fallbackHref: "/ops-diagnostics",
      },
      {
        id: "unassigned",
        label: "Servizi da assegnare",
        level: extras ? unassignedStatus.level : "ok",
        count: unassignedStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: unassignedItems.map((s) => ({
          id: s.service_id,
          label: s.customer_name ?? "Cliente",
          sublabel: s.operational_time ?? undefined,
          href: serviceHref(s.service_id),
        })),
        fallbackHref: "/piano-giorno",
      },
      {
        id: "conflicts",
        label: "Conflitti operativi",
        level: groupDiagnostics ? conflictStatus.level : "ok",
        count: conflictStatus.count,
        available: Boolean(groupDiagnostics),
        unavailableReason: groupDiagnostics ? undefined : "Dati non disponibili al momento.",
        items: conflictItems.map((c) => ({ id: c.group_id, label: c.driver_name ?? "Autista", sublabel: c.message, href: "/piano-giorno" })),
        fallbackHref: "/piano-giorno",
      },
      {
        id: "bus_capacity",
        label: "Bus / capacità",
        level: diagnostics ? busStatus.level : "ok",
        count: busStatus.count,
        available: Boolean(diagnostics),
        unavailableReason: diagnostics ? undefined : "Dati non disponibili al momento.",
        items: busIssues.map((i) => ({ id: `${i.category}-${i.serviceId ?? i.title}`, label: i.title, sublabel: i.message, href: serviceHref(i.serviceId) })),
        fallbackHref: "/ops-diagnostics",
      },
      {
        id: "imports",
        label: "Importazioni",
        level: pdfImportsAvailable && pdfImports ? importsStatus.level : "ok",
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
        fallbackHref: "/pdf-imports",
      },
      {
        id: "agency_approvals",
        label: "Prenotazioni da approvare",
        level: extras ? agencyStatus.level : "ok",
        count: agencyStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: agencyItems.map((item) => ({
          id: item.service_id,
          label: item.customer_name ?? "Prenotazione",
          sublabel: item.date ?? undefined,
          href: serviceHref(item.service_id),
        })),
        fallbackHref: "/agency-requests",
      },
      {
        id: "cancellations",
        label: "Cancellazioni pendenti",
        level: extras ? cancellationStatus.level : "ok",
        count: cancellationStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: cancellationItems.map((item) => ({
          id: item.id,
          label: "Richiesta cancellazione",
          sublabel: item.status,
          href: serviceHref(item.service_id),
        })),
        fallbackHref: "/notifications",
      },
      {
        id: "whatsapp",
        label: "WhatsApp falliti",
        level: extras ? whatsappStatus.level : "ok",
        count: whatsappStatus.count,
        available: Boolean(extras),
        unavailableReason: extras ? undefined : "Dati non disponibili al momento.",
        items: whatsappItems.map((item) => ({
          id: item.service_id,
          label: item.to_phone ?? "Numero sconosciuto",
          sublabel: "Invio fallito",
          href: serviceHref(item.service_id),
        })),
        fallbackHref: "/whatsapp",
      },
    ];

    return list;
  }, [diagnostics, groupDiagnostics, pdfImports, pdfImportsAvailable, extras]);

  const totals = useMemo(() => summarizeTotals(cards.filter((c) => c.available).map((c) => ({ level: c.level, count: c.count }))), [cards]);
  const allOk = cards.every((c) => c.level === "ok");
  const visibleCards = showOnlyIssues ? cards.filter((c) => c.level !== "ok") : cards;

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

  return (
    <section className="page-section space-y-4">
      <PageHeader
        title="Controllo Giornata"
        subtitle="Sola lettura — nessuna correzione automatica. Ogni card apre il punto giusto dell'app per intervenire."
        actions={<DateInput value={date} onChange={setDate} className="input-saas" />}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Servizi" value={loading ? "…" : String(header?.services_count ?? 0)} hint="Servizi confermati oggi" loading={loading} />
        <StatCard label="Pax" value={loading ? "…" : String(header?.pax_total ?? 0)} hint="Totale passeggeri" loading={loading} />
        <StatCard label="Bus" value={loading ? "…" : String(header?.buses_in_use_count ?? 0)} hint="Mezzi con assegnazione" loading={loading} />
        <StatCard label="Autisti" value={loading ? "…" : String(header?.drivers_in_use_count ?? 0)} hint="Autisti con assegnazione" loading={loading} />
      </div>

      <div className="card p-4">
        {loading ? (
          <p className="text-sm text-muted">Caricamento controlli…</p>
        ) : allOk ? (
          <p className="text-base font-semibold text-emerald-700">🟢 Nessun problema rilevato dai controlli operativi</p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-base font-semibold text-slate-800">
              {totals.critical > 0 ? `${totals.critical} problemi critici` : null}
              {totals.critical > 0 && totals.warning > 0 ? " · " : null}
              {totals.warning > 0 ? `${totals.warning} attenzioni` : null}
            </p>
            <button
              type="button"
              onClick={() => setShowOnlyIssues((v) => !v)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              {showOnlyIssues ? "Vedi tutte le card" : "VEDI COSA DEVO SISTEMARE"}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {visibleCards.map((card) => (
          <div key={card.id} className="card overflow-hidden">
            <button
              type="button"
              onClick={() => toggleExpanded(card.id)}
              className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-slate-50"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-lg leading-none">{LEVEL_ICON[card.level]}</span>
                <span className="truncate text-sm font-semibold text-slate-800">{card.label}</span>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                {!card.available ? (
                  <span className="max-w-[220px] whitespace-normal text-right text-xs text-slate-400 sm:max-w-none">{card.unavailableReason}</span>
                ) : card.level === "ok" ? (
                  <span className="text-xs font-medium text-emerald-600">OK</span>
                ) : (
                  <span className="text-xs font-semibold text-slate-600">
                    {card.count} · {LEVEL_LABEL[card.level]}
                  </span>
                )}
                <a
                  href={card.fallbackHref}
                  onClick={(e) => e.stopPropagation()}
                  className="text-xs font-semibold text-blue-600 hover:underline"
                >
                  Apri →
                </a>
              </div>
            </button>
            {expandedCardId === card.id && card.items.length > 0 ? (
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
      </div>

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
