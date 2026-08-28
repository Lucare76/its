"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";

type StatusGroup = "read" | "delivered" | "pending" | "failed";
type KpiFilter = "all" | StatusGroup;
type KPI = {
  total: number;
  read: number;
  delivered: number;
  sent: number;
  pending: number;
  failed: number;
  notRead: number;
};
type LogRow = {
  service_id: string | null;
  to_phone: string;
  template: string | null;
  status: string;
  status_group: StatusGroup;
  happened_at: string;
  customer_name: string | null;
  arrival_date: string | null;
  booking_service_kind: string | null;
};

// ── MEDMAR daily-convocation log ──────────────────────────────────────────
type MedmarSendState = "sent" | "failed" | "not_sent";
type MedmarSummary = {
  total: number;
  sent: number;
  failed: number;
  notSent: number;
  delivered: number;
  read: number;
  successRate: number;
};
type MedmarRow = {
  row_id: string;
  to_phone: string;
  customer_name: string;
  travel_date: string;
  travel_date_iso: string | null;
  route: string;
  departure_time: string;
  passengers: string;
  send_state: MedmarSendState;
  status: string;
  status_group: StatusGroup;
  happened_at: string | null;
  template: string | null;
  language_code: string | null;
  params: string[];
  operator_name: string | null;
  attempt_number: number | null;
  error_code: string | null;
  error_message: string | null;
  error_raw: unknown;
  file_name: string | null;
  batch_label: string | null;
};

// ── SNAV daily-convocation log ────────────────────────────────────────────
type SnavSendState = "sent" | "failed" | "not_sent";
type SnavSummary = {
  total: number;
  expected: number;
  sent: number;
  failed: number;
  notSent: number;
  missing: number;
  delivered: number;
  read: number;
  pending: number;
  successRate: number;
  readRate: number;
};
type SnavRow = {
  row_id: string;
  to_phone: string;
  customer_name: string;
  departure_date_label: string;
  departure_date: string | null;
  hotel: string;
  passengers: string;
  pickup_time: string;
  vessel_time: string;
  send_state: SnavSendState;
  status: string;
  status_group: StatusGroup;
  happened_at: string | null;
  template: string | null;
  language_code: string | null;
  params: string[];
  operator_name: string | null;
  attempt_number: number | null;
  error_code: string | null;
  error_message: string | null;
  error_raw: unknown;
  file_name: string | null;
  batch_label: string | null;
};

// Mirrors MEDMAR_PARAM_LABELS in lib/server/medmar-whatsapp-log.ts — kept
// inline so this client component never imports a server-only module.
const MEDMAR_PARAM_LABELS = ["Cliente", "Data partenza", "Hotel", "Pax", "Ora prelevamento", "Ora nave"];
// Mirrors SNAV_PARAM_LABELS in lib/server/snav-whatsapp-log.ts.
const SNAV_PARAM_LABELS = ["Cliente", "Data partenza", "Hotel", "Pax", "Ora prelevamento", "Ora aliscafo"];

const kindLabel: Record<string, string> = {
  transfer_airport_hotel: "Aeroporto",
  transfer_train_hotel: "Stazione",
  formula_medmar_napoli: "MEDMAR Napoli",
  formula_medmar_pozzuoli: "MEDMAR Pozzuoli",
  formula_snav: "SNAV",
  bus_convocazione: "Convocazione Bus",
};

const filterLabels: Record<KpiFilter, string> = {
  all: "Tutti",
  read: "Letti",
  delivered: "Consegnati non letti",
  pending: "In attesa consegna",
  failed: "Falliti",
};

type FilterMode = "info_3d" | "bus_convocazione" | "medmar_convocazione" | "snav_convocazione";
type MedmarStateFilter = "all" | MedmarSendState;
type SnavStateFilter = "all" | SnavSendState;

function todayInRome(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(new Date());
}

// Civil-date day shift on a "YYYY-MM-DD" string — UTC-noon arithmetic so a
// timezone offset can never roll the day over.
function shiftIsoDay(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(base);
}

function statusBadge(row: LogRow) {
  if (row.status_group === "read") return { label: "Letto", className: "bg-emerald-100 text-emerald-700" };
  if (row.status_group === "delivered") return { label: "Consegnato", className: "bg-sky-100 text-sky-700" };
  if (row.status_group === "failed") return { label: "Fallito", className: "bg-rose-100 text-rose-700" };
  return { label: row.status === "queued" ? "In coda" : "In attesa", className: "bg-amber-100 text-amber-700" };
}

function medmarStateBadge(row: MedmarRow) {
  if (row.send_state === "failed") return { label: "Fallito", className: "bg-rose-100 text-rose-700" };
  if (row.send_state === "not_sent") return { label: "Non inviato", className: "bg-slate-100 text-slate-600" };
  if (row.status_group === "read") return { label: "Letto", className: "bg-emerald-100 text-emerald-700" };
  if (row.status_group === "delivered") return { label: "Consegnato", className: "bg-sky-100 text-sky-700" };
  return { label: "Inviato", className: "bg-amber-100 text-amber-700" };
}

function snavStateBadge(row: SnavRow) {
  if (row.send_state === "failed") return { label: "Fallito", className: "bg-rose-100 text-rose-700" };
  if (row.send_state === "not_sent") return { label: "Non inviato", className: "bg-slate-100 text-slate-600" };
  if (row.status_group === "read") return { label: "Letto", className: "bg-emerald-100 text-emerald-700" };
  if (row.status_group === "delivered") return { label: "Consegnato", className: "bg-sky-100 text-sky-700" };
  return { label: "Inviato", className: "bg-amber-100 text-amber-700" };
}

export default function WhatsAppLogPage() {
  const [loading, setLoading] = useState(true);
  const [kpi, setKpi] = useState<KPI | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [days, setDays] = useState(30);
  const [filterMode, setFilterMode] = useState<FilterMode>("info_3d");
  const [kpiFilter, setKpiFilter] = useState<KpiFilter>("all");
  const [error, setError] = useState("");

  // MEDMAR-specific state
  const [medmarDate, setMedmarDate] = useState<string>(todayInRome());
  const [medmarSummary, setMedmarSummary] = useState<MedmarSummary | null>(null);
  const [medmarRows, setMedmarRows] = useState<MedmarRow[]>([]);
  const [medmarStateFilter, setMedmarStateFilter] = useState<MedmarStateFilter>("all");

  // SNAV-specific state
  const [snavDate, setSnavDate] = useState<string>(todayInRome());
  const [snavSummary, setSnavSummary] = useState<SnavSummary | null>(null);
  const [snavRows, setSnavRows] = useState<SnavRow[]>([]);
  const [snavStateFilter, setSnavStateFilter] = useState<SnavStateFilter>("all");

  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const isBusMode = filterMode === "bus_convocazione";
  const isMedmarMode = filterMode === "medmar_convocazione";
  const isSnavMode = filterMode === "snav_convocazione";

  const load = useCallback(async (d: number, mode: Exclude<FilterMode, "medmar_convocazione" | "snav_convocazione">) => {
    setLoading(true);
    setError("");
    if (!supabase) { setError("Sessione non disponibile."); setLoading(false); return; }
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("Non autenticato."); setLoading(false); return; }

    const res = await fetch(`/api/ops/whatsapp-log?days=${d}&filter=${mode}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { ok?: boolean; kpi?: KPI; rows?: LogRow[]; notReadRows?: LogRow[]; error?: string } | null;
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? `Errore caricamento dati (HTTP ${res.status}).`);
      setLoading(false);
      return;
    }
    setKpi(body.kpi ?? null);
    setRows(body.rows ?? body.notReadRows ?? []);
    setLoading(false);
  }, []);

  const loadMedmar = useCallback(async (date: string) => {
    setLoading(true);
    setError("");
    setExpandedRow(null);
    if (!supabase) { setError("Sessione non disponibile."); setLoading(false); return; }
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("Non autenticato."); setLoading(false); return; }

    const res = await fetch(`/api/ops/whatsapp-log?filter=medmar_convocazione&date=${date}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { ok?: boolean; summary?: MedmarSummary; rows?: MedmarRow[]; error?: string } | null;
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? `Errore caricamento dati (HTTP ${res.status}).`);
      setMedmarSummary(null);
      setMedmarRows([]);
      setLoading(false);
      return;
    }
    setMedmarSummary(body.summary ?? null);
    setMedmarRows(body.rows ?? []);
    setLoading(false);
  }, []);

  const loadSnav = useCallback(async (date: string) => {
    setLoading(true);
    setError("");
    setExpandedRow(null);
    if (!supabase) { setError("Sessione non disponibile."); setLoading(false); return; }
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("Non autenticato."); setLoading(false); return; }

    const res = await fetch(`/api/ops/whatsapp-log?filter=snav_convocazione&date=${date}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { ok?: boolean; summary?: SnavSummary; rows?: SnavRow[]; error?: string } | null;
    if (!res.ok || !body?.ok) {
      setError(body?.error ?? `Errore caricamento dati (HTTP ${res.status}).`);
      setSnavSummary(null);
      setSnavRows([]);
      setLoading(false);
      return;
    }
    setSnavSummary(body.summary ?? null);
    setSnavRows(body.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      if (filterMode === "medmar_convocazione") void loadMedmar(medmarDate);
      else if (filterMode === "snav_convocazione") void loadSnav(snavDate);
      else void load(days, filterMode);
    });
    return () => { cancelled = true; };
  }, [days, filterMode, medmarDate, snavDate, load, loadMedmar, loadSnav]);

  const pct = (n: number) => kpi && kpi.total > 0 ? Math.round((n / kpi.total) * 100) : 0;
  const filteredRows = useMemo(() => {
    if (kpiFilter === "all") return rows;
    return rows.filter((row) => row.status_group === kpiFilter);
  }, [kpiFilter, rows]);

  const filteredMedmarRows = useMemo(() => {
    if (medmarStateFilter === "all") return medmarRows;
    return medmarRows.filter((r) => r.send_state === medmarStateFilter);
  }, [medmarStateFilter, medmarRows]);

  const filteredSnavRows = useMemo(() => {
    if (snavStateFilter === "all") return snavRows;
    return snavRows.filter((r) => r.send_state === snavStateFilter);
  }, [snavStateFilter, snavRows]);

  return (
    <section className="page-section">
      <PageHeader
        title={
          isSnavMode
            ? "Log WhatsApp - Convocazioni SNAV"
            : isMedmarMode
              ? "Log WhatsApp - Convocazioni Medmar"
              : isBusMode
                ? "Log WhatsApp - Convocazioni Bus"
                : "Log WhatsApp - Prima di partire"
        }
        subtitle={
          isSnavMode
            ? "Stato di consegna delle convocazioni SNAV della giornata selezionata."
            : isMedmarMode
              ? "Controllo giornaliero degli invii WhatsApp delle convocazioni Medmar, per giorno di partenza."
              : isBusMode
                ? "Stato di consegna delle convocazioni bus inviate da Excel."
                : "Stato di consegna dei messaggi informativi inviati ai clienti."
        }
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "WhatsApp Log" }]}
      />

      <div className="flex flex-wrap gap-2">
        {([
          { key: "info_3d" as FilterMode, label: "Prima di partire" },
          { key: "bus_convocazione" as FilterMode, label: "Convocazioni Bus" },
          { key: "medmar_convocazione" as FilterMode, label: "Medmar" },
          { key: "snav_convocazione" as FilterMode, label: "SNAV" },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => { setFilterMode(key); setKpiFilter("all"); setMedmarStateFilter("all"); setSnavStateFilter("all"); }}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition border ${filterMode === key ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {isMedmarMode ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-sm font-semibold text-slate-600" htmlFor="medmar-date">Giorno di partenza</label>
          <input
            id="medmar-date"
            type="date"
            value={medmarDate}
            onChange={(e) => setMedmarDate(e.target.value || todayInRome())}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 focus:border-indigo-300 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => setMedmarDate(todayInRome())}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:border-indigo-300"
          >
            Oggi
          </button>
        </div>
      ) : isSnavMode ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-sm font-semibold text-slate-600" htmlFor="snav-date">Giorno di partenza</label>
          <button
            type="button"
            aria-label="Giorno precedente"
            onClick={() => setSnavDate((d) => shiftIsoDay(d, -1))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:border-indigo-300"
          >
            ← giorno precedente
          </button>
          <input
            id="snav-date"
            type="date"
            value={snavDate}
            onChange={(e) => setSnavDate(e.target.value || todayInRome())}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 focus:border-indigo-300 focus:outline-none"
          />
          <button
            type="button"
            aria-label="Giorno successivo"
            onClick={() => setSnavDate((d) => shiftIsoDay(d, 1))}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:border-indigo-300"
          >
            giorno successivo →
          </button>
          <button
            type="button"
            onClick={() => setSnavDate(todayInRome())}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-600 transition hover:border-indigo-300"
          >
            Oggi
          </button>
        </div>
      ) : (
        <div className="flex gap-2 mt-2">
          {[7, 14, 30, 60].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition border ${days === d ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-slate-600 border-slate-200 hover:border-indigo-300"}`}
            >
              Ultimi {d}g
            </button>
          ))}
        </div>
      )}

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* ── MEDMAR daily view ─────────────────────────────────────────── */}
      {isMedmarMode && medmarSummary && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { key: "all" as MedmarStateFilter, selectable: false, label: "Righe del giorno", value: medmarSummary.total, color: "#4338ca", bg: "#eef2ff" },
              { key: "sent" as MedmarStateFilter, selectable: true, label: "Inviati", value: medmarSummary.sent, color: "#0f766e", bg: "#f0fdfa" },
              { key: "failed" as MedmarStateFilter, selectable: true, label: "Falliti", value: medmarSummary.failed, color: medmarSummary.failed > 0 ? "#dc2626" : "#64748b", bg: medmarSummary.failed > 0 ? "#fef2f2" : "#f8fafc" },
              { key: "not_sent" as MedmarStateFilter, selectable: true, label: "Non inviati", value: medmarSummary.notSent, color: medmarSummary.notSent > 0 ? "#b45309" : "#64748b", bg: medmarSummary.notSent > 0 ? "#fffbeb" : "#f8fafc" },
              { key: "all" as MedmarStateFilter, selectable: false, label: "% successo", value: `${medmarSummary.successRate}%`, color: "#4338ca", bg: "#eef2ff" },
            ].map(({ key, selectable, label, value, color, bg }, i) => (
              <button
                key={`${label}-${i}`}
                type="button"
                onClick={() => selectable && setMedmarStateFilter(key)}
                className={`rounded-2xl border p-4 text-left shadow-sm transition focus:outline-none ${selectable ? "hover:-translate-y-0.5 hover:shadow-md focus:ring-2 focus:ring-indigo-200 cursor-pointer" : "cursor-default"} ${selectable && medmarStateFilter === key ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-100"}`}
                style={{ backgroundColor: bg }}
              >
                <p className="text-3xl font-extrabold" style={{ color }}>{value}</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
              </button>
            ))}
          </div>

          <p className="text-xs text-slate-400">
            Consegnati: {medmarSummary.delivered} · Letti: {medmarSummary.read} — dati di consegna disponibili solo dopo i webhook Meta.
          </p>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">
              Filtro: {medmarStateFilter === "all" ? "Tutti" : medmarStateFilter === "sent" ? "Inviati" : medmarStateFilter === "failed" ? "Falliti" : "Non inviati"}
            </span>
            {medmarStateFilter !== "all" && (
              <button type="button" onClick={() => setMedmarStateFilter("all")} className="font-semibold text-indigo-600 hover:text-indigo-700">
                Mostra tutti
              </button>
            )}
          </div>

          {filteredMedmarRows.length > 0 ? (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">{filteredMedmarRows.length} righe visualizzate</p>
              <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Cliente</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Telefono</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Stato</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Template</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Errore</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Orario invio</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Operatore / File</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredMedmarRows.map((r) => {
                      const badge = medmarStateBadge(r);
                      const open = expandedRow === r.row_id;
                      return (
                        <Fragment key={r.row_id}>
                          <tr className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 font-medium text-slate-800">
                              {r.customer_name || "-"}
                              <span className="block text-[11px] text-slate-400">{[r.route, r.departure_time, r.passengers ? `${r.passengers} pax` : ""].filter(Boolean).join(" · ")}</span>
                            </td>
                            <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{r.to_phone}</td>
                            <td className="px-4 py-2.5">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.className}`}>{badge.label}</span>
                              {r.attempt_number != null && r.attempt_number > 1 && (
                                <span className="ml-1 text-[10px] text-slate-400">#{r.attempt_number}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">{r.template ?? "-"}{r.language_code ? ` (${r.language_code})` : ""}</td>
                            <td className="px-4 py-2.5 text-xs">
                              {r.send_state === "failed"
                                ? <span className="text-rose-600 font-semibold">{r.error_code ? `#${r.error_code}` : "Errore"}</span>
                                : <span className="text-slate-300">-</span>}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-400">
                              {r.happened_at ? new Date(r.happened_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-500">
                              {r.operator_name ?? "-"}
                              <span className="block text-[11px] text-slate-400">{r.batch_label || r.file_name || "-"}</span>
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => setExpandedRow(open ? null : r.row_id)}
                                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                              >
                                {open ? "Chiudi" : "Dettaglio"}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-slate-50/60">
                              <td colSpan={8} className="px-4 py-3">
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Parametri inviati</p>
                                    {r.params.length > 0 ? (
                                      <ul className="space-y-0.5 text-xs text-slate-600">
                                        {r.params.map((p, idx) => (
                                          <li key={idx}>
                                            <span className="text-slate-400">{MEDMAR_PARAM_LABELS[idx] ?? `{{${idx + 1}}}`}:</span>{" "}
                                            <span className="font-mono">{p || "—"}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <p className="text-xs text-slate-400">Nessun parametro registrato (riga non ancora inviata).</p>
                                    )}
                                    <p className="mt-2 text-[11px] text-slate-400">
                                      Data partenza: {r.travel_date || r.travel_date_iso || "-"}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Errore Meta / WhatsApp</p>
                                    {r.send_state === "failed" ? (
                                      <>
                                        {r.error_code && <p className="text-xs text-rose-600 font-semibold">Codice: {r.error_code}</p>}
                                        <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">{r.error_message || "Errore non specificato."}</p>
                                        {r.error_raw != null && (
                                          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">
                                            {JSON.stringify(r.error_raw, null, 2)}
                                          </pre>
                                        )}
                                      </>
                                    ) : (
                                      <p className="text-xs text-slate-400">Nessun errore.</p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-400">
              Nessuna riga Medmar per il giorno selezionato.
            </div>
          )}
        </>
      )}

      {/* ── SNAV daily view ──────────────────────────────────────────── */}
      {isSnavMode && snavSummary && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { key: "sent" as SnavStateFilter, selectable: true, label: "Inviati", value: snavSummary.sent, color: "#0f766e", bg: "#f0fdfa" },
              { key: "all" as SnavStateFilter, selectable: false, label: "Letti", value: snavSummary.read, color: "#0f766e", bg: "#f0fdfa" },
              { key: "all" as SnavStateFilter, selectable: false, label: "Consegnati non letti", value: snavSummary.delivered, color: "#0369a1", bg: "#f0f9ff" },
              { key: "all" as SnavStateFilter, selectable: false, label: "In attesa consegna", value: snavSummary.pending, color: snavSummary.pending > 0 ? "#b45309" : "#64748b", bg: snavSummary.pending > 0 ? "#fffbeb" : "#f8fafc" },
              { key: "failed" as SnavStateFilter, selectable: true, label: "Falliti", value: snavSummary.failed, color: snavSummary.failed > 0 ? "#dc2626" : "#64748b", bg: snavSummary.failed > 0 ? "#fef2f2" : "#f8fafc" },
            ].map(({ key, selectable, label, value, color, bg }, i) => (
              <button
                key={`${label}-${i}`}
                type="button"
                onClick={() => selectable && setSnavStateFilter(key)}
                className={`rounded-2xl border p-4 text-left shadow-sm transition focus:outline-none ${selectable ? "hover:-translate-y-0.5 hover:shadow-md focus:ring-2 focus:ring-indigo-200 cursor-pointer" : "cursor-default"} ${selectable && snavStateFilter === key ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-100"}`}
                style={{ backgroundColor: bg }}
              >
                <p className="text-3xl font-extrabold" style={{ color }}>{value}</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
              </button>
            ))}
          </div>

          <div className="rounded-xl border border-slate-100 bg-white p-4">
            <p className="mb-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasso di lettura</p>
            <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${snavSummary.readRate}%` }} />
            </div>
            <p className="mt-1 text-xs text-slate-400">{snavSummary.readRate}% letti su {snavSummary.sent} inviati</p>
          </div>

          <div className={`rounded-xl border p-4 ${snavSummary.missing > 0 ? "border-amber-200 bg-amber-50" : "border-slate-100 bg-white"}`}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="font-semibold text-slate-700">Convocazioni previste: {snavSummary.expected}</span>
              <span className="font-semibold text-slate-700">WhatsApp inviate: {snavSummary.sent}</span>
              {snavSummary.missing > 0 ? (
                <span className="font-bold text-amber-700">
                  {snavSummary.missing} {snavSummary.missing === 1 ? "convocazione non inviata" : "convocazioni non inviate"}
                </span>
              ) : (
                <span className="font-semibold text-emerald-700">Tutte le convocazioni previste sono state inviate</span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">
              Filtro: {snavStateFilter === "all" ? "Tutti" : snavStateFilter === "sent" ? "Inviati" : snavStateFilter === "failed" ? "Falliti" : "Non inviati"}
            </span>
            {snavStateFilter !== "all" && (
              <button type="button" onClick={() => setSnavStateFilter("all")} className="font-semibold text-indigo-600 hover:text-indigo-700">
                Mostra tutti
              </button>
            )}
          </div>

          {filteredSnavRows.length > 0 ? (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">{filteredSnavRows.length} righe visualizzate</p>
              <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Cliente</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Hotel</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Pax</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Data partenza</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Prelevamento</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Aliscafo</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Telefono</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Stato</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Inviato</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredSnavRows.map((r) => {
                      const badge = snavStateBadge(r);
                      const open = expandedRow === r.row_id;
                      return (
                        <Fragment key={r.row_id}>
                          <tr className="hover:bg-slate-50">
                            <td className="px-4 py-2.5 font-medium text-slate-800">{r.customer_name || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{r.hotel || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{r.passengers || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{r.departure_date_label || r.departure_date || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{r.pickup_time || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-600">{r.vessel_time || "-"}</td>
                            <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{r.to_phone}</td>
                            <td className="px-4 py-2.5">
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.className}`}>{badge.label}</span>
                              {r.attempt_number != null && r.attempt_number > 1 && (
                                <span className="ml-1 text-[10px] text-slate-400">#{r.attempt_number}</span>
                              )}
                              {r.send_state === "failed" && r.error_code && (
                                <span className="ml-1 text-[10px] text-rose-600 font-semibold">#{r.error_code}</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-xs text-slate-400">
                              {r.happened_at ? new Date(r.happened_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}
                            </td>
                            <td className="px-4 py-2.5 text-right">
                              <button
                                type="button"
                                onClick={() => setExpandedRow(open ? null : r.row_id)}
                                className="text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                              >
                                {open ? "Chiudi" : "Dettaglio"}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr className="bg-slate-50/60">
                              <td colSpan={10} className="px-4 py-3">
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Parametri inviati</p>
                                    {r.params.length > 0 ? (
                                      <ul className="space-y-0.5 text-xs text-slate-600">
                                        {r.params.map((p, idx) => (
                                          <li key={idx}>
                                            <span className="text-slate-400">{SNAV_PARAM_LABELS[idx] ?? `{{${idx + 1}}}`}:</span>{" "}
                                            <span className="font-mono">{p || "—"}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    ) : (
                                      <p className="text-xs text-slate-400">Nessun parametro registrato (riga non ancora inviata).</p>
                                    )}
                                    <p className="mt-2 text-[11px] text-slate-400">
                                      Template: {r.template ?? "-"}{r.language_code ? ` (${r.language_code})` : ""} · Operatore: {r.operator_name ?? "-"} · File: {r.batch_label || r.file_name || "-"}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="mb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide">Errore Meta / WhatsApp</p>
                                    {r.send_state === "failed" ? (
                                      <>
                                        {r.error_code && <p className="text-xs text-rose-600 font-semibold">Codice: {r.error_code}</p>}
                                        <p className="text-xs text-slate-600 whitespace-pre-wrap break-words">{r.error_message || "Errore non specificato."}</p>
                                        {r.error_raw != null && (
                                          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-slate-900 p-2 text-[11px] text-slate-100">
                                            {JSON.stringify(r.error_raw, null, 2)}
                                          </pre>
                                        )}
                                      </>
                                    ) : (
                                      <p className="text-xs text-slate-400">Nessun errore.</p>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-400">
              Nessuna convocazione SNAV per il giorno selezionato.
            </div>
          )}
        </>
      )}

      {/* ── Standard views (info_3d / bus_convocazione) ───────────────── */}
      {!isMedmarMode && !isSnavMode && kpi && !loading && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { key: "all" as KpiFilter, label: "Inviati", value: kpi.total, color: "#4338ca", bg: "#eef2ff" },
              { key: "read" as KpiFilter, label: "Letti", value: kpi.read, color: "#0f766e", bg: "#f0fdfa", extra: `${pct(kpi.read)}%` },
              { key: "delivered" as KpiFilter, label: "Consegnati non letti", value: kpi.delivered, color: "#0369a1", bg: "#f0f9ff", extra: `${pct(kpi.delivered)}%` },
              { key: "pending" as KpiFilter, label: "In attesa consegna", value: kpi.pending, color: kpi.pending > 0 ? "#b45309" : "#64748b", bg: kpi.pending > 0 ? "#fffbeb" : "#f8fafc", extra: `${pct(kpi.pending)}%` },
              { key: "failed" as KpiFilter, label: "Falliti", value: kpi.failed, color: kpi.failed > 0 ? "#dc2626" : "#64748b", bg: kpi.failed > 0 ? "#fef2f2" : "#f8fafc" },
            ].map(({ key, label, value, color, bg, extra }) => (
              <button
                key={key}
                type="button"
                onClick={() => setKpiFilter(key)}
                className={`rounded-2xl border p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-200 ${kpiFilter === key ? "border-indigo-300 ring-2 ring-indigo-100" : "border-slate-100"}`}
                style={{ backgroundColor: bg }}
              >
                <p className="text-3xl font-extrabold" style={{ color }}>{value}</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
                {extra && <p className="text-xs text-slate-400">{extra} del totale</p>}
              </button>
            ))}
          </div>

          {kpi.total > 0 && (
            <div className="rounded-xl border border-slate-100 bg-white p-4">
              <p className="mb-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasso di lettura</p>
              <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct(kpi.read)}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-400">{pct(kpi.read)}% letti su {kpi.total} inviati</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-semibold text-slate-700">Filtro attivo: {filterLabels[kpiFilter]}</span>
            {kpiFilter !== "all" && (
              <button type="button" onClick={() => setKpiFilter("all")} className="font-semibold text-indigo-600 hover:text-indigo-700">
                Mostra tutti
              </button>
            )}
          </div>

          {filteredRows.length > 0 ? (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">
                {filteredRows.length} messaggi visualizzati
              </p>
              <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Cliente</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">{isBusMode ? "Data partenza" : "Arrivo"}</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Tipo</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Telefono</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Stato</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Inviato</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredRows.map((r, i) => {
                      const badge = statusBadge(r);
                      return (
                        <tr key={r.service_id ?? `${r.to_phone}-${i}`} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5 font-medium text-slate-800">{r.customer_name ?? "-"}</td>
                          <td className="px-4 py-2.5 text-slate-600">{r.arrival_date ?? "-"}</td>
                          <td className="px-4 py-2.5 text-slate-500 text-xs">{kindLabel[r.booking_service_kind ?? ""] ?? r.booking_service_kind ?? "-"}</td>
                          <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{r.to_phone}</td>
                          <td className="px-4 py-2.5">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${badge.className}`}>
                              {badge.label}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-400">
                            {new Date(r.happened_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-400">
              Nessun messaggio per il filtro selezionato.
            </div>
          )}
        </>
      )}
    </section>
  );
}
