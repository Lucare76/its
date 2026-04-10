"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

type ServiceSnapshot = {
  service_id?: string;
  date: string;
  time: string;
  customer_name: string;
  pax: number;
  hotel_or_destination: string | null;
  direction: "arrival" | "departure";
};

type Modification = {
  service_id: string;
  field: string;
  original: string;
  modified: string;
};

type ReviewSession = {
  id: string;
  agency_name: string;
  report_type: string;
  target_date: string;
  status: "pending" | "approved" | "modified" | "applied";
  modifications: Modification[] | null;
  agency_notes: string | null;
  reviewed_at: string | null;
  created_at: string;
  services: ServiceSnapshot[];
};

const REPORT_LABELS: Record<string, string> = {
  arrivals_48h:   "Arrivi +48h",
  departures_48h: "Partenze +48h",
  bus_monday:     "Linea bus domenica",
  reminder_48h:   "Promemoria 48h",
  reminder_24h:   "Promemoria 24h",
};

const FIELD_LABELS: Record<string, string> = {
  date:                 "Data",
  time:                 "Orario",
  pax:                  "Pax",
  hotel_or_destination: "Hotel / Destinazione",
  direction:            "Direzione",
};

const STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  pending:  { label: "In attesa",  bg: "#fef9c3", color: "#854d0e" },
  approved: { label: "Approvato",  bg: "#dcfce7", color: "#166534" },
  modified: { label: "Modificato", bg: "#fee2e2", color: "#991b1b" },
  applied:  { label: "Applicato",  bg: "#dbeafe", color: "#1e40af" },
};

export default function AgencyReviewsPage() {
  const [sessions, setSessions]   = useState<ReviewSession[]>([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState<"all" | "modified" | "approved" | "applied">("all");
  const [searchAgency, setSearchAgency] = useState("");
  const [dateFrom, setDateFrom]   = useState("");
  const [dateTo, setDateTo]       = useState("");
  const [expanded, setExpanded]   = useState<string | null>(null);
  const [applying, setApplying]   = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  async function load() {
    setLoading(true);
    const { data: { session } } = await supabase!.auth.getSession();
    const token = session?.access_token;
    if (!token) { setLoading(false); return; }
    const res = await fetch(`/api/admin/agency-reviews?status=${filter}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    setSessions(json.sessions ?? []);
    setLoading(false);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function applyModifications(sessionId: string) {
    setApplying(sessionId);
    const { data: { session } } = await supabase!.auth.getSession();
    const token = session?.access_token;
    const res = await fetch(`/api/admin/agency-reviews/${sessionId}/apply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    if (json.ok) {
      setApplyResult((prev) => ({ ...prev, [sessionId]: { ok: true, msg: `${json.applied} servizi aggiornati.${json.skipped_fields?.length ? ` Campi non applicati: ${json.skipped_fields.join(", ")}.` : ""}` } }));
      // Aggiorna status localmente
      setSessions((prev) => prev.map((s) => s.id === sessionId ? { ...s, status: "applied" } : s));
    } else {
      setApplyResult((prev) => ({ ...prev, [sessionId]: { ok: false, msg: json.error ?? "Errore." } }));
    }
    setApplying(null);
  }

  const filtered = sessions.filter((s) => {
    if (filter !== "all" && s.status !== filter) return false;
    if (searchAgency && !s.agency_name.toLowerCase().includes(searchAgency.toLowerCase())) return false;
    if (dateFrom && s.target_date < dateFrom) return false;
    if (dateTo && s.target_date > dateTo) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-50 p-6">
      <div className="max-w-4xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Revisioni agenzie</h1>
          <p className="text-sm text-slate-500">Risposte delle agenzie ai riepilogi inviati</p>
        </div>

        {/* Filtri status */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {(["all", "modified", "approved", "applied"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-1.5 rounded-full text-sm font-semibold border transition-colors ${
                filter === f
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
              }`}
            >
              {f === "all" ? "Tutti" : f === "modified" ? "✏️ Modificati" : f === "approved" ? "✅ Approvati" : "✔ Applicati"}
            </button>
          ))}
        </div>

        {/* Filtri ricerca */}
        <div className="flex gap-3 mb-5 flex-wrap">
          <input
            type="text"
            value={searchAgency}
            onChange={(e) => setSearchAgency(e.target.value)}
            placeholder="Cerca agenzia..."
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
            title="Data da"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-300"
            title="Data a"
          />
          {(searchAgency || dateFrom || dateTo) && (
            <button
              onClick={() => { setSearchAgency(""); setDateFrom(""); setDateTo(""); }}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"
            >
              ✕ Reset
            </button>
          )}
          <span className="ml-auto text-xs text-slate-400 self-center">{filtered.length} risultati</span>
        </div>

        {/* Lista */}
        {loading ? (
          <div className="text-sm text-slate-500 py-12 text-center">Caricamento...</div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400 text-sm">
            Nessuna sessione trovata.
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {filtered.map((s) => {
              const badge = STATUS_BADGE[s.status] ?? STATUS_BADGE.pending;
              const isExpanded = expanded === s.id;
              const hasModifications = s.status === "modified" || s.status === "applied";
              const result = applyResult[s.id];

              return (
                <div key={s.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm">
                  {/* Row header */}
                  <div
                    className="flex items-center gap-4 p-5 cursor-pointer hover:bg-slate-50 transition-colors"
                    onClick={() => setExpanded(isExpanded ? null : s.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="text-base font-bold text-slate-900">{s.agency_name}</span>
                        <span style={{ background: badge.bg, color: badge.color }} className="text-xs font-bold px-2.5 py-1 rounded-full">
                          {badge.label}
                        </span>
                      </div>
                      <div className="text-sm text-slate-500">
                        {REPORT_LABELS[s.report_type] ?? s.report_type} · {s.target_date}
                        {s.modifications?.length ? ` · ${s.modifications.length} modifiche` : ""}
                        {s.reviewed_at ? ` · Risposto il ${new Date(s.reviewed_at).toLocaleDateString("it-IT")}` : ""}
                      </div>
                    </div>
                    <div className="text-slate-400 text-lg select-none">{isExpanded ? "▲" : "▼"}</div>
                  </div>

                  {/* Dettaglio espandibile */}
                  {isExpanded && (
                    <div className="border-t border-slate-100 p-5">

                      {/* Nota agenzia */}
                      {s.agency_notes && (
                        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-5 text-sm text-amber-900">
                          <span className="font-bold">Nota agenzia: </span>{s.agency_notes}
                        </div>
                      )}

                      {hasModifications && s.modifications && s.modifications.length > 0 ? (
                        <>
                          {/* Diff table */}
                          <div className="mb-5">
                            <div className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Modifiche richieste</div>
                            <div className="rounded-xl overflow-hidden border border-slate-200">
                              <table className="w-full text-sm border-collapse">
                                <thead>
                                  <tr className="bg-slate-800 text-white text-xs">
                                    <th className="px-4 py-3 text-left font-semibold">Cliente</th>
                                    <th className="px-4 py-3 text-left font-semibold">Campo</th>
                                    <th className="px-4 py-3 text-left font-semibold">Originale</th>
                                    <th className="px-4 py-3 text-left font-semibold text-amber-300">Modificato</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {s.modifications.map((mod, i) => {
                                    const service = s.services.find((sv) => sv.service_id === mod.service_id || sv.customer_name === mod.service_id);
                                    return (
                                      <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                                        <td className="px-4 py-3 text-slate-600 font-medium">{service?.customer_name ?? mod.service_id}</td>
                                        <td className="px-4 py-3 text-slate-500">{FIELD_LABELS[mod.field] ?? mod.field}</td>
                                        <td className="px-4 py-3 text-slate-400 line-through">{mod.original}</td>
                                        <td className="px-4 py-3 font-bold text-amber-800 bg-yellow-50">{mod.modified} ✏️</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>

                          {/* Risultato apply */}
                          {result && (
                            <div className={`rounded-lg px-4 py-3 mb-4 text-sm font-medium ${result.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"}`}>
                              {result.ok ? "✅ " : "❌ "}{result.msg}
                            </div>
                          )}

                          {/* Bottone applica */}
                          {s.status === "modified" && !result?.ok && (
                            <button
                              onClick={() => applyModifications(s.id)}
                              disabled={applying === s.id}
                              className="bg-slate-900 text-white px-6 py-2.5 rounded-lg text-sm font-bold hover:bg-slate-800 disabled:opacity-60 transition-colors"
                            >
                              {applying === s.id ? "Applicazione..." : "⚡ Applica modifiche ai servizi"}
                            </button>
                          )}
                          {s.status === "applied" && !result && (
                            <div className="text-sm text-blue-700 font-semibold">✔ Modifiche già applicate</div>
                          )}
                        </>
                      ) : (
                        <div className="text-sm text-slate-500">
                          {s.status === "approved" ? "✅ L'agenzia ha approvato il riepilogo senza modifiche." : "Nessuna modifica disponibile."}
                        </div>
                      )}

                      {/* Anteprima servizi */}
                      <details className="mt-5">
                        <summary className="text-xs font-bold text-slate-400 uppercase tracking-wider cursor-pointer hover:text-slate-600 mb-2">
                          Servizi nel riepilogo ({s.services.length})
                        </summary>
                        <div className="rounded-xl overflow-hidden border border-slate-100 mt-2">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="bg-slate-100 text-slate-500">
                                {["Data", "Ora", "Dir.", "Cliente", "Hotel/Dest.", "Pax"].map((h) => (
                                  <th key={h} className="px-3 py-2 text-left font-semibold">{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {s.services.map((sv, j) => (
                                <tr key={j} className={j % 2 === 0 ? "bg-white" : "bg-slate-50"}>
                                  <td className="px-3 py-2 text-slate-500">{sv.date}</td>
                                  <td className="px-3 py-2 font-semibold text-slate-800">{sv.time}</td>
                                  <td className="px-3 py-2">
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${sv.direction === "arrival" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                                      {sv.direction === "arrival" ? "▼" : "▲"}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 font-semibold text-slate-800">{sv.customer_name}</td>
                                  <td className="px-3 py-2 text-slate-500">{sv.hotel_or_destination ?? "—"}</td>
                                  <td className="px-3 py-2 font-bold text-slate-700 text-center">{sv.pax}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
