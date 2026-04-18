"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { supabase } from "@/lib/supabase/client";

type KPI = { total: number; read: number; delivered: number; sent: number; failed: number; notRead: number };
type NotReadRow = {
  service_id: string | null;
  to_phone: string;
  template: string | null;
  status: string;
  happened_at: string;
  customer_name: string | null;
  arrival_date: string | null;
  booking_service_kind: string | null;
};

const kindLabel: Record<string, string> = {
  transfer_airport_hotel: "Aeroporto",
  transfer_train_hotel:   "Stazione",
  formula_medmar_napoli:  "MEDMAR Napoli",
  formula_medmar_pozzuoli:"MEDMAR Pozzuoli",
  formula_snav:           "SNAV",
};

export default function WhatsAppLogPage() {
  const [loading, setLoading] = useState(true);
  const [kpi, setKpi]         = useState<KPI | null>(null);
  const [rows, setRows]       = useState<NotReadRow[]>([]);
  const [days, setDays]       = useState(30);
  const [error, setError]     = useState("");

  const load = async (d: number) => {
    setLoading(true);
    setError("");
    if (!supabase) { setError("Sessione non disponibile."); setLoading(false); return; }
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    if (!token) { setError("Non autenticato."); setLoading(false); return; }

    const res  = await fetch(`/api/ops/whatsapp-log?days=${d}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { ok?: boolean; kpi?: KPI; notReadRows?: NotReadRow[] } | null;
    if (!res.ok || !body?.ok) { setError("Errore caricamento dati."); setLoading(false); return; }
    setKpi(body.kpi ?? null);
    setRows(body.notReadRows ?? []);
    setLoading(false);
  };

  useEffect(() => { void load(days); }, [days]);

  const pct = (n: number) => kpi && kpi.total > 0 ? Math.round((n / kpi.total) * 100) : 0;

  return (
    <section className="page-section">
      <PageHeader
        title="Log WhatsApp — Prima di partire"
        subtitle="Stato di consegna dei messaggi informativi inviati ai clienti."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "WhatsApp Log" }]}
      />

      {/* Filtro giorni */}
      <div className="flex gap-2">
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

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error   && <p className="text-sm text-red-600">{error}</p>}

      {kpi && !loading && (
        <>
          {/* KPI */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: "Inviati",     value: kpi.total,     color: "#4338ca", bg: "#eef2ff" },
              { label: "Letti",       value: kpi.read,      color: "#0f766e", bg: "#f0fdfa", extra: `${pct(kpi.read)}%` },
              { label: "Consegnati",  value: kpi.delivered, color: "#0369a1", bg: "#f0f9ff", extra: `${pct(kpi.delivered)}%` },
              { label: "Non letti",   value: kpi.notRead,   color: kpi.notRead > 0 ? "#b45309" : "#64748b", bg: kpi.notRead > 0 ? "#fffbeb" : "#f8fafc", extra: `${pct(kpi.notRead)}%` },
              { label: "Falliti",     value: kpi.failed,    color: kpi.failed > 0 ? "#dc2626" : "#64748b", bg: kpi.failed > 0 ? "#fef2f2" : "#f8fafc" },
            ].map(({ label, value, color, bg, extra }) => (
              <div key={label} className="rounded-2xl border border-slate-100 p-4 shadow-sm" style={{ backgroundColor: bg }}>
                <p className="text-3xl font-extrabold" style={{ color }}>{value}</p>
                <p className="mt-0.5 text-sm font-semibold text-slate-600">{label}</p>
                {extra && <p className="text-xs text-slate-400">{extra} del totale</p>}
              </div>
            ))}
          </div>

          {/* Barra lettura */}
          {kpi.total > 0 && (
            <div className="rounded-xl border border-slate-100 bg-white p-4">
              <p className="mb-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Tasso di lettura</p>
              <div className="h-3 w-full rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct(kpi.read)}%` }} />
              </div>
              <p className="mt-1 text-xs text-slate-400">{pct(kpi.read)}% letti su {kpi.total} inviati</p>
            </div>
          )}

          {/* Tabella non letti */}
          {rows.length > 0 ? (
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">
                {rows.length} messaggi non ancora letti
              </p>
              <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 border-b border-slate-100">
                    <tr>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Cliente</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Arrivo</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Tipo</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Telefono</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Stato</th>
                      <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wide">Inviato</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {rows.map((r, i) => (
                      <tr key={r.service_id ?? i} className="hover:bg-slate-50">
                        <td className="px-4 py-2.5 font-medium text-slate-800">{r.customer_name ?? "—"}</td>
                        <td className="px-4 py-2.5 text-slate-600">{r.arrival_date ?? "—"}</td>
                        <td className="px-4 py-2.5 text-slate-500 text-xs">{kindLabel[r.booking_service_kind ?? ""] ?? r.booking_service_kind ?? "—"}</td>
                        <td className="px-4 py-2.5 text-slate-500 font-mono text-xs">{r.to_phone}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${r.status === "delivered" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700"}`}>
                            {r.status === "delivered" ? "Consegnato" : "Inviato"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-xs text-slate-400">
                          {new Date(r.happened_at).toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-100 bg-white p-8 text-center text-sm text-slate-400">
              Tutti i messaggi risultano letti.
            </div>
          )}
        </>
      )}
    </section>
  );
}
