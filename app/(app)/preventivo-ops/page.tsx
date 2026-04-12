"use client";

import { FormEvent, useEffect, useEffectEvent, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Quote = {
  id: string;
  owner_label: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  service_kind: string;
  route_label: string;
  price_cents: number;
  currency: string;
  passenger_count?: number | null;
  valid_until?: string | null;
  notes?: string | null;
  client_name?: string | null;
  client_email?: string | null;
  created_at: string;
};

type QuoteWaypoint = { id: string; quote_id: string; label: string; sort_order: number };

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string }> = {
  draft:    { label: "Bozza",     bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
  sent:     { label: "Inviato",   bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  accepted: { label: "Accettato", bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
  rejected: { label: "Rifiutato", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" },
  expired:  { label: "Scaduto",   bg: "#fafafa", color: "#9ca3af", border: "#e5e7eb" },
};

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function apiCall(token: string, body: Record<string, unknown>) {
  const res = await fetch("/api/ops/quotes", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[] }>;
}

export default function PreventivoOpsPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [waypoints, setWaypoints] = useState<QuoteWaypoint[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const load = useEffectEvent(async () => {
    setLoading(true);
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch("/api/ops/quotes", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[] };
    if (res.status === 403) { setAccessDenied(true); setLoading(false); return; }
    if (!body.ok) { setMessage({ type: "err", text: body.error ?? "Errore caricamento." }); setLoading(false); return; }
    setQuotes(body.quotes ?? []);
    setWaypoints(body.waypoints ?? []);
    setLoading(false);
  });

  useEffect(() => { void load(); }, []);

  const totals = useMemo(() => ({
    total: quotes.length,
    draft: quotes.filter((q) => q.status === "draft").length,
    sent: quotes.filter((q) => q.status === "sent").length,
    accepted: quotes.filter((q) => q.status === "accepted").length,
    value: quotes.filter((q) => q.status !== "rejected" && q.status !== "expired").reduce((s, q) => s + q.price_cents, 0),
  }), [quotes]);

  const filtered = filterStatus === "all" ? quotes : quotes.filter((q) => q.status === filterStatus);

  const createQuote = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const token = await getToken();
    if (!token) return;
    const form = new FormData(e.currentTarget);
    const price = Number(String(form.get("price") ?? "0").replace(",", "."));
    const waypointList = String(form.get("waypoints") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const res = await apiCall(token, {
      action: "create_quote",
      service_kind: String(form.get("service_kind") ?? ""),
      route_label: String(form.get("route_label") ?? ""),
      price_cents: Math.round(price * 100),
      currency: "EUR",
      passenger_count: form.get("passenger_count") ? Number(form.get("passenger_count")) : null,
      valid_until: String(form.get("valid_until") ?? "") || null,
      notes: String(form.get("notes") ?? "") || null,
      client_name: String(form.get("client_name") ?? "") || null,
      client_email: String(form.get("client_email") ?? "") || null,
      waypoints: waypointList,
    });
    if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Errore." }); return; }
    setQuotes(res.quotes ?? []);
    setWaypoints(res.waypoints ?? []);
    setMessage({ type: "ok", text: "Preventivo creato." });
    e.currentTarget.reset();
  };

  const sendQuote = async (quoteId: string) => {
    const token = await getToken();
    if (!token) return;
    setSending(quoteId);
    const res = await apiCall(token, { action: "send_quote", quote_id: quoteId });
    setSending(null);
    if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Invio fallito." }); return; }
    setQuotes(res.quotes ?? []);
    setMessage({ type: "ok", text: "Email inviata al cliente." });
  };

  const deleteQuote = async (quoteId: string) => {
    if (!confirm("Eliminare questo preventivo?")) return;
    const token = await getToken();
    if (!token) return;
    setDeleting(quoteId);
    const res = await apiCall(token, { action: "delete_quote", quote_id: quoteId });
    setDeleting(null);
    if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Errore." }); return; }
    setQuotes(res.quotes ?? []);
    setMessage({ type: "ok", text: "Preventivo eliminato." });
  };

  const updateStatus = async (quoteId: string, status: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await apiCall(token, { action: "update_status", quote_id: quoteId, status });
    if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Errore." }); return; }
    setQuotes(res.quotes ?? []);
  };

  if (accessDenied) return (
    <section className="page-section">
      <PageHeader title="Preventivi" breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Preventivi" }]} />
      <div className="card p-6 text-sm text-slate-500">Accesso non abilitato per questo utente.</div>
    </section>
  );

  return (
    <section className="page-section">
      <PageHeader
        title="Preventivi"
        subtitle="Crea e invia preventivi ai clienti via email."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Preventivi" }]}
      />

      {message && (
        <div className={`rounded-xl px-4 py-3 text-sm font-medium border ${message.type === "ok" ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>
          {message.type === "ok" ? "✅ " : "❌ "}{message.text}
          <button onClick={() => setMessage(null)} className="ml-3 text-current opacity-50 hover:opacity-100">✕</button>
        </div>
      )}

      {/* KPI */}
      <div className="grid gap-3 sm:grid-cols-5">
        {[
          { label: "Totale", value: totals.total },
          { label: "Bozze", value: totals.draft },
          { label: "Inviati", value: totals.sent },
          { label: "Accettati", value: totals.accepted },
          { label: "Valore EUR", value: `${(totals.value / 100).toFixed(2)}` },
        ].map((k) => (
          <div key={k.label} className="card p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k.label}</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{k.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[420px_1fr]">
        {/* Form nuovo preventivo */}
        <SectionCard title="Nuovo preventivo" subtitle="Compila e crea la bozza">
          <form className="space-y-3" onSubmit={createQuote}>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Cliente
                <input name="client_name" className="mt-1 input-saas w-full" placeholder="Nome cliente / azienda" />
              </label>
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Email cliente
                <input name="client_email" type="email" className="mt-1 input-saas w-full" placeholder="email@example.com" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Tipo servizio*
                <input name="service_kind" required className="mt-1 input-saas w-full" placeholder="es. Transfer, Bus..." />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Tratta*
                <input name="route_label" required className="mt-1 input-saas w-full" placeholder="es. Napoli → Forio" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Prezzo EUR*
                <input name="price" required className="mt-1 input-saas w-full" placeholder="es. 120.00" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Pax
                <input name="passenger_count" type="number" min={1} className="mt-1 input-saas w-full" placeholder="es. 4" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Validità offerta
                <input name="valid_until" type="date" className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Punti di carico
                <input name="waypoints" className="mt-1 input-saas w-full" placeholder="Luogo1, Luogo2..." />
              </label>
              <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                Note
                <textarea name="notes" rows={3} className="mt-1 input-saas w-full resize-none" placeholder="Dettagli aggiuntivi..." />
              </label>
            </div>
            <button type="submit" className="btn-primary w-full py-2.5">+ Crea preventivo</button>
          </form>
        </SectionCard>

        {/* Lista preventivi */}
        <SectionCard
          title="Preventivi"
          loading={loading}
          loadingLines={4}
          actions={
            <div className="flex gap-1 flex-wrap">
              {["all", "draft", "sent", "accepted", "rejected"].map((s) => (
                <button key={s} onClick={() => setFilterStatus(s)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border transition ${filterStatus === s ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                  {s === "all" ? "Tutti" : STATUS_CONFIG[s]?.label ?? s}
                </button>
              ))}
            </div>
          }
        >
          {filtered.length === 0 ? (
            <p className="text-sm text-slate-400">Nessun preventivo.</p>
          ) : (
            <div className="space-y-3">
              {filtered.map((q) => {
                const cfg = STATUS_CONFIG[q.status] ?? STATUS_CONFIG.draft;
                const qWaypoints = waypoints.filter((w) => w.quote_id === q.id).map((w) => w.label);
                const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("it-IT");
                return (
                  <div key={q.id} className="rounded-xl border border-slate-200 bg-white p-4 space-y-2 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-semibold text-slate-900 truncate">{q.route_label}</p>
                          <span style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}
                            className="rounded-full px-2 py-0.5 text-[10px] font-bold shrink-0">
                            {cfg.label}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{q.service_kind}{q.client_name ? ` · ${q.client_name}` : ""}{q.client_email ? ` <${q.client_email}>` : ""}</p>
                      </div>
                      <p className="text-lg font-bold text-slate-900 shrink-0">{q.currency} {(q.price_cents / 100).toFixed(2)}</p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                      {q.passenger_count && <span>👥 {q.passenger_count} pax</span>}
                      {q.valid_until && <span>📅 Valido fino al {fmtDate(q.valid_until)}</span>}
                      {qWaypoints.length > 0 && <span>📍 {qWaypoints.join(" → ")}</span>}
                      <span>Creato {fmtDate(q.created_at)}</span>
                    </div>
                    {q.notes && <p className="text-xs text-slate-500 italic">{q.notes}</p>}
                    <div className="flex flex-wrap gap-2 pt-1">
                      {q.status === "draft" && q.client_email && (
                        <button onClick={() => void sendQuote(q.id)} disabled={sending === q.id}
                          className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition">
                          {sending === q.id ? "Invio..." : "📧 Invia email"}
                        </button>
                      )}
                      {q.status === "draft" && !q.client_email && (
                        <span className="text-xs text-amber-600">⚠️ Aggiungi email cliente per inviare</span>
                      )}
                      {q.status === "sent" && (
                        <>
                          <button onClick={() => void updateStatus(q.id, "accepted")}
                            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition">
                            ✅ Segna accettato
                          </button>
                          <button onClick={() => void updateStatus(q.id, "rejected")}
                            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-100 transition">
                            ❌ Segna rifiutato
                          </button>
                        </>
                      )}
                      {(q.status === "accepted" || q.status === "rejected") && (
                        <button onClick={() => void updateStatus(q.id, "draft")}
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 transition">
                          ↩ Riporta a bozza
                        </button>
                      )}
                      <button onClick={() => void deleteQuote(q.id)} disabled={deleting === q.id}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 hover:bg-rose-100 disabled:opacity-50 transition ml-auto">
                        {deleting === q.id ? "..." : "Elimina"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
