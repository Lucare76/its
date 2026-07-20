"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Dashboard = {
  ok: boolean;
  range: { start: string; end: string };
  labels: { estimated: string; billed: string; tooltip: string };
  cards: Record<string, number | null>;
  counts: {
    sent: number;
    delivered: number;
    read: number;
    failed: number;
    free: number;
    paid: number;
    missingRate: number;
    deliveryRate: number;
    readRate: number;
  };
  categories: Array<{ category: string; volume: number; estimated_cost: number; free: number; missing_rate: number }>;
  daily: Array<{ date: string; volume: number; free: number; paid: number; missing_rate: number; estimated_cost: number; reconciled_cost: number; difference: number | null }>;
  passengers: { contacted: number; top: Array<{ booking_id: string; customer_name: string | null; pax: number; messages: number; delivered: number; estimated_cost: number }> };
  filters: { categories: string[]; countries: string[]; templates: string[] };
  settings: {
    daily_threshold: number;
    monthly_threshold: number;
    max_avg_messages_per_passenger: number;
    anomaly_growth_percent: number;
  };
  alerts: string[];
  simulation: { current_cost: number; simulated_cost: number; difference: number; difference_percent: number | null; volume: number; future_rates_count: number };
  rates: Array<Record<string, string | number | boolean | null>>;
  updated_at: string;
};

type CsvPreview = {
  period_start: string | null;
  period_end: string | null;
  valid_rows: number;
  ignored_rows: number;
  duplicate_rows: number;
  volume_total: number;
  cost_total: number;
  categories: string[];
  rows: Array<{ date: string; pricing_category: string; pricing_type: string | null; volume: number; cost: number; estimated_cost: number; difference: number; difference_percent: number | null }>;
};

const RANGE_OPTIONS = [
  ["today", "Oggi"],
  ["last7", "Ultimi 7 giorni"],
  ["current_month", "Mese corrente"],
  ["previous_month", "Mese precedente"],
] as const;

function fmtEuro(value: number | null | undefined) {
  return `EUR ${(value ?? 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pct(value: number | null | undefined) {
  return `${Math.round((value ?? 0) * 100)}%`;
}

function statLabel(key: string) {
  const labels: Record<string, string> = {
    utility: "Utility",
    service: "Servizio",
    marketing: "Marketing",
    authentication: "Autenticazione",
    gratuiti: "Gratuiti",
    da_determinare: "Da determinare",
  };
  return labels[key] ?? key;
}

function Card({ title, value, note, tone = "default" }: { title: string; value: string; note?: string; tone?: "default" | "accent" | "warning" }) {
  const toneClass = {
    default: "border-slate-200 bg-white",
    accent: "border-blue-200 bg-blue-50",
    warning: "border-amber-200 bg-amber-50",
  }[tone];

  return (
    <div className={`rounded-lg border p-4 shadow-sm ${toneClass}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  const width = `${Math.max(0, Math.min(100, Math.round(value * 100)))}%`;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
      <div className="h-full rounded-full bg-blue-600" style={{ width }} />
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm">
      <p className="font-semibold text-slate-800">{title}</p>
      <p className="mt-1 text-slate-600">{text}</p>
    </div>
  );
}

export default function WhatsAppCostsPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [range, setRange] = useState("current_month");
  const [category, setCategory] = useState("");
  const [country, setCountry] = useState("");
  const [template, setTemplate] = useState("");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [csvText, setCsvText] = useState("");
  const [csvPreview, setCsvPreview] = useState<CsvPreview | null>(null);
  const [rateForm, setRateForm] = useState({
    country_code: "IT",
    pricing_category: "utility",
    unit_price: "0.000000",
    valid_from: "2026-07-01",
    valid_to: "",
    source: "manual",
    is_confirmed: false,
  });

  const query = useMemo(() => {
    const params = new URLSearchParams({ range });
    if (category) params.set("category", category);
    if (country) params.set("country", country);
    if (template) params.set("template", template);
    return params.toString();
  }, [category, country, range, template]);

  async function authHeaders() {
    const token = await getToken();
    if (!token) throw new Error("Sessione non valida.");
    return { Authorization: `Bearer ${token}` };
  }

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/ops/whatsapp-costs?${query}`, { headers });
      const body = await res.json() as Dashboard & { error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Caricamento non riuscito.");
      setData(body);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore caricamento costi WhatsApp.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveRate() {
    setMessage("");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/whatsapp-costs", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "rate",
          payload: {
            ...rateForm,
            unit_price: Number(rateForm.unit_price),
            valid_to: rateForm.valid_to || null,
          },
        }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Salvataggio tariffa non riuscito.");
      setMessage("Tariffa salvata.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore salvataggio tariffa.");
    }
  }

  async function saveSettings(next: Partial<Dashboard["settings"]>) {
    if (!data) return;
    setMessage("");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/whatsapp-costs", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "settings", payload: { ...data.settings, ...next } }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Salvataggio soglie non riuscito.");
      setMessage("Soglie salvate.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore soglie.");
    }
  }

  async function previewCsv(commit = false) {
    setMessage("");
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/whatsapp-costs/reconcile", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText, commit }),
      });
      const body = await res.json() as { preview?: CsvPreview; error?: string; imported?: number };
      if (!res.ok || !body.preview) throw new Error(body.error ?? "Import CSV non riuscito.");
      setCsvPreview(body.preview);
      setMessage(commit ? `Report Meta importato: ${body.imported ?? 0} righe.` : "Anteprima CSV pronta.");
      if (commit) await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore CSV.");
    }
  }

  async function loadCsvFile(file: File | null) {
    if (!file) return;
    if (file.size > 1_000_000) {
      setMessage("CSV troppo grande: limite 1 MB.");
      return;
    }
    setCsvText(await file.text());
  }

  if (loading && !data) {
    return <main className="p-6 text-sm text-slate-500">Caricamento costi WhatsApp...</main>;
  }

  const hasDelivered = (data?.counts.delivered ?? 0) + (data?.counts.read ?? 0) > 0;
  const hasRates = (data?.rates.length ?? 0) > 0;
  const hasEstimatedCost = (data?.cards.estimated_current_month ?? 0) > 0;
  const needsSetup = !hasRates || !hasDelivered || (data?.counts.missingRate ?? 0) > 0;

  return (
    <main className="min-h-screen bg-slate-50 p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Monitor operativo</p>
              <h1 className="mt-1 text-2xl font-bold text-slate-950">Costi WhatsApp</h1>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">{data?.labels.tooltip}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <span className="block font-semibold text-slate-900">{hasRates ? "Configurate" : "Da configurare"}</span>
                Tariffe
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <span className="block font-semibold text-slate-900">{hasDelivered ? "Presenti" : "Assenti"}</span>
                Delivery Meta
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <span className="block font-semibold text-slate-900">{data?.counts.missingRate ?? 0}</span>
                Senza tariffa
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <span className="block font-semibold text-slate-900">{data ? new Date(data.updated_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "-"}</span>
                Ultimo update
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <select value={range} onChange={(e) => setRange(e.target.value)} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              {RANGE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">Categorie</option>
              {data?.filters.categories.map((item) => <option key={item} value={item}>{statLabel(item)}</option>)}
            </select>
            <select value={country} onChange={(e) => setCountry(e.target.value)} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">Paesi</option>
              {data?.filters.countries.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={template} onChange={(e) => setTemplate(e.target.value)} className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
              <option value="">Template</option>
              {data?.filters.templates.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        </header>

        {message ? <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">{message}</div> : null}
        {needsSetup ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">Perche potresti vedere costo zero</p>
            <p className="mt-1">
              Il costo appare solo dopo status Meta consegnati e tariffa valida. Mancano ancora
              {!hasRates ? " le tariffe configurate" : ""}
              {!hasRates && !hasDelivered ? " e" : ""}
              {!hasDelivered ? " messaggi consegnati nel periodo" : ""}
              {(data?.counts.missingRate ?? 0) > 0 ? `; ${data?.counts.missingRate ?? 0} messaggi sono senza tariffa applicabile` : ""}.
            </p>
          </div>
        ) : null}
        {data?.alerts.length ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {data.alerts.map((alert) => <p key={alert}>{alert}</p>)}
          </div>
        ) : null}

        <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Card title="Costo Meta stimato oggi" value={fmtEuro(data?.cards.estimated_today)} note={`${data?.counts.delivered ?? 0} messaggi consegnati - aggiornato ${data ? new Date(data.updated_at).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : ""}`} tone={hasEstimatedCost ? "accent" : "warning"} />
          <Card title="Costo Meta stimato questo mese" value={fmtEuro(data?.cards.estimated_current_month)} tone={hasEstimatedCost ? "accent" : "default"} />
          <Card title="Proiezione fine mese" value={fmtEuro(data?.cards.projected_month_end)} />
          <Card title="Messaggi consegnati questo mese" value={String(data?.cards.delivered_current_month ?? 0)} />
          <Card title="Costo medio per messaggio" value={fmtEuro(data?.cards.avg_cost_per_message)} />
          <Card title="Costo medio per passeggero" value={fmtEuro(data?.cards.avg_cost_per_passenger)} />
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Stati messaggi</h2>
            <div className="mt-3 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <p className="rounded-md bg-slate-50 p-2">Inviati<br /><strong>{data?.counts.sent ?? 0}</strong></p>
                <p className="rounded-md bg-slate-50 p-2">Consegnati<br /><strong>{data?.counts.delivered ?? 0}</strong></p>
                <p className="rounded-md bg-slate-50 p-2">Letti<br /><strong>{data?.counts.read ?? 0}</strong></p>
                <p className="rounded-md bg-slate-50 p-2">Falliti<br /><strong>{data?.counts.failed ?? 0}</strong></p>
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-slate-500"><span>Tasso consegna</span><strong>{pct(data?.counts.deliveryRate)}</strong></div>
                <ProgressBar value={data?.counts.deliveryRate ?? 0} />
              </div>
              <div>
                <div className="mb-1 flex justify-between text-xs text-slate-500"><span>Tasso lettura</span><strong>{pct(data?.counts.readRate)}</strong></div>
                <ProgressBar value={data?.counts.readRate ?? 0} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Ripartizione costi</h2>
            <div className="mt-3 space-y-2 text-sm">
              {data?.categories.map((item) => (
                <div key={item.category} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-700">{statLabel(item.category)}</span>
                    <strong>{fmtEuro(item.estimated_cost)}</strong>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{item.volume} messaggi - {item.free} gratuiti - {item.missing_rate} senza tariffa</p>
                </div>
              ))}
              {!data?.categories.length ? <EmptyState title="Nessuna categoria nel periodo" text="Arrivera qui il dettaglio appena Meta invia status con pricing." /> : null}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Simulazione nuove tariffe</h2>
            <div className="mt-3 space-y-1 text-sm text-slate-700">
              <p>Costo con regole attuali: <strong>{fmtEuro(data?.simulation.current_cost)}</strong></p>
              <p>Costo simulato futuro: <strong>{fmtEuro(data?.simulation.simulated_cost)}</strong></p>
              <p>Differenza: <strong>{fmtEuro(data?.simulation.difference)}</strong> {data?.simulation.difference_percent != null ? `(${data.simulation.difference_percent.toFixed(1)}%)` : ""}</p>
              <p className="text-xs text-slate-500">{data?.simulation.volume ?? 0} messaggi ultimi 30 giorni - {data?.simulation.future_rates_count ?? 0} tariffe future provvisorie/configurate</p>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-bold text-slate-800">Tabella giornaliera</h2>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr><th className="py-2">Data</th><th>Volume</th><th>Gratuiti</th><th>A pagamento</th><th>Da determinare</th><th>Costo Meta stimato</th><th>Costo fatturato da Meta</th><th>Differenza</th></tr>
              </thead>
              <tbody>
                {data?.daily.map((row) => (
                  <tr key={row.date} className="border-t border-slate-100">
                    <td className="py-2">{row.date}</td><td>{row.volume}</td><td>{row.free}</td><td>{row.paid}</td><td>{row.missing_rate}</td>
                    <td>{fmtEuro(row.estimated_cost)}</td><td>{row.reconciled_cost ? fmtEuro(row.reconciled_cost) : "-"}</td><td>{row.difference == null ? "-" : fmtEuro(row.difference)}</td>
                  </tr>
                ))}
                {!data?.daily.length ? (
                  <tr className="border-t border-slate-100">
                    <td colSpan={8} className="py-6 text-center text-sm text-slate-500">Nessun evento WhatsApp nel periodo selezionato.</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Controllo passeggeri</h2>
            <p className="mt-2 text-sm text-slate-600">Passeggeri contattati: <strong>{data?.passengers.contacted ?? 0}</strong> - messaggi medi per passeggero: <strong>{(data?.cards.avg_messages_per_passenger ?? 0).toFixed(2)}</strong></p>
            <div className="mt-3 space-y-2">
              {data?.passengers.top.slice(0, 8).map((row) => (
                <div key={row.booking_id} className="flex justify-between rounded-md bg-slate-50 px-3 py-2 text-sm">
                  <span>{row.customer_name ?? row.booking_id}</span>
                  <strong>{row.messages} msg - {fmtEuro(row.estimated_cost)}</strong>
                </div>
              ))}
              {!data?.passengers.top.length ? <EmptyState title="Nessun passeggero da mostrare" text="Il controllo si popola quando i messaggi sono collegati a prenotazioni o clienti." /> : null}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Soglie e avvisi</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {[
                ["daily_threshold", "Soglia giornaliera"],
                ["monthly_threshold", "Soglia mensile"],
                ["max_avg_messages_per_passenger", "Max msg/passeggero"],
                ["anomaly_growth_percent", "Crescita anomala %"],
              ].map(([key, label]) => (
                <label key={key} className="text-xs font-medium text-slate-600">
                  {label}
                  <input
                    type="number"
                    step="0.01"
                    value={data?.settings[key as keyof Dashboard["settings"]] ?? 0}
                    onChange={(e) => setData((prev) => prev ? { ...prev, settings: { ...prev.settings, [key]: Number(e.target.value) } } : prev)}
                    className="mt-1 w-full rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                  />
                </label>
              ))}
            </div>
            <button onClick={() => data && void saveSettings(data.settings)} className="mt-3 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white">Salva soglie</button>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Tariffe WhatsApp</h2>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <input value={rateForm.country_code} onChange={(e) => setRateForm({ ...rateForm, country_code: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" placeholder="Paese es. IT" />
              <input value={rateForm.pricing_category} onChange={(e) => setRateForm({ ...rateForm, pricing_category: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" placeholder="Categoria" />
              <input value={rateForm.unit_price} onChange={(e) => setRateForm({ ...rateForm, unit_price: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" placeholder="Prezzo unitario" />
              <input type="date" value={rateForm.valid_from} onChange={(e) => setRateForm({ ...rateForm, valid_from: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" />
              <input type="date" value={rateForm.valid_to} onChange={(e) => setRateForm({ ...rateForm, valid_to: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" />
              <input value={rateForm.source} onChange={(e) => setRateForm({ ...rateForm, source: e.target.value })} className="rounded-md border border-slate-200 px-2 py-2 text-sm" placeholder="Fonte" />
            </div>
            <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={rateForm.is_confirmed} onChange={(e) => setRateForm({ ...rateForm, is_confirmed: e.target.checked })} />
              Tariffa confermata
            </label>
            <button onClick={() => void saveRate()} className="mt-3 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white">Aggiungi tariffa</button>
            <div className="mt-3 max-h-48 overflow-auto text-xs text-slate-600">
              {data?.rates.map((rate, index) => (
                <p key={`${rate.id ?? index}`} className="border-t border-slate-100 py-1">{String(rate.country_code)} - {String(rate.pricing_category)} - {fmtEuro(Number(rate.unit_price ?? 0))} - da {String(rate.valid_from)} - {rate.is_confirmed ? "confermata" : "provvisoria"}</p>
              ))}
              {!data?.rates.length ? <p className="rounded-md bg-amber-50 p-3 text-amber-900">Nessuna tariffa configurata: finche manca una tariffa valida, i messaggi consegnati restano in stato da determinare.</p> : null}
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-sm font-bold text-slate-800">Importa report costi Meta</h2>
            <input type="file" accept=".csv,text/csv" onChange={(e) => void loadCsvFile(e.target.files?.[0] ?? null)} className="mt-3 text-sm" />
            <textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} rows={7} className="mt-3 w-full rounded-md border border-slate-200 p-2 text-xs" placeholder="Incolla qui il CSV esportato da WhatsApp Manager" />
            <div className="mt-2 flex gap-2">
              <button onClick={() => void previewCsv(false)} className="rounded-md border border-slate-200 px-3 py-2 text-sm">Anteprima</button>
              <button onClick={() => void previewCsv(true)} disabled={!csvPreview} className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Importa report costi Meta</button>
            </div>
            {csvPreview ? (
              <div className="mt-3 rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                <p>Periodo: {csvPreview.period_start ?? "-"} / {csvPreview.period_end ?? "-"}</p>
                <p>Righe valide: {csvPreview.valid_rows} - ignorate: {csvPreview.ignored_rows} - duplicate: {csvPreview.duplicate_rows}</p>
                <p>Volume totale: {csvPreview.volume_total} - costo totale Meta: {fmtEuro(csvPreview.cost_total)}</p>
                <p>Categorie: {csvPreview.categories.join(", ") || "-"}</p>
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
