"use client";

import { useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

// ─── Tipi ────────────────────────────────────────────────────────────────────

type AgencyRow = {
  id: string;
  name: string;
  invoice_email: string | null;
  contact_email: string | null;
  booking_email: string | null;
  invoice_cadence: string;
  invoice_send_day: number;
  invoice_enabled: boolean;
};

type InvoiceRow = {
  id: string;
  agency_name: string;
  period_from: string;
  period_to: string;
  status: "draft" | "sent" | "paid";
  total_cents: number;
  services_count: number;
  created_at: string;
  sent_at: string | null;
  paid_at: string | null;
  payment_note: string | null;
  invoice_data: Array<{ numero_pratica: string; cliente_nome: string; data_servizio: string; tipo_servizio: string; importo_cents: number }>;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(iso: string) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatCents(cents: number) {
  return (cents / 100).toLocaleString("it-IT", { minimumFractionDigits: 2 }) + " €";
}

const CADENCE_LABELS: Record<string, string> = {
  weekly: "Settimanale",
  biweekly: "Bisettimanale",
  monthly: "Mensile"
};

const DAY_LABELS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

async function getToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// ─── Componente ─────────────────────────────────────────────────────────────

export default function EstrattoContoPage() {
  const [token, setToken] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Filtri
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "sent" | "paid">("all");
  const [agencyFilter, setAgencyFilter] = useState<string>("all");

  // Generazione manuale
  const [genAgency, setGenAgency] = useState<string>("");
  const [genFrom, setGenFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [genTo, setGenTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [genSend, setGenSend] = useState(false);
  const [generating, setGenerating] = useState(false);

  // Preview
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<InvoiceRow | null>(null);

  // Configurazione agenzia
  const [editingAgency, setEditingAgency] = useState<AgencyRow | null>(null);
  const [savingAgency, setSavingAgency] = useState(false);

  // Mark paid
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payNote, setPayNote] = useState("");

  const loadData = async (tok: string) => {
    const [agRes, invRes] = await Promise.all([
      fetch("/api/pricing/bootstrap", { headers: { Authorization: `Bearer ${tok}` } }),
      fetch("/api/invoices", { headers: { Authorization: `Bearer ${tok}` } })
    ]);
    const agBody = (await agRes.json().catch(() => null)) as { agencies?: AgencyRow[] } | null;
    const invBody = (await invRes.json().catch(() => null)) as { invoices?: InvoiceRow[] } | null;
    setAgencies(agBody?.agencies ?? []);
    setInvoices(invBody?.invoices ?? []);
  };

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!hasSupabaseEnv || !supabase || !session.userId || !session.tenantId) {
        if (active) { setError("Login richiesto."); setLoading(false); }
        return;
      }
      setTenantId(session.tenantId);
      const tok = await getToken();
      if (!tok) { setError("Sessione non valida."); setLoading(false); return; }
      setToken(tok);
      await loadData(tok);
      if (active) setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, []);

  const agencyNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const inv of invoices) {
      const name = inv.agency_name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = seen.get(key);
      if (!existing || (existing === existing.toUpperCase() && name !== name.toUpperCase())) {
        seen.set(key, name);
      }
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b, "it"));
  }, [invoices]);

  const filteredInvoices = useMemo(() => invoices.filter((inv) => {
    const statusOk = statusFilter === "all" || inv.status === statusFilter;
    const agencyOk = agencyFilter === "all" || inv.agency_name?.trim().toLowerCase() === agencyFilter.toLowerCase();
    return statusOk && agencyOk;
  }), [invoices, statusFilter, agencyFilter]);

  const generateInvoice = async () => {
    if (!token || !genAgency) return;
    setGenerating(true); setMessage(null);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ agency_name: genAgency, period_from: genFrom, period_to: genTo, send: genSend })
      });
      const body = (await res.json()) as { ok?: boolean; html?: string; items_count?: number; total_cents?: number; error?: string };
      if (!res.ok || !body.ok) { setMessage(`Errore: ${body.error}`); }
      else {
        setMessage(`Estratto conto generato: ${body.items_count} pratiche, totale ${formatCents(body.total_cents ?? 0)}${genSend ? " — inviato via email" : ""}`);
        if (body.html) setPreviewHtml(body.html);
        await loadData(token);
      }
    } finally { setGenerating(false); }
  };

  const markPaid = async (invoiceId: string) => {
    if (!token) return;
    const res = await fetch(`/api/invoices/${invoiceId}/mark-paid`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ payment_note: payNote })
    });
    if (res.ok) {
      setPayingId(null); setPayNote("");
      await loadData(token);
    }
  };

  const saveAgencySettings = async () => {
    if (!token || !editingAgency) return;
    setSavingAgency(true);
    const res = await fetch(`/api/agencies/${editingAgency.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        invoice_email: editingAgency.invoice_email,
        invoice_cadence: editingAgency.invoice_cadence,
        invoice_send_day: editingAgency.invoice_send_day,
        invoice_enabled: editingAgency.invoice_enabled
      })
    });
    setSavingAgency(false);
    if (res.ok) { setEditingAgency(null); await loadData(token); }
  };

  const statusBadge = (status: string) => {
    if (status === "paid") return "rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-700";
    if (status === "sent") return "rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-semibold text-blue-700";
    return "rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600";
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento...</div>;

  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">Estratto conto agenzie</h1>
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {/* Configurazione agenzie */}
      <div className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-500">Configurazione invio automatico</h2>
        <div className="grid gap-2 xl:grid-cols-2">
          {agencies.filter((a) => a.active !== false).map((agency) => (
            <div key={agency.id} className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">{agency.name}</p>
                <p className="text-xs text-slate-500">
                  {agency.invoice_enabled
                    ? `${CADENCE_LABELS[agency.invoice_cadence] ?? agency.invoice_cadence} · ${DAY_LABELS[agency.invoice_send_day]} · ${agency.invoice_email ?? agency.contact_email ?? "no email"}`
                    : "Invio automatico disabilitato"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={agency.invoice_enabled ? "rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700" : "rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500"}>
                  {agency.invoice_enabled ? "ON" : "OFF"}
                </span>
                <button type="button" onClick={() => setEditingAgency({ ...agency })}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50">
                  Configura
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Genera manualmente */}
      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-500">Genera estratto conto manuale</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs font-medium text-slate-600">
            Agenzia *
            <select value={genAgency} onChange={(e) => setGenAgency(e.target.value)} className="mt-1 input-saas w-full">
              <option value="">— seleziona —</option>
              {agencies.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Dal
            <input type="date" value={genFrom} onChange={(e) => setGenFrom(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <input type="date" value={genTo} onChange={(e) => setGenTo(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
              <input type="checkbox" checked={genSend} onChange={(e) => setGenSend(e.target.checked)} className="rounded" />
              Invia email automaticamente
            </label>
            <button type="button" onClick={() => void generateInvoice()} disabled={generating || !genAgency}
              className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {generating ? "Generazione..." : "Genera"}
            </button>
          </div>
        </div>
        {message && <p className="text-sm text-slate-700">{message}</p>}
        {previewHtml && (
          <div className="space-y-2">
            <div className="flex gap-2">
              <button type="button" onClick={() => {
                const w = window.open("", "_blank");
                if (w) { w.document.write(previewHtml); w.document.close(); }
              }} className="btn-secondary px-4 py-2 text-sm">
                Apri anteprima / Stampa PDF
              </button>
              <button type="button" onClick={() => setPreviewHtml(null)} className="btn-secondary px-4 py-2 text-sm">
                Chiudi anteprima
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Lista estratti conto */}
      <div className="card p-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-[0.1em] text-slate-500">Estratti conto</h2>
          <div className="ml-auto flex flex-wrap gap-2">
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="input-saas text-xs">
              <option value="all">Tutti gli stati</option>
              <option value="draft">Bozza</option>
              <option value="sent">Inviato</option>
              <option value="paid">Pagato</option>
            </select>
            <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas text-xs">
              <option value="all">Tutte le agenzie</option>
              {agencyNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        {filteredInvoices.length === 0 ? (
          <p className="text-sm text-slate-500">Nessun estratto conto.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Agenzia</th>
                  <th className="px-3 py-2">Periodo</th>
                  <th className="px-3 py-2">Pratiche</th>
                  <th className="px-3 py-2">Totale</th>
                  <th className="px-3 py-2">Stato</th>
                  <th className="px-3 py-2">Inviato</th>
                  <th className="px-3 py-2">Pagato</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {filteredInvoices.map((inv) => (
                  <>
                    <tr key={inv.id} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 font-medium">{inv.agency_name}</td>
                      <td className="px-3 py-2 text-xs">{formatDate(inv.period_from)} — {formatDate(inv.period_to)}</td>
                      <td className="px-3 py-2">{inv.services_count}</td>
                      <td className="px-3 py-2 font-semibold">{formatCents(inv.total_cents)}</td>
                      <td className="px-3 py-2"><span className={statusBadge(inv.status)}>{inv.status === "paid" ? "Pagato" : inv.status === "sent" ? "Inviato" : "Bozza"}</span></td>
                      <td className="px-3 py-2 text-xs text-slate-500">{inv.sent_at ? formatDate(inv.sent_at.slice(0, 10)) : "—"}</td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {inv.paid_at ? <span className="text-emerald-600 font-medium">{formatDate(inv.paid_at.slice(0, 10))}</span> : "—"}
                        {inv.payment_note && <span className="ml-1 text-slate-400">({inv.payment_note})</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex gap-1.5">
                          <button type="button" onClick={() => setPreviewInvoice(previewInvoice?.id === inv.id ? null : inv)}
                            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">
                            Dettaglio
                          </button>
                          {inv.status !== "paid" && (
                            <button type="button" onClick={() => { setPayingId(inv.id); setPayNote(""); }}
                              className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100">
                              Segna pagato
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/* Dettaglio pratiche */}
                    {previewInvoice?.id === inv.id && (
                      <tr key={`detail-${inv.id}`} className="bg-slate-50">
                        <td colSpan={8} className="px-4 py-3">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="text-slate-500 border-b border-slate-200">
                                <th className="py-1 text-left font-semibold">N. Pratica</th>
                                <th className="py-1 text-left font-semibold">Cliente</th>
                                <th className="py-1 text-left font-semibold">Data</th>
                                <th className="py-1 text-left font-semibold">Servizio</th>
                                <th className="py-1 text-right font-semibold">Importo</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(inv.invoice_data ?? []).map((item, i) => (
                                <tr key={i} className="border-b border-slate-100">
                                  <td className="py-1">{item.numero_pratica}</td>
                                  <td className="py-1 uppercase">{item.cliente_nome}</td>
                                  <td className="py-1">{formatDate(item.data_servizio)}</td>
                                  <td className="py-1">{item.tipo_servizio}</td>
                                  <td className="py-1 text-right">{formatCents(item.importo_cents)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal mark paid */}
      {payingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <h2 className="text-base font-semibold">Segna come pagato</h2>
            <label className="text-xs font-medium text-slate-600">
              Note pagamento (opzionale)
              <input value={payNote} onChange={(e) => setPayNote(e.target.value)}
                placeholder="Es. Bonifico del 15/04" className="mt-1 input-saas w-full" />
            </label>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setPayingId(null)} className="btn-secondary px-4 py-2 text-sm">Annulla</button>
              <button type="button" onClick={() => void markPaid(payingId)} className="btn-primary px-5 py-2 text-sm">Conferma</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal configurazione agenzia */}
      {editingAgency && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Configura estratto conto — {editingAgency.name}</h2>
              <button type="button" onClick={() => setEditingAgency(null)} className="text-slate-400 hover:text-slate-600 text-xl">×</button>
            </div>
            <div className="space-y-3">
              <label className="text-xs font-medium text-slate-600">
                Email per estratto conto
                <input value={editingAgency.invoice_email ?? ""} onChange={(e) => setEditingAgency({ ...editingAgency, invoice_email: e.target.value || null })}
                  className="mt-1 input-saas w-full" placeholder="email@agenzia.it" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Cadenza invio
                <select value={editingAgency.invoice_cadence} onChange={(e) => setEditingAgency({ ...editingAgency, invoice_cadence: e.target.value })}
                  className="mt-1 input-saas w-full">
                  <option value="weekly">Settimanale</option>
                  <option value="biweekly">Bisettimanale</option>
                  <option value="monthly">Mensile</option>
                </select>
              </label>
              {editingAgency.invoice_cadence !== "monthly" && (
                <label className="text-xs font-medium text-slate-600">
                  Giorno di invio
                  <select value={editingAgency.invoice_send_day} onChange={(e) => setEditingAgency({ ...editingAgency, invoice_send_day: Number(e.target.value) })}
                    className="mt-1 input-saas w-full">
                    {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer">
                <input type="checkbox" checked={editingAgency.invoice_enabled} onChange={(e) => setEditingAgency({ ...editingAgency, invoice_enabled: e.target.checked })} className="rounded" />
                Abilita invio automatico estratto conto
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setEditingAgency(null)} className="btn-secondary px-4 py-2 text-sm">Annulla</button>
              <button type="button" onClick={() => void saveAgencySettings()} disabled={savingAgency} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
                {savingAgency ? "Salvataggio..." : "Salva"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
