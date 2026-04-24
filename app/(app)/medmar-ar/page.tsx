"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
import { DateInput } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
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
import type { MedmarArStats } from "@/app/api/medmar-ar/stats/route";
import type { MatchOpportunity } from "@/app/api/medmar-ar/matching/route";
import type { SimulatorBase } from "@/app/api/medmar-ar/simulator/route";
import type { InsightsResponse, StrategicInsight } from "@/app/api/medmar-ar/insights/route";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfYear() {
  return `${todayIso().slice(0, 4)}-01-01`;
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

const URGENCY_COLORS: Record<string, string> = {
  critical: "border-rose-200 bg-rose-50",
  high:     "border-amber-200 bg-amber-50",
  normal:   "border-slate-200 bg-white",
};

const URGENCY_BADGE: Record<string, string> = {
  critical: "bg-rose-600 text-white",
  high:     "bg-amber-500 text-white",
  normal:   "bg-slate-200 text-slate-600",
};

const URGENCY_LABEL: Record<string, string> = {
  critical: "Critico",
  high:     "Urgente",
  normal:   "Normale",
};

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = "emissione" | "biglietti" | "pending" | "recupero" | "dashboard" | "simulatore" | "leve";

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

      {recommended && (
        <div className="border-b border-indigo-100 bg-indigo-600 px-5 py-3">
          <p className="text-sm font-semibold text-white">
            ✅ Scelta consigliata: <strong>{recommended.label}</strong> — {formatEur(recommended.totalCents)} totale
          </p>
        </div>
      )}

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

// ─── Componente KPI Card ──────────────────────────────────────────────────────

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold ${color ?? "text-slate-900"}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

// ─── Pagina principale ────────────────────────────────────────────────────────

export default function MedmarArPage() {
  const [nowMs] = useState(() => Date.now());
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

  // Recupero (matching)
  const [opportunities, setOpportunities] = useState<MatchOpportunity[]>([]);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [selectedOpportunity, setSelectedOpportunity] = useState<MatchOpportunity | null>(null);
  const [reassigning, setReassigning] = useState<string | null>(null); // booking_id in corso
  const [reassignMsg, setReassignMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // Dashboard / Stats
  const [stats, setStats] = useState<MedmarArStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsPeriodFrom, setStatsPeriodFrom] = useState(firstOfYear());
  const [statsPeriodTo, setStatsPeriodTo] = useState(todayIso());
  const [exportingExcel, setExportingExcel] = useState(false);

  // Simulatore
  const [simBase, setSimBase] = useState<SimulatorBase | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simMonthlyTickets, setSimMonthlyTickets] = useState(0);
  const [simArPct, setSimArPct] = useState(50);
  const [simReturnProb, setSimReturnProb] = useState(50);
  const [simAvgPax, setSimAvgPax] = useState(2);
  const [simBaseLoaded, setSimBaseLoaded] = useState(false);

  // Leve strategiche
  const [insights, setInsights] = useState<InsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);

  // Early-alert: biglietti A/R emessi con > 7 gg anticipo
  const earlyWarning = useMemo(() => {
    const today = todayIso();
    return tickets.filter((t) => {
      if (t.ticket_mode !== "round_trip" || t.pax_count >= 12) return false;
      const days = (new Date(t.travel_date).getTime() - new Date(today).getTime()) / (1000 * 60 * 60 * 24);
      return days > 7;
    });
  }, [tickets]);

  // Badge recupero
  const criticalOpp = opportunities.filter((o) => o.urgency === "critical").length;
  const highOpp = opportunities.filter((o) => o.urgency !== "normal").length;

  // Simulatore: calcolo scenari
  const simProjection = useMemo(() => {
    if (!simBase) return null;
    const p = simBase.prices;
    const arPct = simArPct / 100;
    const returnProb = simReturnProb / 100;
    const monthlyTickets = simMonthlyTickets;
    const avgPax = simAvgPax;

    const computeMonth = (tickets: number, ar: number, rProb: number, pax: number) => {
      const arTickets = Math.round(tickets * ar);
      const singleTickets = tickets - arTickets;
      const arValueCents = arTickets * 2 * p.round_trip_per_leg * pax;
      const singleValueCents = singleTickets * p.single_trip_under_12 * pax;
      const valueCents = arValueCents + singleValueCents;
      // Perdita attesa: per ogni biglietto A/R, prob (1-rProb) di perdere il ritorno
      const expectedLostCents = arTickets * (1 - rProb) * p.round_trip_per_leg * pax;
      return { tickets, pax: tickets * pax, valueCents, lostCents: Math.round(expectedLostCents) };
    };

    // 3 scenari fissi
    const scenarios = [
      {
        id: "pessimistico",
        label: "Pessimistico",
        color: "#ef4444",
        arPct: Math.min(1, arPct + 0.2),
        returnProb: Math.max(0, returnProb - 0.3),
      },
      {
        id: "realistico",
        label: "Realistico",
        color: "#4f46e5",
        arPct,
        returnProb,
      },
      {
        id: "ottimistico",
        label: "Ottimistico",
        color: "#22c55e",
        arPct: Math.max(0, arPct - 0.2),
        returnProb: Math.min(1, returnProb + 0.3),
      },
    ];

    return scenarios.map((sc) => {
      const monthlyData = simBase.remaining_month_names.map((month) => {
        const m = computeMonth(monthlyTickets, sc.arPct, sc.returnProb, avgPax);
        return { month, ...m };
      });
      const projectedValue = monthlyData.reduce((s, m) => s + m.valueCents, 0);
      const projectedLost = monthlyData.reduce((s, m) => s + m.lostCents, 0);
      const yearEndValue = simBase.ytd.total_value_cents + projectedValue;
      const yearEndLost = simBase.ytd.total_lost_cents + projectedLost;
      return {
        ...sc,
        monthlyData,
        projectedValue,
        projectedLost,
        yearEndValue,
        yearEndLost,
        yearEndNet: yearEndValue - yearEndLost,
      };
    });
  }, [simBase, simMonthlyTickets, simArPct, simReturnProb, simAvgPax]);

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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "pending") void loadPending();
  }, [tab, loadPending]);

  // Carica opportunità di recupero
  const loadOpportunities = useCallback(async () => {
    if (!token) return;
    setOpportunitiesLoading(true);
    const res = await api<{ opportunities: MatchOpportunity[]; total_available: number; total_value_cents: number }>(
      "/api/medmar-ar/matching",
      undefined,
      token
    );
    setOpportunitiesLoading(false);
    if (res.ok && res.data) setOpportunities(res.data.opportunities);
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "recupero") void loadOpportunities();
  }, [tab, loadOpportunities]);

  // Carica stats
  const loadStats = useCallback(async () => {
    if (!token) return;
    setStatsLoading(true);
    const params = new URLSearchParams({ date_from: statsPeriodFrom, date_to: statsPeriodTo });
    const res = await api<{ stats: MedmarArStats }>(`/api/medmar-ar/stats?${params}`, undefined, token);
    setStatsLoading(false);
    if (res.ok && res.data) setStats(res.data.stats);
  }, [token, statsPeriodFrom, statsPeriodTo]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "dashboard") void loadStats();
  }, [tab, loadStats]);

  // Carica base simulatore
  const loadSimulator = useCallback(async () => {
    if (!token) return;
    setSimLoading(true);
    const res = await api<SimulatorBase & { ok: boolean }>("/api/medmar-ar/simulator", undefined, token);
    setSimLoading(false);
    if (res.ok && res.data) {
      setSimBase(res.data);
      if (!simBaseLoaded) {
        setSimMonthlyTickets(Math.round(res.data.ytd.avg_monthly_tickets) || 10);
        setSimArPct(Math.round(res.data.ytd.ar_percentage * 100));
        setSimReturnProb(Math.round(res.data.ytd.return_usage_probability * 100));
        setSimAvgPax(Math.round(res.data.ytd.avg_pax_per_ticket) || 2);
        setSimBaseLoaded(true);
      }
    }
  }, [token, simBaseLoaded]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "simulatore") void loadSimulator();
  }, [tab, loadSimulator]);

  // Carica leve strategiche
  const loadInsights = useCallback(async () => {
    if (!token) return;
    setInsightsLoading(true);
    const res = await api<InsightsResponse>("/api/medmar-ar/insights", undefined, token);
    setInsightsLoading(false);
    if (res.ok && res.data) setInsights(res.data);
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === "leve") void loadInsights();
  }, [tab, loadInsights]);

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

  // Riassegna leg a prenotazione
  const handleReassign = async (legId: string, bookingId: string) => {
    setReassigning(bookingId);
    setReassignMsg(null);
    const res = await api<{ customer_name: string; value_recovered_cents: number }>(
      "/api/medmar-ar/matching",
      { method: "POST", body: JSON.stringify({ leg_id: legId, booking_id: bookingId }) },
      token
    );
    setReassigning(null);
    if (res.ok && res.data) {
      setReassignMsg({ type: "ok", text: `✅ Riassegnato a ${res.data.customer_name} — recuperato ${formatEur(res.data.value_recovered_cents)}` });
      setSelectedOpportunity(null);
      void loadOpportunities();
    } else {
      setReassignMsg({ type: "err", text: res.error ?? "Errore riassegnazione." });
    }
  };

  // Export Excel
  const handleExport = async () => {
    if (!token) return;
    setExportingExcel(true);
    const params = new URLSearchParams({ date_from: statsPeriodFrom, date_to: statsPeriodTo });
    const res = await fetch(`/api/medmar-ar/export?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `medmar-ar_${statsPeriodFrom}_${statsPeriodTo}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    }
    setExportingExcel(false);
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
          <p className="text-xs text-amber-600 mt-0.5">Valuta se attendere più visibilità prima dell&apos;emissione.</p>
        </div>
      )}

      {/* Alert opportunità critiche */}
      {criticalOpp > 0 && tab !== "recupero" && (
        <button
          type="button"
          onClick={() => setTab("recupero")}
          className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-left hover:bg-rose-100 transition"
        >
          <p className="text-sm font-semibold text-rose-800">
            🚨 {criticalOpp} tratt{criticalOpp === 1 ? "a in scadenza critica" : "e in scadenza critica"} — clicca per gestire il recupero
          </p>
        </button>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {([
          { id: "emissione",  label: "✏️ Emissione" },
          { id: "biglietti",  label: "🎫 Biglietti" },
          { id: "pending",    label: `⏳ Gruppi${pendingGroups.length > 0 ? ` (${pendingGroups.length})` : ""}` },
          { id: "recupero",   label: `🎯 Recupero${highOpp > 0 ? ` (${highOpp})` : ""}` },
          { id: "dashboard",   label: "📊 Dashboard" },
          { id: "simulatore",  label: "🔭 Simulatore" },
          { id: "leve",        label: `⚡ Leve${insights && insights.summary.high_priority_count > 0 ? ` (${insights.summary.high_priority_count})` : ""}` },
        ] as { id: Tab; label: string }[]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`shrink-0 px-4 py-2.5 text-sm font-semibold border-b-2 transition ${
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
            <button type="button" onClick={() => void loadTickets()} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700">
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
              const hoursLeft = (expiresAt.getTime() - nowMs) / (1000 * 60 * 60);
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

      {/* ─── TAB: RECUPERO ─────────────────────────────────────────────────── */}
      {tab === "recupero" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              Tratte disponibili per riassegnazione con prenotazioni compatibili
            </p>
            <button type="button" onClick={() => void loadOpportunities()} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              ↻ Aggiorna
            </button>
          </div>

          {reassignMsg && (
            <div className={`rounded-xl px-4 py-3 text-sm font-medium ${
              reassignMsg.type === "ok"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-rose-50 text-rose-700 border border-rose-200"
            }`}>
              {reassignMsg.text}
            </div>
          )}

          {opportunitiesLoading && <p className="text-sm text-slate-400">Caricamento opportunità...</p>}

          {!opportunitiesLoading && opportunities.length === 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Nessuna opportunità di recupero al momento.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {opportunities.map((opp) => (
              <div
                key={opp.leg.id}
                className={`rounded-2xl border p-5 space-y-3 cursor-pointer transition hover:shadow-md ${URGENCY_COLORS[opp.urgency]} ${selectedOpportunity?.leg.id === opp.leg.id ? "ring-2 ring-indigo-500" : ""}`}
                onClick={() => setSelectedOpportunity(selectedOpportunity?.leg.id === opp.leg.id ? null : opp)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold text-slate-900 text-sm">
                      {opp.leg.leg_type === "outbound" ? "🛳️ Andata" : "↩️ Ritorno"} — {opp.leg.leg_route}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {opp.leg.ticket?.travel_date && new Date(`${opp.leg.ticket.travel_date}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}
                      {opp.leg.leg_time && ` · ore ${opp.leg.leg_time}`}
                      {opp.leg.ticket && ` · ${opp.leg.ticket.pax_count} pax`}
                    </p>
                    <p className="text-xs text-slate-500">
                      Voucher #{opp.leg.ticket?.voucher_number ?? "—"}
                    </p>
                  </div>
                  <div className="shrink-0 text-right space-y-1">
                    <span className={`block rounded-full px-2 py-0.5 text-[10px] font-bold ${URGENCY_BADGE[opp.urgency]}`}>
                      {URGENCY_LABEL[opp.urgency]}
                    </span>
                    <p className="text-sm font-extrabold text-slate-900">{formatEur(opp.value_cents)}</p>
                    <p className="text-[10px] text-slate-400">{Math.round(opp.hours_to_expiry)}h rimaste</p>
                  </div>
                </div>

                {/* Prenotazioni compatibili */}
                {opp.matched_bookings.length > 0 ? (
                  <div className="border-t border-slate-200 pt-3 space-y-2">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                      {opp.matched_bookings.length} prenotazion{opp.matched_bookings.length === 1 ? "e" : "i"} compatibil{opp.matched_bookings.length === 1 ? "e" : "i"}
                    </p>
                    {opp.matched_bookings.map((b) => (
                      <div key={b.id} className="flex items-center justify-between gap-2 rounded-xl bg-white border border-slate-200 px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-slate-900 truncate">{b.customer_name ?? "—"}</p>
                          <p className="text-xs text-slate-500">
                            {b.pax ? `${b.pax} pax` : ""}
                            {b.hotel_name ? ` · ${b.hotel_name}` : ""}
                            {b.time ? ` · ${b.time.slice(0, 5)}` : ""}
                          </p>
                          {b.phone && <p className="text-xs text-slate-400">{b.phone}</p>}
                        </div>
                        <button
                          type="button"
                          disabled={reassigning === b.id}
                          onClick={(e) => { e.stopPropagation(); void handleReassign(opp.leg.id, b.id); }}
                          className="shrink-0 rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
                        >
                          {reassigning === b.id ? "..." : "Riassegna"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="border-t border-slate-200 pt-3">
                    <p className="text-xs text-slate-400">Nessuna prenotazione compatibile trovata — tratta a rischio perdita.</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── TAB: DASHBOARD ────────────────────────────────────────────────── */}
      {tab === "dashboard" && (
        <div className="space-y-6">
          {/* Toolbar periodo */}
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-xs font-medium text-slate-600">
              Dal
              <DateInput value={statsPeriodFrom} onChange={setStatsPeriodFrom} className="mt-1 input-saas" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Al
              <DateInput value={statsPeriodTo} onChange={setStatsPeriodTo} className="mt-1 input-saas" />
            </label>
            <button type="button" onClick={() => void loadStats()} className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white hover:bg-slate-700">
              Aggiorna
            </button>
            <button
              type="button"
              disabled={exportingExcel}
              onClick={() => void handleExport()}
              className="rounded-xl border border-emerald-600 px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
            >
              {exportingExcel ? "Esportando..." : "⬇ Export Excel"}
            </button>
            <button
              type="button"
              onClick={() => {
                const params = new URLSearchParams({ date_from: statsPeriodFrom, date_to: statsPeriodTo });
                window.open(`/medmar-ar/stampa?${params}`, "_blank");
              }}
              className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50"
            >
              🖨️ Stampa / PDF
            </button>
          </div>

          {statsLoading && <p className="text-sm text-slate-400">Caricamento statistiche...</p>}

          {stats && (
            <>
              {/* KPI Cards */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                  label="Biglietti emessi"
                  value={String(stats.kpi.total_tickets)}
                  sub={`${stats.kpi.total_pax} passeggeri totali`}
                />
                <KpiCard
                  label="Valore totale"
                  value={formatEur(stats.kpi.total_value_cents)}
                  sub={`A/R: ${stats.kpi.by_mode.round_trip} · Andata: ${stats.kpi.by_mode.single_outbound} · Ritorno: ${stats.kpi.by_mode.single_return}`}
                />
                <KpiCard
                  label="Perso netto"
                  value={formatEur(stats.kpi.net_loss_cents)}
                  sub={`Perso: ${formatEur(stats.kpi.value_lost_cents)} · Recuperato: ${formatEur(stats.kpi.value_recovered_cents)}`}
                  color={stats.kpi.loss_traffic_light === "green" ? "text-emerald-600" : stats.kpi.loss_traffic_light === "yellow" ? "text-amber-600" : "text-rose-600"}
                />
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Stato tratte</p>
                  <div className="mt-2 space-y-1.5">
                    {[
                      { label: "Utilizzate",   val: stats.kpi.legs.used,                       color: "bg-emerald-500" },
                      { label: "Disponibili",  val: stats.kpi.legs.available,                  color: "bg-amber-400" },
                      { label: "Riassegnate",  val: stats.kpi.legs.reassigned,                 color: "bg-blue-500" },
                      { label: "Perse",        val: stats.kpi.legs.lost,                       color: "bg-rose-500" },
                    ].map((item) => (
                      <div key={item.label} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${item.color}`} />
                          <span className="text-xs text-slate-500">{item.label}</span>
                        </div>
                        <span className="text-xs font-bold text-slate-900">{item.val}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Trend mensile */}
              {stats.monthly_trend.length > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900 mb-4">Trend mensile — Valore emesso vs perso</h3>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={stats.monthly_trend.map((d) => ({
                      month: d.month.slice(5),
                      valore: d.value_cents / 100,
                      perso: d.lost_cents / 100,
                      recuperato: d.recovered_cents / 100,
                    }))}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `€${v}`} />
                      <Tooltip formatter={(v) => typeof v === "number" ? `€${v.toFixed(2)}` : v} />
                      <Line type="monotone" dataKey="valore" stroke="#4f46e5" strokeWidth={2} dot={false} name="Valore" />
                      <Line type="monotone" dataKey="perso" stroke="#ef4444" strokeWidth={2} dot={false} name="Perso" />
                      <Line type="monotone" dataKey="recuperato" stroke="#22c55e" strokeWidth={2} dot={false} name="Recuperato" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {/* Per tratta */}
                {stats.by_route.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-sm font-bold text-slate-900 mb-4">Biglietti per tratta</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stats.by_route.map((r) => ({
                        route: (ROUTE_LABELS[r.route as MedmarRoute] ?? r.route).replace(" → ", "→").split("→")[1]?.trim() ?? r.route,
                        biglietti: r.tickets,
                        perso: r.lost_cents / 100,
                      }))}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                        <XAxis dataKey="route" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Bar dataKey="biglietti" fill="#4f46e5" radius={[4, 4, 0, 0]} name="Biglietti">
                          {stats.by_route.map((_, i) => (
                            <Cell key={i} fill={["#4f46e5", "#6366f1", "#818cf8", "#a5b4fc"][i % 4]} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Per operatore */}
                {stats.by_operator.length > 0 && (
                  <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                    <h3 className="text-sm font-bold text-slate-900 mb-4">Per operatore</h3>
                    <div className="space-y-2">
                      {stats.by_operator.sort((a, b) => b.tickets - a.tickets).map((op) => {
                        const maxTickets = Math.max(...stats.by_operator.map((o) => o.tickets));
                        return (
                          <div key={op.operator_id} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="font-medium text-slate-700 truncate max-w-[140px]">{op.operator_name}</span>
                              <span className="text-slate-500">{op.tickets} bgl · {op.round_trip_count} A/R{op.lost_cents > 0 ? ` · 🔴 ${formatEur(op.lost_cents)}` : ""}</span>
                            </div>
                            <div className="w-full bg-slate-100 rounded-full h-1.5">
                              <div
                                className="h-1.5 bg-indigo-500 rounded-full transition-all"
                                style={{ width: `${maxTickets > 0 ? (op.tickets / maxTickets) * 100 : 0}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Tratte in scadenza */}
              {stats.expiring_legs.length > 0 && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 space-y-3">
                  <h3 className="text-sm font-bold text-rose-900">⏰ Tratte in scadenza (&lt; 48h)</h3>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {stats.expiring_legs.map((leg) => (
                      <div key={leg.id} className="rounded-xl bg-white border border-rose-200 px-3 py-2.5 space-y-0.5">
                        <p className="text-xs font-semibold text-slate-900">{leg.leg_route}</p>
                        <p className="text-xs text-slate-500">
                          {new Date(`${leg.travel_date}T00:00:00`).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                          {leg.leg_time && ` · ${leg.leg_time}`}
                        </p>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold text-rose-700">{formatEur(leg.value_cents)}</span>
                          <span className="text-[10px] text-rose-500">{Math.round(leg.hours_to_expiry)}h rimaste</span>
                        </div>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => setTab("recupero")}
                    className="rounded-xl bg-rose-600 px-4 py-2 text-xs font-bold text-white hover:bg-rose-700"
                  >
                    Gestisci recupero →
                  </button>
                </div>
              )}
            </>
          )}

          {!statsLoading && !stats && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Clicca &quot;Aggiorna&quot; per caricare le statistiche del periodo.
            </div>
          )}
        </div>
      )}

      {/* ─── TAB: SIMULATORE ───────────────────────────────────────────────── */}
      {tab === "simulatore" && (
        <div className="space-y-6">
          {simLoading && <p className="text-sm text-slate-400">Caricamento dati storici...</p>}

          {simBase && (
            <>
              {/* Header YTD */}
              <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 space-y-1">
                <p className="text-sm font-bold text-indigo-900">
                  📅 Anno {simBase.year} — {simBase.completed_months} mes{simBase.completed_months === 1 ? "e" : "i"} completat{simBase.completed_months === 1 ? "o" : "i"},&nbsp;
                  {simBase.remaining_months} rimanent{simBase.remaining_months === 1 ? "e" : "i"}
                </p>
                <p className="text-xs text-indigo-600">
                  YTD: {simBase.ytd.total_tickets} biglietti · {formatEur(simBase.ytd.total_value_cents)} emessi ·&nbsp;
                  Perso netto {formatEur(simBase.ytd.net_loss_cents)} ·&nbsp;
                  Prob. ritorno storica {Math.round(simBase.ytd.return_usage_probability * 100)}%
                </p>
              </div>

              {/* Slider parametri */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-5">
                <h3 className="text-sm font-bold text-slate-900">⚙️ Parametri previsione</h3>
                <div className="grid gap-5 sm:grid-cols-2">

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-600">Biglietti/mese attesi</span>
                      <span className="font-bold text-slate-900">{simMonthlyTickets}</span>
                    </div>
                    <input type="range" min="1" max="200" step="1"
                      value={simMonthlyTickets}
                      onChange={(e) => setSimMonthlyTickets(Number(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                    <p className="text-[10px] text-slate-400">Media YTD: {simBase.ytd.avg_monthly_tickets}</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-600">% biglietti A/R</span>
                      <span className="font-bold text-slate-900">{simArPct}%</span>
                    </div>
                    <input type="range" min="0" max="100" step="5"
                      value={simArPct}
                      onChange={(e) => setSimArPct(Number(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                    <p className="text-[10px] text-slate-400">YTD attuale: {Math.round(simBase.ytd.ar_percentage * 100)}%</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-600">Probabilità ritorno usato</span>
                      <span className={`font-bold ${simReturnProb >= 60 ? "text-emerald-600" : simReturnProb >= 40 ? "text-amber-600" : "text-rose-600"}`}>
                        {simReturnProb}%
                      </span>
                    </div>
                    <input type="range" min="0" max="100" step="5"
                      value={simReturnProb}
                      onChange={(e) => setSimReturnProb(Number(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                    <p className="text-[10px] text-slate-400">Storico: {Math.round(simBase.ytd.return_usage_probability * 100)}%</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="font-medium text-slate-600">Pax medi per biglietto</span>
                      <span className="font-bold text-slate-900">{simAvgPax}</span>
                    </div>
                    <input type="range" min="1" max="20" step="1"
                      value={simAvgPax}
                      onChange={(e) => setSimAvgPax(Number(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                    <p className="text-[10px] text-slate-400">YTD attuale: {simBase.ytd.avg_pax_per_ticket}</p>
                  </div>
                </div>
              </div>

              {/* Scenari */}
              {simProjection && (
                <>
                  <div className="grid gap-4 sm:grid-cols-3">
                    {simProjection.map((sc) => (
                      <div key={sc.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: sc.color }} />
                          <p className="text-sm font-bold text-slate-900">{sc.label}</p>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">A/R previsto</span>
                            <span className="font-semibold">{Math.round(sc.arPct * 100)}%</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Prob. ritorno</span>
                            <span className={`font-semibold ${sc.returnProb >= 0.6 ? "text-emerald-600" : sc.returnProb >= 0.4 ? "text-amber-600" : "text-rose-600"}`}>
                              {Math.round(sc.returnProb * 100)}%
                            </span>
                          </div>
                        </div>
                        <div className="border-t border-slate-100 pt-3 space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Valore proiettato</span>
                            <span className="font-bold">{formatEur(sc.projectedValue)}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Perdita attesa</span>
                            <span className="font-bold text-rose-600">{formatEur(sc.projectedLost)}</span>
                          </div>
                        </div>
                        <div className="rounded-xl p-3 space-y-1" style={{ backgroundColor: sc.color + "15" }}>
                          <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: sc.color }}>
                            Fine anno
                          </p>
                          <p className="text-xl font-extrabold text-slate-900">{formatEur(sc.yearEndValue)}</p>
                          <p className="text-xs" style={{ color: sc.color }}>
                            Perso stimato: {formatEur(sc.yearEndLost)}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Grafico proiezione mensile */}
                  {simBase.remaining_months > 0 && (
                    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                      <h3 className="text-sm font-bold text-slate-900 mb-4">Proiezione mensile — perdita attesa</h3>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart
                          data={simBase.remaining_month_names.map((month, i) => {
                            const row: Record<string, unknown> = { month: month.slice(5) };
                            for (const sc of simProjection) {
                              row[sc.label] = sc.monthlyData[i]?.lostCents ? sc.monthlyData[i].lostCents / 100 : 0;
                            }
                            return row;
                          })}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                          <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `€${v}`} />
                          <Tooltip formatter={(v) => typeof v === "number" ? `€${v.toFixed(2)}` : v} />
                          {simProjection.map((sc) => (
                            <Bar key={sc.id} dataKey={sc.label} fill={sc.color} radius={[3, 3, 0, 0]} opacity={0.8} />
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Breakeven */}
                  {(() => {
                    const singleCost = simBase.prices.single_trip_under_12;
                    const arLegCost = simBase.prices.round_trip_per_leg;
                    // AR totale = 2*arLeg; atteso con prob p = 2*arLeg*p + (arLeg + single)*(1-p)
                    // break-even con single: 2*arLeg*p + arLeg*(1-p) + single*(1-p) = single
                    // p*(2*arLeg - arLeg - single) = single - arLeg - single = -arLeg → p = arLeg/(arLeg+single-arLeg) = arLeg/single? No...
                    // Expected AR cost = arLeg + arLeg*p (pago sempre andata arLeg, ritorno lo uso con prob p → costo atteso ritorno arLeg*p)
                    // vs single cost = single
                    // Breakeven: arLeg + arLeg*p = single → p = (single - arLeg) / arLeg
                    const breakEvenProb = (singleCost - arLegCost) / arLegCost;
                    const breakEvenPct = Math.round(Math.max(0, Math.min(1, breakEvenProb)) * 100);
                    const currentAbove = simReturnProb >= breakEvenPct;
                    return (
                      <div className={`rounded-2xl border p-5 space-y-2 ${currentAbove ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                        <p className="text-sm font-bold text-slate-900">
                          {currentAbove ? "✅" : "⚠️"} Punto di pareggio A/R vs Singola
                        </p>
                        <p className="text-xs text-slate-600">
                          Con la tariffa attuale ({formatEur(arLegCost)}/tratta A/R vs {formatEur(singleCost)} singola),
                          l&apos;A/R conviene se la probabilità di utilizzo del ritorno è{" "}
                          <strong>superiore al {breakEvenPct}%</strong>.
                        </p>
                        <p className={`text-xs font-semibold ${currentAbove ? "text-emerald-700" : "text-amber-700"}`}>
                          Parametro corrente: {simReturnProb}% — {currentAbove ? "sopra il break-even, A/R conviene" : "sotto il break-even, meglio singola"}
                        </p>
                        <div className="w-full bg-white rounded-full h-2.5 border border-slate-200 overflow-hidden relative mt-2">
                          <div
                            className={`h-2.5 rounded-full transition-all ${currentAbove ? "bg-emerald-500" : "bg-amber-400"}`}
                            style={{ width: `${simReturnProb}%` }}
                          />
                          <div
                            className="absolute top-0 h-2.5 w-0.5 bg-slate-700"
                            style={{ left: `${breakEvenPct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[10px] text-slate-400">
                          <span>0%</span>
                          <span className="font-semibold text-slate-600">Break-even: {breakEvenPct}%</span>
                          <span>100%</span>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}

          {!simLoading && !simBase && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Caricamento dati in corso...
            </div>
          )}
        </div>
      )}

      {/* ─── TAB: LEVE STRATEGICHE ─────────────────────────────────────────── */}
      {tab === "leve" && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-600">
              Raccomandazioni prioritizzate basate sui dati dell&apos;anno corrente
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void loadInsights()} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                ↻ Aggiorna
              </button>
              <button
                type="button"
                onClick={() => window.open(`/medmar-ar/stampa`, "_blank")}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                🖨️ Stampa report
              </button>
            </div>
          </div>

          {insightsLoading && <p className="text-sm text-slate-400">Analisi in corso...</p>}

          {insights && (
            <>
              {/* Sommario */}
              <div className="rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4">
                <div className="flex flex-wrap gap-6">
                  <div>
                    <p className="text-xs font-semibold text-indigo-500 uppercase">Risparmio potenziale</p>
                    <p className="text-xl font-extrabold text-indigo-900 mt-0.5">{formatEur(insights.summary.total_potential_savings_cents)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-indigo-500 uppercase">Alta priorità</p>
                    <p className="text-xl font-extrabold text-indigo-900 mt-0.5">{insights.summary.high_priority_count}</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-indigo-500 uppercase">Break-even A/R</p>
                    <p className="text-xl font-extrabold text-indigo-900 mt-0.5">{Math.round(insights.summary.breakeven_probability * 100)}%</p>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-indigo-500 uppercase">Prob. attuale</p>
                    <p className={`text-xl font-extrabold mt-0.5 ${insights.summary.current_probability >= insights.summary.breakeven_probability ? "text-emerald-700" : "text-rose-600"}`}>
                      {Math.round(insights.summary.current_probability * 100)}%
                    </p>
                  </div>
                </div>
              </div>

              {insights.insights.length === 0 && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center space-y-2">
                  <p className="text-2xl">✅</p>
                  <p className="text-sm font-semibold text-emerald-800">Nessuna azione urgente rilevata</p>
                  <p className="text-xs text-emerald-600">La gestione dei biglietti A/R è nella norma. Continua così!</p>
                </div>
              )}

              {/* Card insights per priorità */}
              {(["high", "medium", "low"] as const)
                .map((priority) => {
                  const group = insights.insights.filter((i: StrategicInsight) => i.priority === priority);
                  if (group.length === 0) return null;
                  const labelMap = { high: "🔴 Alta priorità", medium: "🟡 Media priorità", low: "⚪ Bassa priorità" };
                  return (
                    <div key={priority} className="space-y-3">
                      <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">{labelMap[priority]}</h3>
                      {group.map((ins: StrategicInsight) => (
                        <div
                          key={ins.id}
                          className={`rounded-2xl border p-5 space-y-3 ${
                            priority === "high" ? "border-rose-200 bg-rose-50" :
                            priority === "medium" ? "border-amber-200 bg-amber-50" :
                            "border-slate-200 bg-white"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                              <p className="font-bold text-slate-900 text-sm">{ins.title}</p>
                              <p className="text-xs text-slate-600">{ins.description}</p>
                            </div>
                            {ins.impact_cents > 0 && (
                              <div className="shrink-0 text-right">
                                <p className="text-[10px] text-slate-400 uppercase font-semibold">Impatto stimato</p>
                                <p className="text-sm font-extrabold text-slate-900">{formatEur(ins.impact_cents)}</p>
                              </div>
                            )}
                          </div>
                          <div className={`rounded-xl px-4 py-3 ${
                            priority === "high" ? "bg-rose-100" :
                            priority === "medium" ? "bg-amber-100" :
                            "bg-slate-100"
                          }`}>
                            <p className="text-xs font-semibold text-slate-700">→ {ins.action}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
            </>
          )}

          {!insightsLoading && !insights && (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
              Caricamento analisi in corso...
            </div>
          )}
        </div>
      )}
    </section>
  );
}
