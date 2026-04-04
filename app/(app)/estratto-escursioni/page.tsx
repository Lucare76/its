"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { AgencyStatement, EscursioneBooking } from "@/app/api/ops/estratto-escursioni/route";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtEur(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2 }) + " €";
}

function firstDayOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── PDF stampa ────────────────────────────────────────────────────────────────

function printStatements(statements: AgencyStatement[], from: string, to: string) {
  const rows = statements.map((st) => {
    const bkRows = st.bookings.map((b: EscursioneBooking) => `
      <tr>
        <td>${fmtDate(b.date)}</td>
        <td>${b.line_name}</td>
        <td>${b.customer_name}${b.hotel_name ? `<br><small style="color:#64748b">${b.hotel_name}</small>` : ""}</td>
        <td style="text-align:center">${b.pax}</td>
        <td style="text-align:right">${fmtEur(b.price_agency_cents)}</td>
        <td style="text-align:right"><strong>${fmtEur(b.total_agency_cents)}</strong></td>
      </tr>`).join("");
    return `
      <div style="margin-bottom:28px;break-inside:avoid">
        <div style="background:#1e293b;color:white;padding:8px 14px;border-radius:6px 6px 0 0;display:flex;justify-content:space-between">
          <strong>${st.agency_name}</strong>
          <span style="font-size:12px;opacity:.8">${st.total_pax} pax · ${fmtEur(st.total_agency_cents)}</span>
        </div>
        <table width="100%" style="border-collapse:collapse;font-size:12px;border:1px solid #e2e8f0;border-top:none">
          <thead>
            <tr style="background:#f8fafc;color:#64748b;font-size:10px;text-transform:uppercase">
              <th style="padding:5px 8px;text-align:left">Data</th>
              <th style="padding:5px 8px;text-align:left">Escursione</th>
              <th style="padding:5px 8px;text-align:left">Cliente / Hotel</th>
              <th style="padding:5px 8px;text-align:center">Pax</th>
              <th style="padding:5px 8px;text-align:right">€/pax</th>
              <th style="padding:5px 8px;text-align:right">Totale</th>
            </tr>
          </thead>
          <tbody>${bkRows}</tbody>
        </table>
      </div>`;
  }).join("");

  const grandTotal = statements.reduce((s, st) => s + st.total_agency_cents, 0);
  const grandPax = statements.reduce((s, st) => s + st.total_pax, 0);

  const html = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
    <title>Estratto Escursioni</title>
    <style>
      body { font-family: -apple-system,Arial,sans-serif; margin:0; padding:20px; color:#0f172a }
      table td, table th { border-bottom:1px solid #e2e8f0; padding:5px 8px }
      @media print { body { padding:10px } }
    </style></head><body>
    <div style="margin-bottom:20px">
      <p style="margin:0;font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.1em">Ischia Transfer Service</p>
      <h1 style="margin:4px 0;font-size:20px">Estratto Escursioni — ${fmtDate(from)} / ${fmtDate(to)}</h1>
      <p style="margin:4px 0;font-size:13px;color:#475569">${grandPax} pax totali · ${fmtEur(grandTotal)}</p>
    </div>
    ${rows || "<p style='color:#94a3b8'>Nessuna prenotazione nel periodo.</p>"}
  </body></html>`;

  const win = window.open("", "_blank", "width=900,height=700");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

// ── Pagina ────────────────────────────────────────────────────────────────────

export default function EstrattoCursioniPage() {
  const [from, setFrom] = useState(firstDayOfMonth);
  const [to, setTo] = useState(today);
  const [agencyFilter, setAgencyFilter] = useState("");
  const [statements, setStatements] = useState<AgencyStatement[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    setLoading(true);
    const params = new URLSearchParams({ from, to });
    if (agencyFilter) params.set("agency", agencyFilter);
    const res = await fetch(`/api/ops/estratto-escursioni?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      setStatements(body.statements ?? []);
      // Espandi tutto di default
      setExpanded(new Set((body.statements ?? []).map((s: AgencyStatement) => s.agency_name)));
    }
    setLoading(false);
  }, [from, to, agencyFilter]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const grandTotal = statements.reduce((s, st) => s + st.total_agency_cents, 0);
  const grandPax = statements.reduce((s, st) => s + st.total_pax, 0);

  function toggleExpand(agency: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(agency)) next.delete(agency); else next.add(agency);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Estratto Escursioni" subtitle="Prenotazioni per agenzia con totali" />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-2">
          <label className="text-xs font-medium text-slate-500">Dal</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm" />
          <label className="text-xs font-medium text-slate-500">Al</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm" />
        </div>
        <input
          value={agencyFilter}
          onChange={(e) => setAgencyFilter(e.target.value)}
          placeholder="Filtra per agenzia..."
          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm w-48" />
        <button onClick={load} disabled={loading}
          className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40">
          {loading ? "..." : "Aggiorna"}
        </button>

        {statements.length > 0 && (
          <>
            <div className="ml-auto flex items-center gap-4">
              <span className="text-sm font-semibold text-slate-700">
                {grandPax} pax · <span className="text-indigo-600">{fmtEur(grandTotal)}</span>
              </span>
              <button
                onClick={() => printStatements(statements, from, to)}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                🖨️ Stampa PDF
              </button>
            </div>
          </>
        )}
      </div>

      {/* Contenuto */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {loading && <p className="text-sm text-slate-400">Caricamento...</p>}
        {!loading && statements.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-slate-400">
            <p className="text-lg">Nessuna prenotazione nel periodo selezionato.</p>
          </div>
        )}

        {statements.map((st) => {
          const open = expanded.has(st.agency_name);
          return (
            <div key={st.agency_name} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              {/* Header agenzia */}
              <button
                onClick={() => toggleExpand(st.agency_name)}
                className="flex w-full items-center gap-3 border-b border-slate-100 bg-slate-50 px-4 py-3 text-left hover:bg-slate-100">
                <span className="text-lg">🏢</span>
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-slate-900">{st.agency_name}</p>
                  <p className="text-xs text-slate-500">{st.bookings.length} prenotazioni · {st.total_pax} pax</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold text-indigo-600">{fmtEur(st.total_agency_cents)}</p>
                  <p className="text-[11px] text-slate-400">netto agenzia</p>
                </div>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8"
                  className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ml-2 ${open ? "rotate-90" : ""}`}>
                  <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>

              {/* Righe prenotazioni */}
              {open && (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        <th className="px-4 py-2 text-left">Data</th>
                        <th className="px-4 py-2 text-left">Escursione</th>
                        <th className="px-4 py-2 text-left">Cliente</th>
                        <th className="px-4 py-2 text-left">Hotel</th>
                        <th className="px-4 py-2 text-center">Pax</th>
                        <th className="px-4 py-2 text-right">€/pax netto</th>
                        <th className="px-4 py-2 text-right">Totale</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {st.bookings.map((b) => (
                        <tr key={b.id} className="hover:bg-slate-50">
                          <td className="px-4 py-2.5 text-slate-600 font-mono text-xs">{fmtDate(b.date)}</td>
                          <td className="px-4 py-2.5 font-medium text-slate-800">{b.line_name}</td>
                          <td className="px-4 py-2.5 text-slate-700">
                            {b.customer_name}
                            {b.phone && <span className="ml-1 text-xs text-slate-400">· {b.phone}</span>}
                          </td>
                          <td className="px-4 py-2.5 text-xs text-slate-500">{b.hotel_name ?? "—"}</td>
                          <td className="px-4 py-2.5 text-center font-semibold text-slate-700">{b.pax}</td>
                          <td className="px-4 py-2.5 text-right text-slate-600">{fmtEur(b.price_agency_cents)}</td>
                          <td className="px-4 py-2.5 text-right font-bold text-slate-800">{fmtEur(b.total_agency_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-slate-200 bg-indigo-50">
                        <td colSpan={4} className="px-4 py-2 text-xs font-semibold text-slate-500">Totale {st.agency_name}</td>
                        <td className="px-4 py-2 text-center font-bold text-slate-700">{st.total_pax}</td>
                        <td />
                        <td className="px-4 py-2 text-right font-bold text-indigo-700">{fmtEur(st.total_agency_cents)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          );
        })}

        {/* Grand total */}
        {statements.length > 1 && (
          <div className="rounded-2xl border-2 border-indigo-200 bg-indigo-50 px-6 py-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-600">Totale generale — {fmtDate(from)} / {fmtDate(to)}</p>
              <p className="text-xs text-slate-500">{statements.length} agenzie · {grandPax} pax</p>
            </div>
            <p className="text-2xl font-bold text-indigo-700">{fmtEur(grandTotal)}</p>
          </div>
        )}
      </div>
    </div>
  );
}
