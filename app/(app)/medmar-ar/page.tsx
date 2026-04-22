"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
import { DateInput } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import {
  ROUTE_LABELS,
  TICKET_MODE_LABELS,
  LEG_STATUS_LABELS,
  MEDMAR_TIMES_BY_ROUTE,
  formatEur,
  type MedmarRoute,
  type TicketMode,
  type MedmarArTicket,
  type MedmarArPendingGroup,
  type DecisionScenario,
} from "@/lib/medmar-ar/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function getToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function api<T>(
  path: string,
  options?: RequestInit,
  token?: string | null
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const t = token ?? (await getToken());
  if (!t) return { ok: false, error: "Sessione non valida." };
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null) as (T & { ok?: boolean; error?: string }) | null;
  if (!res.ok || !body?.ok) return { ok: false, error: body?.error ?? `Errore HTTP ${res.status}` };
  return { ok: true, data: body };
}

// ─── Colori badge ────────────────────────────────────────────────────────────

const MODE_COLORS: Record<TicketMode, string> = {
  round_trip:      "bg-indigo-100 text-indigo-700 border-indigo-200",
  single_outbound: "bg-emerald-100 text-emerald-700 border-emerald-200",
  single_return:   "bg-sky-100 text-sky-700 border-sky-200",
};

const LEG_STATUS_COLORS: Record<string, string> = {
  used:                       "bg-emerald-100 text-emerald-700",
  available_for_reassignment: "bg-amber-100 text-amber-700",
  reassigned:                 "bg-blue-100 text-blue-700",
  lost:                       "bg-rose-100 text-rose-700",
  not_applicable:             "bg-slate-100 text-slate-400",
};

const RISK_COLORS: Record<string, { card: string; badge: string }> = {
  none:   { card: "border-emerald-200 bg-emerald-50",  badge: "bg-emerald-600 text-white" },
  low:    { card: "border-emerald-200 bg-emerald-50",  badge: "bg-emerald-600 text-white" },
  medium: { card: "border-amber-200 bg-amber-50",      badge: "bg-amber-500 text-white" },
  high:   { card: "border-rose-200 bg-rose-50",        badge: "bg-rose-600 text-white" },
};

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = "emissione" | "biglietti" | "pending";

// ─── Componente Decision Helper ───────────────────────────────────────────────

function DecisionHelper({
  scenarios,
  probability,
  sampleSize,
  timeSignals,
  onSelect,
  loading,
}: {
  scenarios: DecisionScenario[];
  probability: number;
  sampleSize: number;
  timeSignals: Array<{ time: string; probability: number; signal: "high" | "medium" | "low" }>;
  onSelect: (mode: TicketMode | "pending_group") => void;
  loading: boolean;
}) {
  const recommended = scenarios.find((s) => s.recommended);

  if (loading) return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-400">
      Calcolo scenari in corso...
    </div>
  );

  if (!scenarios.length) return null;

  return (
    <div className="rounded-2xl border border-indigo-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="border-b border-indigo-100 bg-indigo-50 px-5 py-4">
        <h3 className="text-sm font-bold text-indigo-900">💡 Suggerimento Economico</h3>
        {sampleSize > 0 && (
          <p className="mt-0.5 text-xs text-indigo-600">
            Basato su {sampleSize} biglietti storici — probabilità ritorno usato: {Math.round(probability * 100)}%
          </p>
        )}
        {sampleSize === 0 && (
          <p className="mt-0.5 text-xs text-amber-600">⚠️ Dati storici insufficienti — probabilità default 50%</p>
        )}
      </div>

      {/* Raccomandazione */}
      {recommended && (
        <div className="border-b border-indigo-100 bg-indigo-600 px-5 py-3">
          <p className="text-sm font-semibold text-white">
            ✅ Scelta consigliata: <strong>{recommended.label}</strong> — {formatEur(recommended.totalCents)} totale
          </p>
        </div>
      )}

      {/* Card scenari */}
      <div className={`grid gap-4 p-5 ${scenarios.length === 1 ? "grid-cols-1" : scenarios.length === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1 sm:grid-cols-3"}`}>
        {scenarios.map((s) => {
          const colors = RISK_COLORS[s.riskLevel];
          return (
            <div
              key={s.mode}
              className={`relative rounded-xl border-2 p-4 space-y-3 transition-transform hover:scale-[1.01] ${colors.card} ${s.recommended ? "ring-2 ring-indigo-500 ring-offset-1" : ""}`}
            >
              {s.recommended && (
                <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-indigo-600 px-3 py-0.5 text-[10px] font-bold text-white uppercase tracking-wide">
                  Consigliato
                </span>
              )}
              <div className="flex items-start justify-between gap-2">
                <p className="font-bold text-slate-900 text-sm leading-tight">{s.label}</p>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${colors.badge}`}>
                  {s.badge}
                </span>
              </div>
              <p className="text-2xl font-extrabold text-slate-900">{formatEur(s.totalCents)}</p>
              <ul className="space-y-1">
                {s.details.map((d, i) => (
                  <li key={i} className="text-xs text-slate-600">{d}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => onSelect(s.mode)}
                className="w-full rounded-xl bg-slate-900 py-2 text-xs font-bold text-white hover:bg-slate-700 transition"
              >
                {s.mode === "round_trip" ? "Emetti A/R" :
                 s.mode === "single_outbound" ? "Emetti Singola Andata" :
                 s.mode === "single_return" ? "Emetti Singolo Ritorno" :
                 "Attendi Raggruppamento"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Semafori orari */}
      {timeSignals.length > 0 && (
        <div className="border-t border-slate-100 px-5 py-4">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Probabilità utilizzo ritorno per orario
          </p>
          <div className="flex flex-wrap gap-2">
            {timeSignals.map((ts) => (
              <div key={ts.time} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5">
                <span className={`h-2 w-2 rounded-full ${
                  ts.signal === "high" ? "bg-emerald-500" :
                  ts.signal === "medium" ? "bg-amber-400" : "bg-rose-400"
                }`} />
                <span className="text-xs font-mono font-semibold text-slate-700">{ts.time}</span>
                <span className="text-xs text-slate-400">{Math.round(ts.probability * 100)}%</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Componente Biglietto Card ────────────────────────────────────────────────

function TicketCard({
  ticket,
  onStatusChange,
}: {
  ticket: MedmarArTicket;
  onStatusChange: (legId: string, status: string) => void;
}) {
  const legs = ticket.legs ?? [];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <span className="font-bold text-slate-900 text-sm">#{ticket.voucher_number}</span>
          <span className="ml-2 text-xs text-slate-500">
            {new Date(`${ticket.travel_date}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
          </span>
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase ${MODE_COLORS[ticket.ticket_mode]}`}>
            {TICKET_MODE_LABELS[ticket.ticket_mode]}
          </span>
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[10px] font-semibold text-slate-600">
            {ticket.pax_count} pax
          </span>
        </div>
      </div>

      <div className="text-xs text-slate-600 space-y-0.5">
        <p>{ROUTE_LABELS[ticket.route as MedmarRoute] ?? ticket.route}</p>
        <div className="flex gap-4 text-slate-500">
          {ticket.outbound_time && <span>🛳️ Andata {ticket.outbound_time.slice(0, 5)}</span>}
          {ticket.return_time && <span>↩️ Ritorno {ticket.return_time.slice(0, 5)}</span>}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-lg font-extrabold text-slate-900">{formatEur(ticket.total_price_cents)}</span>
        <span className="text-xs text-slate-400">{formatEur(ticket.unit_price_cents)}/tratta·pax</span>
      </div>

      {/* Legs */}
      {legs.length > 0 && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          {legs.map((leg) => (
            <div key={leg.id} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs text-slate-500 w-16 shrink-0">
                  {leg.leg_type === "outbound" ? "Andata" : "Ritorno"}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${LEG_STATUS_COLORS[leg.status] ?? "bg-slate-100 text-slate-500"}`}>
                  {LEG_STATUS_LABELS[leg.status as keyof typeof LEG_STATUS_LABELS] ?? leg.status}
                </span>
              </div>
              {leg.status !== "not_applicable" && (
                <select
                  value={leg.status}
                  onChange={(e) => onStatusChange(leg.id, e.target.value)}
                  className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white"
                >
                  <option value="used">Utilizzato</option>
                  <option value="available_for_reassignment">Disponibile riassegnazione</option>
                  <option value="reassigned">Riassegnato</option>
                  <option value="lost">Perso</option>
                </select>
              )}
            </div>
          ))}
        </div>
      )}

      {ticket.notes && (
        <p className="text-xs text-slate-400 italic border-t border-slate-100 pt-2">{ticket.notes}</p>
      )}
    </div>
  );
}

// ─── Pagina principale ────────────────────────────────────────────────────────

export default function MedmarArPage() {
  const [tab, setTab] = useState<Tab>("emissione");
  const [token, setToken] = useState<string | null>(null);
  const [initError, setInitError] = useState("");

  // Form emissione
  const [formDate, setFormDate] = useState(todayIso());
  const [formVoucher, setFormVoucher] = useState("");
  const [formRoute, setFormRoute] = useState<MedmarRoute>("pozzuoli_ischia");
  const [formPax, setFormPax] = useState("");
  const [formMode, setFormMode] = useState<TicketMode | "">("");
  const [formOutbound, setFormOutbound] = useState("");
  const [formReturn, setFormReturn] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Decision Helper
  const [decisionLoading, setDecisionLoading] = useState(false);
  const [decisionData, setDecisionData] = useState<{
    scenarios: DecisionScenario[];
    probability: number;
    sampleSize: number;
    timeSignals: Array<{ time: string; probability: number; signal: "high" | "medium" | "low" }>;
  } | null>(null);

  // Lista biglietti
  const [tickets, setTickets] = useState<MedmarArTicket[]>([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [filterDateFrom, setFilterDateFrom] = useState(todayIso());
  const [filterDateTo, setFilterDateTo] = useState(todayIso());
  const [filterRoute, setFilterRoute] = useState("");
  const [filterMode, setFilterMode] = useState("");
  const [filterSearch, setFilterSearch] = useState("");

  // Pending groups
  const [pendingGroups, setPendingGroups] = useState<MedmarArPendingGroup[]>([]);
  const [pendingLoading, setPendingLoading] = useState(false);

  // Early-alert: biglietti A/R emessi con > 7 gg anticipo
  const earlyWarning = useMemo(() => {
    const today = todayIso();
    return tickets.filter((t) => {
      if (t.ticket_mode !== "round_trip" || t.pax_count >= 12) return false;
      const days = (new Date(t.travel_date).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24);
      return days > 7;
    });
  }, [tickets]);

  // Boot
  useEffect(() => {
    let active = true;
    const boot = async () => {
      const t = await getToken();
      if (!active) return;
      if (!t) { setInitError("Sessione non valida. Effettua il login."); return; }
      setToken(t);
    };
    void boot();
    return () => { active = false; };
  }, []);

  // Decision Helper: ricalcola quando cambiano route/pax/date
  useEffect(() => {
    if (!token || !formRoute || !formPax || parseInt(formPax) < 1) {
      setDecisionData(null);
      return;
    }
    const pax = parseInt(formPax);
    if (isNaN(pax) || pax < 1) return;

    const ctrl = new AbortController();
    setDecisionLoading(true);
    (async () => {
      const params = new URLSearchParams({
        route: formRoute,
        pax: String(pax),
        date: formDate,
        ...(formOutbound ? { outbound_time: formOutbound } : {}),
      });
      const res = await api<{
        scenarios: DecisionScenario[];
        return_usage_probability: number;
        historical_sample_size: number;
        time_signals: Array<{ time: string; probability: number; signal: "high" | "medium" | "low" }>;
      }>(
        `/api/medmar-ar/decision?${params}`,
        { signal: ctrl.signal },
        token
      );
      if (ctrl.signal.aborted) return;
      setDecisionLoading(false);
      if (res.ok && res.data) {
        setDecisionData({
          scenarios: res.data.scenarios,
          probability: res.data.return_usage_probability,
          sampleSize: res.data.historical_sample_size,
          timeSignals: res.data.time_signals,
        });
      }
    })().catch(() => setDecisionLoading(false));
    return () => ctrl.abort();
  }, [token, formRoute, formPax, formDate, formOutbound]);

  // Carica biglietti
  const loadTickets = useCallback(async () => {
    if (!token) return;
    setTicketsLoading(true);
    const params = new URLSearchParams({
      date_from: filterDateFrom,
      date_to: filterDateTo,
      ...(filterRoute ? { route: filterRoute } : {}),
      ...(filterMode ? { mode: filterMode } : {}),
      ...(filterSearch ? { q: filterSearch } : {}),
    });
    const res = await api<{ tickets: MedmarArTicket[] }>(`/api/medmar-ar/tickets?${params}`, undefined, token);
    setTicketsLoading(false);
    if (res.ok && res.data) setTickets(res.data.tickets);
  }, [token, filterDateFrom, filterDateTo, filterRoute, filterMode, filterSearch]);

  useEffect(() => {
    if (tab === "biglietti") void loadTickets();
  }, [tab, loadTickets]);

  // Carica pending groups
  const loadPending = useCallback(async () => {
    if (!token) return;
    setPendingLoading(true);
    const res = await api<{ groups: MedmarArPendingGroup[] }>("/api/medmar-ar/pending-groups?status=pending", undefined, token);
    setPendingLoading(false);
    if (res.ok && res.data) setPendingGroups(res.data.groups);
  }, [token]);

  useEffect(() => {
    if (tab === "pending") void loadPending();
  }, [tab, loadPending]);

  // Submit emissione
  const handleEmit = async (modeOverride?: TicketMode) => {
    const mode = modeOverride ?? (formMode as TicketMode);
    if (!mode) { setSubmitMsg({ type: "err", text: "Seleziona una modalità dal suggerimento economico." }); return; }
    if (!formVoucher.trim()) { setSubmitMsg({ type: "err", text: "Inserisci il numero voucher." }); return; }
    if (!formPax || parseInt(formPax) < 1) { setSubmitMsg({ type: "err", text: "Inserisci numero passeggeri valido." }); return; }
    if (mode !== "single_return" && !formOutbound) { setSubmitMsg({ type: "err", text: "Seleziona orario andata." }); return; }
    if (mode === "round_trip" && !formReturn) { setSubmitMsg({ type: "err", text: "Seleziona orario ritorno per A/R." }); return; }

    setSubmitting(true);
    setSubmitMsg(null);
    const res = await api<{ ticket: MedmarArTicket; total_price_cents: number }>(
      "/api/medmar-ar/tickets",
      {
        method: "POST",
        body: JSON.stringify({
          voucher_number: formVoucher.trim(),
          travel_date: formDate,
          route: formRoute,
          pax_count: parseInt(formPax),
          ticket_mode: mode,
          outbound_time: formOutbound || null,
          return_time: formReturn || null,
          notes: formNotes.trim() || null,
        }),
      },
      token
    );
    setSubmitting(false);
    if (res.ok && res.data) {
      setSubmitMsg({ type: "ok", text: `✅ Biglietto emesso — ${formatEur(res.data.total_price_cents)} totale` });
      setFormVoucher(""); setFormPax(""); setFormOutbound(""); setFormReturn(""); setFormNotes(""); setFormMode("");
    } else {
      setSubmitMsg({ type: "err", text: res.error ?? "Errore emissione biglietto." });
    }
  };

  // Submit pending group
  const handlePendingGroup = async () => {
    if (!formPax || parseInt(formPax) < 1) return;
    const res = await api<{ group: MedmarArPendingGroup }>(
      "/api/medmar-ar/pending-groups",
      {
        method: "POST",
        body: JSON.stringify({
          travel_date: formDate,
          route: formRoute,
          outbound_time: formOutbound || null,
          current_pax_count: parseInt(formPax),
        }),
      },
      token
    );
    if (res.ok) {
      setSubmitMsg({ type: "ok", text: "Gruppo in attesa creato. Riceverai notifica quando raggiungi 12 pax." });
      setFormVoucher(""); setFormPax(""); setFormMode("");
    } else {
      setSubmitMsg({ type: "err", text: res.error ?? "Errore creazione gruppo." });
    }
  };

  // Cambio stato leg
  const handleLegStatus = async (legId: string, status: string) => {
    const res = await api(
      "/api/medmar-ar/legs",
      { method: "PATCH", body: JSON.stringify({ leg_id: legId, status }) },
      token
    );
    if (res.ok) void loadTickets();
  };

  const availableTimes = MEDMAR_TIMES_BY_ROUTE[formRoute] ?? [];

  if (initError) return (
    <section className="page-section">
      <p className="text-sm text-rose-600">{initError}</p>
    </section>
  );

  return (
    <section className="page-section">
      <PageHeader
        title="Medmar A/R"
        subtitle="Gestione biglietti andata/ritorno con decision helper economico"
        breadcrumbs={[{ label: "Operativo", href: "/dashboard" }, { label: "Medmar A/R" }]}
      />

      {/* Early warning */}
      {earlyWarning.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-800">
            ⚠️ {earlyWarning.length} bigliett{earlyWarning.length === 1 ? "o A/R emesso" : "i A/R emessi"} con più di 7 giorni di anticipo
          </p>
          <p className="text-xs text-amber-600 mt-0.5">Valuta se attendere più visibilità prima dell'emissione.</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200">
        {([
          { id: "emissione", label: "✏️ Emissione" },
          { id: "biglietti", label: "🎫 Biglietti" },
          { id: "pending",   label: `⏳ Gruppi in attesa${pendingGroups.length > 0 ? ` (${pendingGroups.length})` : ""}` },
        ] as { id: Tab; label: string }[]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition ${
              tab === t.id
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ─── TAB: EMISSIONE ────────────────────────────────────────────────── */}
      {tab === "emissione" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Form */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-900">Dati biglietto</h2>

            {submitMsg && (
              <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
                submitMsg.type === "ok"
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-rose-50 text-rose-700 border border-rose-200"
              }`}>
                {submitMsg.text}
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-600">
                Data viaggio *
                <DateInput value={formDate} onChange={setFormDate} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                N° Voucher *
                <input
                  value={formVoucher}
                  onChange={(e) => setFormVoucher(e.target.value)}
                  placeholder="Es. V2025-001"
                  className="mt-1 input-saas w-full"
                />
              </label>
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Tratta *
                <select value={formRoute} onChange={(e) => { setFormRoute(e.target.value as MedmarRoute); setFormOutbound(""); setFormReturn(""); }} className="mt-1 input-saas w-full">
                  {(Object.keys(ROUTE_LABELS) as MedmarRoute[]).map((r) => (
                    <option key={r} value={r}>{ROUTE_LABELS[r]}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-600">
                N° Passeggeri *
                <input
                  type="number"
                  min="1"
                  value={formPax}
                  onChange={(e) => setFormPax(e.target.value)}
                  placeholder="Es. 4"
                  className="mt-1 input-saas w-full"
                />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Orario andata
                <select value={formOutbound} onChange={(e) => setFormOutbound(e.target.value)} className="mt-1 input-saas w-full">
                  <option value="">— Seleziona —</option>
                  {availableTimes.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </label>
              {(formMode === "round_trip") && (
                <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                  Orario ritorno *
                  <select value={formReturn} onChange={(e) => setFormReturn(e.target.value)} className="mt-1 input-saas w-full">
                    <option value="">— Seleziona —</option>
                    {availableTimes.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Note
                <textarea
                  value={formNotes}
                  onChange={(e) => setFormNotes(e.target.value)}
                  rows={2}
                  className="mt-1 input-saas w-full resize-none"
                />
              </label>
            </div>

            {/* Pulsanti di emissione diretta (senza decision helper) */}
            {formMode && (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleEmit()}
                className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {submitting ? "Emissione in corso..." : `Conferma: Emetti ${TICKET_MODE_LABELS[formMode as TicketMode]}`}
              </button>
            )}
          </div>

          {/* Decision Helper */}
          <div className="space-y-4">
            {formPax && parseInt(formPax) > 0 ? (
              <DecisionHelper
                scenarios={decisionData?.scenarios ?? []}
                probability={decisionData?.probability ?? 0.5}
                sampleSize={decisionData?.sampleSize ?? 0}
                timeSignals={decisionData?.timeSignals ?? []}
                loading={decisionLoading}
                onSelect={(mode) => {
                  if (mode === "pending_group") {
                    void handlePendingGroup();
                  } else {
                    setFormMode(mode);
                    void handleEmit(mode);
                  }
                }}
              />
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center">
                <p className="text-sm text-slate-400">
                  Inserisci tratta e numero passeggeri per vedere il suggerimento economico
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ─── TAB: BIGLIETTI ────────────────────────────────────────────────── */}
      {tab === "biglietti" && (
        <div className="space-y-4">
          {/* Filtri */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap gap-3 items-end">
            <label className="text-xs font-medium text-slate-600">
              Dal
              <DateInput value={filterDateFrom} onChange={(d) => { setFilterDateFrom(d); }} className="mt-1 input-saas" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Al
              <DateInput value={filterDateTo} onChange={(d) => { setFilterDateTo(d); }} className="mt-1 input-saas" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Tratta
              <select value={filterRoute} onChange={(e) => setFilterRoute(e.target.value)} className="mt-1 input-saas">
                <option value="">Tutte</option>
                {(Object.keys(ROUTE_LABELS) as MedmarRoute[]).map((r) => (
                  <option key={r} value={r}>{ROUTE_LABELS[r]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Modalità
              <select value={filterMode} onChange={(e) => setFilterMode(e.target.value)} className="mt-1 input-saas">
                <option value="">Tutte</option>
                <option value="round_trip">A/R</option>
                <option value="single_outbound">Solo Andata</option>
                <option value="single_return">Solo Ritorno</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Voucher
              <input value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)} placeholder="Cerca..." className="mt-1 input-saas" />
            </label>
            <button
              type="button"
              onClick={() => void loadTickets()}
              className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700"
            >
              Cerca
            </button>
          </div>

          {ticketsLoading && <p className="text-sm text-slate-400">Caricamento...</p>}

          {!ticketsLoading && tickets.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Nessun biglietto trovato per i filtri selezionati.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tickets.map((t) => (
              <TicketCard key={t.id} ticket={t} onStatusChange={handleLegStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ─── TAB: PENDING GROUPS ───────────────────────────────────────────── */}
      {tab === "pending" && (
        <div className="space-y-4">
          {pendingLoading && <p className="text-sm text-slate-400">Caricamento...</p>}

          {!pendingLoading && pendingGroups.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Nessun gruppo in attesa di raggruppamento.
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            {pendingGroups.map((g) => {
              const expiresAt = new Date(g.expires_at);
              const hoursLeft = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
              const isExpiringSoon = hoursLeft < 48;
              const paxMissing = g.target_threshold - g.current_pax_count;

              return (
                <div
                  key={g.id}
                  className={`rounded-2xl border p-5 space-y-3 ${isExpiringSoon ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50"}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-bold text-slate-900 text-sm">{ROUTE_LABELS[g.route as MedmarRoute] ?? g.route}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {new Date(`${g.travel_date}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                        {g.outbound_time && ` · ${g.outbound_time.slice(0, 5)}`}
                      </p>
                    </div>
                    {isExpiringSoon && (
                      <span className="rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">
                        ⏰ Scade presto
                      </span>
                    )}
                  </div>

                  <div className="flex gap-4 text-sm">
                    <div>
                      <p className="text-xs text-slate-500">Pax attuali</p>
                      <p className="font-bold text-slate-900">{g.current_pax_count}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Mancano</p>
                      <p className={`font-bold ${paxMissing <= 2 ? "text-emerald-600" : "text-amber-700"}`}>
                        {paxMissing}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Target</p>
                      <p className="font-bold text-slate-900">{g.target_threshold}</p>
                    </div>
                  </div>

                  <div className="w-full bg-white rounded-full h-2 border border-slate-200 overflow-hidden">
                    <div
                      className="h-full bg-amber-500 transition-all"
                      style={{ width: `${Math.min(100, (g.current_pax_count / g.target_threshold) * 100)}%` }}
                    />
                  </div>

                  <p className="text-xs text-slate-500">
                    Scadenza: {expiresAt.toLocaleDateString("it-IT", { day: "2-digit", month: "short" })} ore {expiresAt.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
                    {isExpiringSoon && ` (${Math.round(hoursLeft)}h rimaste)`}
                  </p>

                  {paxMissing <= 0 && (
                    <div className="rounded-xl bg-emerald-100 border border-emerald-200 px-3 py-2">
                      <p className="text-xs font-semibold text-emerald-700">
                        🎉 Soglia raggiunta! Puoi emettere a tariffa scontata.
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
