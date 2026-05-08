"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { DateInput } from "@/components/ui";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";
import { getClientSessionContext } from "@/lib/supabase/client-session";

// ─── Tipi ────────────────────────────────────────────────────────────────────

type AgencyRow = {
  id: string;
  name: string;
  active?: boolean | null;
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
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const resendInvoice = async (invoiceId: string) => {
    if (!token) return;
    setResendingId(invoiceId);
    const res = await fetch(`/api/invoices/${invoiceId}/resend`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; sent_to?: string; error?: string } | null;
    setResendingId(null);
    if (body?.ok) {
      setMessage(`Email inviata a ${body.sent_to ?? "agenzia"}`);
      await loadData(token);
    } else {
      setMessage(`Errore: ${body?.error ?? "Invio fallito"}`);
    }
  };

  const deleteInvoice = async (invoiceId: string) => {
    if (!token || !confirm("Eliminare questa bozza?")) return;
    setDeletingId(invoiceId);
    const res = await fetch(`/api/invoices/${invoiceId}/delete`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    setDeletingId(null);
    if (body?.ok) {
      setMessage("Bozza eliminata.");
      await loadData(token);
    } else {
      setMessage(`Errore: ${body?.error ?? "Eliminazione fallita"}`);
    }
  };

  const openPrint = (inv: InvoiceRow) => {
    // Genera HTML print-friendly client-side partendo dai dati già caricati
    const printHtml = `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Estratto conto — ${inv.agency_name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:13px;color:#1a1a1a;padding:32px;background:#fff}
  @media print{body{padding:0}.no-print{display:none!important}@page{margin:1.5cm;size:A4 portrait}}
</style></head>
<body>
<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;padding-bottom:16px;border-bottom:3px solid #0f172a">
  <div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.15em;color:#64748b;margin-bottom:6px">Ischia Transfer Service</div>
    <h1 style="font-size:24px;font-weight:800;color:#0f172a">Estratto conto</h1>
    <div style="font-size:16px;font-weight:600;color:#475569;margin-top:4px">${inv.agency_name}</div>
  </div>
  <div style="text-align:right">
    <div style="font-size:14px;font-weight:700;color:#0f172a">${formatDate(inv.period_from)} — ${formatDate(inv.period_to)}</div>
    <div style="font-size:11px;color:#94a3b8;margin-top:4px">Emesso il ${formatDate(inv.created_at.slice(0,10))}</div>
  </div>
</div>
<div style="display:flex;gap:16px;margin-bottom:24px">
  <div style="flex:1;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px 18px">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#94a3b8;margin-bottom:4px">Pratiche</div>
    <div style="font-size:28px;font-weight:900;color:#0e7490">${inv.services_count}</div>
  </div>
  <div style="flex:2;background:#0f172a;border-radius:10px;padding:14px 18px;text-align:right">
    <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:4px">Totale</div>
    <div style="font-size:28px;font-weight:900;color:#fff">${formatCents(inv.total_cents)}</div>
  </div>
</div>
<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-bottom:20px">
  <thead><tr style="background:#0f172a">
    <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">N. Pratica</th>
    <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Cliente</th>
    <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Data</th>
    <th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Servizio</th>
    <th style="padding:10px 12px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;color:rgba(255,255,255,0.65);border:1px solid #1e293b">Importo</th>
  </tr></thead>
  <tbody>
    ${(inv.invoice_data ?? []).map((item, i) => `
    <tr style="background:${i % 2 === 0 ? "#fff" : "#f8fafc"}">
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:12px;color:#64748b">${item.numero_pratica || "—"}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#1e293b;text-transform:uppercase">${item.cliente_nome}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#475569;white-space:nowrap">${formatDate(item.data_servizio)}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;color:#475569">${item.tipo_servizio}</td>
      <td style="padding:8px 12px;border:1px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right;color:#0f2744;white-space:nowrap">${formatCents(item.importo_cents)}</td>
    </tr>`).join("")}
    <tr style="background:#f0f6ff">
      <td colspan="4" style="padding:12px;border:1px solid #e2e8f0;font-size:13px;font-weight:800;color:#0f2744;text-transform:uppercase">Totale complessivo</td>
      <td style="padding:12px;border:1px solid #e2e8f0;font-size:16px;font-weight:900;text-align:right;color:#0f2744;white-space:nowrap">${formatCents(inv.total_cents)}</td>
    </tr>
  </tbody>
</table>
<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.8">
  <strong style="color:#475569">Ischia Transfer Service S.r.l.</strong><br/>
  Via Cilento 14/C, 80077 Ischia (NA) · P.IVA IT 05931311210
</div>
<div class="no-print" style="margin-top:28px;text-align:center">
  <button onclick="window.print()" style="background:#0f172a;color:white;border:none;padding:10px 28px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Stampa / Salva PDF</button>
</div>
</body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(printHtml); w.document.close(); w.focus(); }
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
            <DateInput value={genFrom} onChange={(iso) => setGenFrom(iso)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Al
            <DateInput value={genTo} onChange={(iso) => setGenTo(iso)} className="mt-1 input-saas w-full" />
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
                  <Fragment key={inv.id}>
                    <tr className="border-t border-slate-100 hover:bg-slate-50">
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
                        <div className="flex gap-1.5 flex-wrap">
                          <button type="button" onClick={() => openPrint(inv)}
                            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100">
                            🖨️ Stampa
                          </button>
                          <button type="button" onClick={() => setPreviewInvoice(previewInvoice?.id === inv.id ? null : inv)}
                            className="rounded border border-slate-200 px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-100">
                            Dettaglio
                          </button>
                          {inv.status !== "paid" && (
                            <button type="button" onClick={() => void resendInvoice(inv.id)}
                              disabled={resendingId === inv.id}
                              className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50">
                              {resendingId === inv.id ? "..." : "📧 Re-invia"}
                            </button>
                          )}
                          {inv.status !== "paid" && (
                            <button type="button" onClick={() => { setPayingId(inv.id); setPayNote(""); }}
                              className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100">
                              Segna pagato
                            </button>
                          )}
                          {inv.status === "draft" && (
                            <button type="button" onClick={() => void deleteInvoice(inv.id)}
                              disabled={deletingId === inv.id}
                              className="rounded border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-100 disabled:opacity-50">
                              {deletingId === inv.id ? "..." : "🗑️ Elimina"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/* Dettaglio pratiche */}
                    {previewInvoice?.id === inv.id && (
                      <tr className="bg-slate-50">
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
                  </Fragment>
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
