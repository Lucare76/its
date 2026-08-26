"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

/**
 * Centro notifiche: SOLO eventi reali sul ciclo di vita della prenotazione —
 * nuove prenotazioni, modifiche, cancellazioni. Nessuna anomalia derivata
 * (dispatch mancante, tariffa mancante, posti bus, PDF da rivedere, reminder
 * falliti): quelle sono liste operative gia' presenti altrove nel gestionale
 * (Piano del Giorno, Bus Network, Inbox), non notifiche.
 *
 * Fonte: service_change_logs (gia' scritta da logServiceChange ad ogni
 * creazione/cancellazione/modifica di un servizio — vedi
 * lib/server/service-audit-log.ts), letta direttamente con RLS
 * (admin/operator/supervisor del tenant, vedi migration 0232).
 */

type ServiceChangeLogRow = {
  id: string;
  service_id: string;
  action: "CREATED" | "CANCELLED" | "updated";
  changed_fields: string[];
  after_data: Record<string, unknown> | null;
  operator_name: string | null;
  created_at: string;
};

const LOOKBACK_DAYS = 14;
const MAX_ROWS = 300;

function customerLabel(row: ServiceChangeLogRow): string {
  const name = row.after_data?.customer_name;
  return typeof name === "string" && name.trim() ? name.trim() : "Cliente N/D";
}

function formatDateTimeIt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type NotificationSeverity = "high" | "medium" | "low";
type OperationalNotification = {
  key: string;
  title: string;
  detail: string;
  count: number;
  href: string;
  tone: "rose" | "amber" | "blue" | "violet" | "slate";
};

function toAlert(row: ServiceChangeLogRow): { id: string; title: string; detail: string; severity: NotificationSeverity; serviceId: string } {
  const customer = customerLabel(row);
  const who = row.operator_name ? ` - ${row.operator_name}` : "";
  const when = formatDateTimeIt(row.created_at);

  if (row.action === "CREATED") {
    return {
      id: row.id,
      title: "Nuova prenotazione",
      detail: `${customer} | ${when}${who}`,
      severity: "low",
      serviceId: row.service_id,
    };
  }
  if (row.action === "CANCELLED") {
    const reason = row.after_data?.cancellation_reason;
    const reasonLabel = typeof reason === "string" && reason.trim() ? ` | ${reason.trim()}` : "";
    return {
      id: row.id,
      title: "Prenotazione cancellata",
      detail: `${customer} | ${when}${reasonLabel}${who}`,
      severity: "medium",
      serviceId: row.service_id,
    };
  }
  const fieldsLabel = row.changed_fields.length > 0 ? row.changed_fields.join(", ") : "dati aggiornati";
  return {
    id: row.id,
    title: "Prenotazione modificata",
    detail: `${customer} | ${when} | ${fieldsLabel}${who}`,
    severity: "low",
    serviceId: row.service_id,
  };
}

function operationalToneClass(tone: OperationalNotification["tone"]) {
  if (tone === "rose") return "border-rose-200 bg-rose-50 text-rose-700";
  if (tone === "amber") return "border-amber-200 bg-amber-50 text-amber-700";
  if (tone === "blue") return "border-blue-200 bg-blue-50 text-blue-700";
  if (tone === "violet") return "border-violet-200 bg-violet-50 text-violet-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

export default function NotificationsPage() {
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rows, setRows] = useState<ServiceChangeLogRow[]>([]);
  const [operationalItems, setOperationalItems] = useState<OperationalNotification[]>([]);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [dismissingAll, setDismissingAll] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setErrorMessage(null);
      if (!supabase) {
        if (active) { setErrorMessage("Supabase non configurato."); setLoading(false); }
        return;
      }
      const session = await getClientSessionContext();
      if (!session.tenantId) {
        if (active) { setErrorMessage("Sessione non valida."); setLoading(false); }
        return;
      }
      const since = new Date();
      since.setDate(since.getDate() - LOOKBACK_DAYS);
      const [
        serviceLogsResult,
        agencyBookingsResult,
        agencyReviewsResult,
        cancellationsResult,
        vehiclesResult,
        accessRequestsResult
      ] = await Promise.all([
        supabase
        .from("service_change_logs")
        .select("id, service_id, action, changed_fields, after_data, operator_name, created_at")
        .eq("tenant_id", session.tenantId)
        .in("action", ["CREATED", "CANCELLED", "updated"])
        .is("dismissed_at", null)
        .gte("created_at", since.toISOString())
        .order("created_at", { ascending: false })
        .limit(MAX_ROWS),
        session.role === "admin" || session.role === "operator"
          ? supabase
            .from("services")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", session.tenantId)
            .eq("approval_status", "pending_operator")
          : Promise.resolve({ count: 0, error: null }),
        supabase
          .from("agency_review_sessions")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", session.tenantId)
          .eq("status", "modified"),
        session.role === "admin" || session.role === "operator"
          ? supabase
            .from("cancellation_requests")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", session.tenantId)
            .in("status", ["pending_review", "pending_agency_approval"])
          : Promise.resolve({ count: 0, error: null }),
        supabase
          .from("vehicles")
          .select("id")
          .eq("tenant_id", session.tenantId),
        session.role === "admin"
          ? supabase
            .from("tenant_access_requests")
            .select("id", { count: "exact", head: true })
            .eq("tenant_id", session.tenantId)
            .eq("status", "pending")
          : Promise.resolve({ count: 0, error: null })
      ]);

      const { data, error } = serviceLogsResult;
      if (!active) return;
      if (error) {
        setErrorMessage("Errore nel caricamento delle notifiche.");
        setLoading(false);
        return;
      }
      let qrReportsCount = 0;
      const vehicleIds = ((vehiclesResult.data ?? []) as Array<{ id: string }>).map((vehicle) => vehicle.id);
      if (vehicleIds.length > 0) {
        const { count } = await supabase
          .from("vehicle_qr_reports")
          .select("id", { count: "exact", head: true })
          .eq("status", "open")
          .in("vehicle_id", vehicleIds);
        if (!active) return;
        qrReportsCount = count ?? 0;
      }

      const nextOperationalItems = [
        {
          key: "agency-bookings",
          title: "Richieste agenzia",
          detail: "Prenotazioni ricevute dalle agenzie da approvare.",
          count: agencyBookingsResult.count ?? 0,
          href: "/agency-requests",
          tone: "blue",
        },
        {
          key: "agency-reviews",
          title: "Revisioni agenzie",
          detail: "Modifiche agenzia da controllare prima di confermare.",
          count: agencyReviewsResult.count ?? 0,
          href: "/inbox/agency-reviews",
          tone: "violet",
        },
        {
          key: "cancellations",
          title: "Cancellazioni",
          detail: "Richieste di cancellazione ancora da gestire.",
          count: cancellationsResult.count ?? 0,
          href: "/cancellazioni",
          tone: "amber",
        },
        {
          key: "fleet-reports",
          title: "Segnalazioni veicoli",
          detail: "Segnalazioni QR aperte su mezzi o veicoli.",
          count: qrReportsCount,
          href: "/inbox/fleet-reports",
          tone: "rose",
        },
        {
          key: "access-requests",
          title: "Accessi utenti",
          detail: "Richieste di accesso team in attesa.",
          count: accessRequestsResult.count ?? 0,
          href: "/settings/users",
          tone: "slate",
        },
      ] satisfies OperationalNotification[];

      setRows((data ?? []) as ServiceChangeLogRow[]);
      setOperationalItems(nextOperationalItems.filter((item) => item.count > 0));
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, []);

  // "Far sparire" una notifica: la marca come letta/gestita per tutto il
  // tenant (mai una cancellazione della riga di audit sottostante — vedi
  // migration 0249) e la rimuove subito dalla lista locale.
  const dismiss = async (ids: string[]) => {
    if (!supabase || ids.length === 0) return;
    const session = await getClientSessionContext();
    const { error } = await supabase
      .from("service_change_logs")
      .update({ dismissed_at: new Date().toISOString(), dismissed_by_user_id: session.userId })
      .in("id", ids);
    if (error) {
      setErrorMessage("Errore nel segnare la notifica come letta.");
      return;
    }
    setRows((current) => current.filter((row) => !ids.includes(row.id)));
  };

  const dismissOne = async (id: string) => {
    if (dismissingId) return;
    setDismissingId(id);
    try { await dismiss([id]); } finally { setDismissingId(null); }
  };

  const dismissAll = async () => {
    if (dismissingAll || rows.length === 0) return;
    setDismissingAll(true);
    try { await dismiss(rows.map((row) => row.id)); } finally { setDismissingAll(false); }
  };

  const alerts = useMemo(() => rows.map(toAlert), [rows]);

  const groups = {
    high: alerts.filter((item) => item.severity === "high"),
    medium: alerts.filter((item) => item.severity === "medium"),
    low: alerts.filter((item) => item.severity === "low")
  };
  const operationalTotal = operationalItems.reduce((sum, item) => sum + item.count, 0);

  return (
    <section className="page-section">
      <PageHeader
        title="Centro notifiche"
        subtitle="Attivita operative da gestire e notifiche prenotazioni degli ultimi 14 giorni."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Notifiche" }]}
      />

      {errorMessage ? <EmptyState title="Notifiche non disponibili" description={errorMessage} compact /> : null}

      <SectionCard
        title="Da gestire adesso"
        loading={loading}
        loadingLines={3}
      >
        {operationalItems.length === 0 ? (
          <p className="text-sm text-muted">Nessuna attivita operativa pendente nei contatori della campanella.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {operationalItems.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-md ${operationalToneClass(item.tone)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-slate-950">{item.title}</p>
                    <p className="mt-1 text-xs font-medium text-slate-600">{item.detail}</p>
                  </div>
                  <span className="inline-flex min-w-10 justify-center rounded-full bg-white px-3 py-1 text-lg font-black shadow-sm">
                    {item.count > 99 ? "99+" : item.count}
                  </span>
                </div>
                <p className="mt-3 text-xs font-bold uppercase tracking-wide">Apri sezione →</p>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Azioni operative">
          <p className="text-3xl font-semibold text-blue-700">{operationalTotal}</p>
        </SectionCard>
        <SectionCard title="Alta priorita">
          <p className="text-3xl font-semibold text-rose-700">{groups.high.length}</p>
        </SectionCard>
        <SectionCard title="Media priorita">
          <p className="text-3xl font-semibold text-amber-700">{groups.medium.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Lista notifiche"
        loading={loading}
        loadingLines={6}
        actions={alerts.length > 0 ? (
          <button
            type="button"
            onClick={() => void dismissAll()}
            disabled={dismissingAll}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {dismissingAll ? "..." : "Segna tutte come lette"}
          </button>
        ) : undefined}
      >
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">Nessuna prenotazione nuova, modificata o cancellata negli ultimi {LOOKBACK_DAYS} giorni.</p>
        ) : (
          <div className="space-y-2">
            {alerts.map((item) => (
              <article key={item.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-text">{item.title}</p>
                  <span className={item.severity === "high" ? "rounded-full bg-rose-100 px-2 py-1 text-[11px] font-semibold uppercase text-rose-700" : item.severity === "medium" ? "rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold uppercase text-amber-700" : "rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600"}>
                    {item.severity}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-muted">{item.detail}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/services/${item.serviceId}/edit`} className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-100">
                      Apri prenotazione
                    </Link>
                    <button
                      type="button"
                      onClick={() => void dismissOne(item.id)}
                      disabled={dismissingId === item.id}
                      className="rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                    >
                      {dismissingId === item.id ? "..." : "✓ Letta"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
