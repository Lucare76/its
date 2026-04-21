"use client";

import { FormEvent, useEffect, useEffectEvent, useMemo, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Quote = {
  id: string;
  owner_label: string;
  status: "draft" | "sent" | "accepted" | "rejected" | "expired";
  quote_service_code?: string | null;
  quote_bus_line_id?: string | null;
  service_kind: string;
  route_label: string;
  price_cents: number;
  currency: string;
  passenger_count?: number | null;
  arrival_date?: string | null;
  departure_date?: string | null;
  valid_until?: string | null;
  notes?: string | null;
  client_name?: string | null;
  client_email?: string | null;
  created_at: string;
};

type QuoteWaypoint = { id: string; quote_id: string; label: string; sort_order: number; waypoint_type?: "pickup" | "dropoff" | null };
type BusLineOption = { id: string; code: string; name: string; family_code: string; family_name: string };
type BusStopOption = { id: string; bus_line_id: string; direction: "arrival" | "departure"; stop_name: string; city: string; pickup_note?: string | null };

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string }> = {
  draft: { label: "Bozza", bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
  sent: { label: "Inviato", bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  accepted: { label: "Accettato", bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
  rejected: { label: "Rifiutato", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" },
  expired: { label: "Scaduto", bg: "#fafafa", color: "#9ca3af", border: "#e5e7eb" },
};

const STATUS_FILTERS = ["all", "draft", "sent", "accepted", "rejected"] as const;

const QUOTE_SERVICE_OPTIONS = [
  { value: "transfer_port_hotel", label: "Transfer porto - hotel" },
  { value: "transfer_airport_hotel", label: "Transfer aeroporto - hotel" },
  { value: "transfer_airport_hotel_exclusive", label: "Transfer aeroporto - hotel esclusivo" },
  { value: "transfer_airport_hotel_aliscafo", label: "Transfer aeroporto - hotel con aliscafo" },
  { value: "transfer_train_hotel", label: "Transfer stazione / bus - hotel" },
  { value: "transfer_train_hotel_exclusive", label: "Transfer stazione / bus - hotel esclusivo" },
  { value: "transfer_train_hotel_aliscafo", label: "Transfer stazione / bus - hotel con aliscafo" },
  { value: "bus_city_hotel", label: "Linea bus - hotel" },
  { value: "excursion", label: "Escursione" },
  { value: "formula_snav", label: "Formula SNAV" },
  { value: "formula_medmar_napoli", label: "Formula MEDMAR - Napoli" },
  { value: "formula_medmar_pozzuoli", label: "Formula MEDMAR - Pozzuoli" },
] as const;

function formatCurrency(cents: number, currency = "EUR") {
  return new Intl.NumberFormat("it-IT", { style: "currency", currency }).format(cents / 100);
}

function formatDate(iso: string | null | undefined, fallback = "Aperta") {
  if (!iso) return fallback;
  try {
    return new Date(iso).toLocaleDateString("it-IT");
  } catch {
    return iso;
  }
}

function quoteOwnerLabel(quote: Quote) {
  if (quote.client_name && quote.client_email) return `${quote.client_name} - ${quote.client_email}`;
  return quote.client_name ?? quote.client_email ?? "Cliente non indicato";
}

function parseWaypointList(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

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
  return res.json() as Promise<{ ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[]; bus_lines?: BusLineOption[]; bus_stops?: BusStopOption[] }>;
}

export default function PreventivoOpsPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [waypoints, setWaypoints] = useState<QuoteWaypoint[]>([]);
  const [busLines, setBusLines] = useState<BusLineOption[]>([]);
  const [busStops, setBusStops] = useState<BusStopOption[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [arrivalDate, setArrivalDate] = useState("");
  const [departureDate, setDepartureDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [selectedServiceCode, setSelectedServiceCode] = useState("transfer_port_hotel");
  const [selectedBusLineId, setSelectedBusLineId] = useState("");

  const load = useEffectEvent(async () => {
    setLoading(true);
    const token = await getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    const res = await fetch("/api/ops/quotes", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[]; bus_lines?: BusLineOption[]; bus_stops?: BusStopOption[] };
    if (res.status === 403) {
      setAccessDenied(true);
      setLoading(false);
      return;
    }
    if (!body.ok) {
      setMessage({ type: "err", text: body.error ?? "Errore caricamento." });
      setLoading(false);
      return;
    }
    setQuotes(body.quotes ?? []);
    setWaypoints(body.waypoints ?? []);
    setBusLines(body.bus_lines ?? []);
    setBusStops(body.bus_stops ?? []);
    if (!selectedBusLineId && (body.bus_lines ?? []).length > 0) setSelectedBusLineId(body.bus_lines?.[0]?.id ?? "");
    setLoading(false);
  });

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(
    () => ({
      total: quotes.length,
      draft: quotes.filter((q) => q.status === "draft").length,
      sent: quotes.filter((q) => q.status === "sent").length,
      accepted: quotes.filter((q) => q.status === "accepted").length,
      value: quotes
        .filter((q) => q.status !== "rejected" && q.status !== "expired")
        .reduce((sum, quote) => sum + quote.price_cents, 0),
    }),
    [quotes]
  );

  const filtered = useMemo(
    () => (filterStatus === "all" ? quotes : quotes.filter((q) => q.status === filterStatus)),
    [filterStatus, quotes]
  );

  const createQuote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const token = await getToken();
    if (!token) return;
    const price = Number(String(form.get("price") ?? "0").replace(",", "."));
    const quoteServiceCode = String(form.get("quote_service_code") ?? "");
    const quoteService = QUOTE_SERVICE_OPTIONS.find((option) => option.value === quoteServiceCode);
    const pickupWaypoints = parseWaypointList(form.get("pickup_waypoints"));
    const dropoffWaypoints = parseWaypointList(form.get("dropoff_waypoints"));
    const res = await apiCall(token, {
      action: "create_quote",
      quote_service_code: quoteService?.value ?? "transfer_port_hotel",
      quote_bus_line_id: quoteService?.value === "bus_city_hotel" ? String(form.get("quote_bus_line_id") ?? "") || null : null,
      service_kind: quoteService?.label ?? "Transfer porto - hotel",
      route_label: String(form.get("route_label") ?? ""),
      price_cents: Math.round(price * 100),
      currency: "EUR",
      passenger_count: form.get("passenger_count") ? Number(form.get("passenger_count")) : null,
      arrival_date: String(form.get("arrival_date") ?? "") || null,
      departure_date: String(form.get("departure_date") ?? "") || null,
      valid_until: String(form.get("valid_until") ?? "") || null,
      notes: String(form.get("notes") ?? "") || null,
      client_name: String(form.get("client_name") ?? "") || null,
      client_email: String(form.get("client_email") ?? "") || null,
      pickup_waypoints: pickupWaypoints,
      dropoff_waypoints: dropoffWaypoints,
    });
    if (!res.ok) {
      setMessage({ type: "err", text: res.error ?? "Errore." });
      return;
    }
    setQuotes(res.quotes ?? []);
    setWaypoints(res.waypoints ?? []);
    setMessage({ type: "ok", text: "Preventivo creato." });
    setArrivalDate("");
    setDepartureDate("");
    setValidUntil("");
    setSelectedServiceCode("transfer_port_hotel");
    formElement.reset();
  };

  const sendQuote = async (quoteId: string) => {
    const token = await getToken();
    if (!token) return;
    setSending(quoteId);
    const res = await apiCall(token, { action: "send_quote", quote_id: quoteId });
    setSending(null);
    if (!res.ok) {
      setMessage({ type: "err", text: res.error ?? "Invio fallito." });
      return;
    }
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
    if (!res.ok) {
      setMessage({ type: "err", text: res.error ?? "Errore." });
      return;
    }
    setQuotes(res.quotes ?? []);
    setMessage({ type: "ok", text: "Preventivo eliminato." });
  };

  const updateStatus = async (quoteId: string, status: string) => {
    const token = await getToken();
    if (!token) return;
    const res = await apiCall(token, { action: "update_status", quote_id: quoteId, status });
    if (!res.ok) {
      setMessage({ type: "err", text: res.error ?? "Errore." });
      return;
    }
    setQuotes(res.quotes ?? []);
  };

  if (accessDenied) {
    return (
      <section className="page-section">
        <PageHeader title="Preventivi" breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Preventivi" }]} />
        <div className="card p-6 text-sm text-slate-500">Accesso non abilitato per questo utente.</div>
      </section>
    );
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Preventivi"
        subtitle="Crea bozze chiare, inviale al cliente e segui l'esito senza uscire dalla schermata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Preventivi" }]}
      />

      {message ? (
        <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm font-medium ${message.type === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="rounded-md px-2 py-1 text-current opacity-60 hover:bg-white/60 hover:opacity-100">
            Chiudi
          </button>
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-5">
        {[
          { label: "Totale", value: totals.total, hint: "Preventivi creati" },
          { label: "Bozze", value: totals.draft, hint: "Da completare" },
          { label: "Inviati", value: totals.sent, hint: "In attesa cliente" },
          { label: "Accettati", value: totals.accepted, hint: "Confermati" },
          { label: "Valore", value: formatCurrency(totals.value), hint: "Pipeline non rifiutata" },
        ].map((k) => (
          <article key={k.label} className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_12px_30px_rgba(15,23,42,0.06)]">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{k.label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-slate-950">{k.value}</p>
            <p className="mt-1 text-xs text-slate-500">{k.hint}</p>
          </article>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[440px_minmax(0,1fr)]">
        <SectionCard
          title="Nuovo preventivo"
          subtitle="I campi essenziali sono pronti per creare una bozza ordinata."
          className="rounded-lg border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
        >
          <form className="space-y-4" onSubmit={createQuote}>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Cliente</p>
              <div className="mt-2 grid gap-2">
                <input name="client_name" className="input-saas w-full" placeholder="Nome cliente o azienda" />
                <input name="client_email" type="email" className="input-saas w-full" placeholder="email@cliente.it" />
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Tipo servizio*
                <select
                  name="quote_service_code"
                  required
                  value={selectedServiceCode}
                  onChange={(event) => setSelectedServiceCode(event.target.value)}
                  className="mt-1 input-saas w-full"
                >
                  {QUOTE_SERVICE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {selectedServiceCode === "bus_city_hotel" ? (
                <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                  Linea bus
                  <select
                    name="quote_bus_line_id"
                    value={selectedBusLineId}
                    onChange={(event) => setSelectedBusLineId(event.target.value)}
                    className="mt-1 input-saas w-full"
                  >
                    {busLines.length === 0 ? <option value="">Nessuna linea configurata</option> : null}
                    {busLines.map((line) => (
                      <option key={line.id} value={line.id}>
                        {line.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Tratta*
                <input name="route_label" required className="mt-1 input-saas w-full" placeholder="Napoli - Forio" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Prezzo EUR*
                <input name="price" required inputMode="decimal" className="mt-1 input-saas w-full" placeholder="120,00" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Pax
                <input name="passenger_count" type="number" min={1} className="mt-1 input-saas w-full" placeholder="4" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Data arrivo
                <DateInput name="arrival_date" value={arrivalDate} onChange={setArrivalDate} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Data partenza
                <DateInput name="departure_date" value={departureDate} onChange={setDepartureDate} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Validita offerta
                <DateInput name="valid_until" value={validUntil} onChange={setValidUntil} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Punti di carico
                <textarea name="pickup_waypoints" rows={3} className="mt-1 input-saas w-full resize-none" placeholder="Uno per riga oppure separati da virgola" />
                {selectedServiceCode === "bus_city_hotel" && selectedBusLineId ? (
                  <span className="mt-1 block text-[11px] normal-case tracking-normal text-slate-400">
                    Dal DB: {busStops.filter((stop) => stop.bus_line_id === selectedBusLineId && stop.direction === "arrival").slice(0, 5).map((stop) => stop.stop_name).join(", ") || "nessuna fermata arrivo"}
                  </span>
                ) : null}
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
                Punti di scarico
                <textarea name="dropoff_waypoints" rows={3} className="mt-1 input-saas w-full resize-none" placeholder="Hotel, porto, aeroporto..." />
                {selectedServiceCode === "bus_city_hotel" && selectedBusLineId ? (
                  <span className="mt-1 block text-[11px] normal-case tracking-normal text-slate-400">
                    Dal DB: {busStops.filter((stop) => stop.bus_line_id === selectedBusLineId && stop.direction === "departure").slice(0, 5).map((stop) => stop.stop_name).join(", ") || "nessuna fermata partenza"}
                  </span>
                ) : null}
              </label>
              <label className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500 sm:col-span-2">
                Note
                <textarea name="notes" rows={4} className="mt-1 input-saas w-full resize-none" placeholder="Orari, bagagli, richieste particolari..." />
              </label>
            </div>

            <button type="submit" className="btn-primary w-full py-2.5">
              Crea preventivo
            </button>
          </form>
        </SectionCard>

        <SectionCard
          title="Preventivi"
          subtitle={`${filtered.length} visibili su ${quotes.length} totali`}
          loading={loading}
          loadingLines={4}
          className="rounded-lg border border-slate-200 shadow-[0_18px_50px_rgba(15,23,42,0.08)]"
          actions={
            <div className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setFilterStatus(status)}
                  className={`rounded-lg border px-3 py-1 text-[11px] font-semibold transition ${
                    filterStatus === status
                      ? "border-slate-900 bg-slate-900 text-white"
                      : "border-slate-200 bg-white text-slate-600 hover:border-slate-400"
                  }`}
                >
                  {status === "all" ? "Tutti" : STATUS_CONFIG[status]?.label ?? status}
                </button>
              ))}
            </div>
          }
        >
          {filtered.length === 0 ? (
            <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50 px-6 text-center">
              <div>
                <p className="text-base font-semibold text-slate-900">Nessun preventivo in questa vista</p>
                <p className="mt-2 max-w-md text-sm text-slate-500">
                  Crea una bozza dal modulo a sinistra. Quando inserisci l&apos;email cliente potrai inviarla direttamente da qui.
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((quote) => {
                const cfg = STATUS_CONFIG[quote.status] ?? STATUS_CONFIG.draft;
                const quoteWaypoints = waypoints.filter((waypoint) => waypoint.quote_id === quote.id);
                const pickupWaypoints = quoteWaypoints.filter((waypoint) => (waypoint.waypoint_type ?? "pickup") === "pickup").map((waypoint) => waypoint.label);
                const dropoffWaypoints = quoteWaypoints.filter((waypoint) => waypoint.waypoint_type === "dropoff").map((waypoint) => waypoint.label);
                return (
                  <article key={quote.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-[0_10px_24px_rgba(15,23,42,0.05)]">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-base font-semibold text-slate-950">{quote.route_label}</p>
                          <span
                            style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}` }}
                            className="rounded-full px-2.5 py-0.5 text-[10px] font-bold"
                          >
                            {cfg.label}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {quote.service_kind} - {quoteOwnerLabel(quote)}
                        </p>
                      </div>
                      <p className="text-xl font-semibold tracking-[-0.02em] text-slate-950">{formatCurrency(quote.price_cents, quote.currency)}</p>
                    </div>

                    <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-5">
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Pax</span>
                        <span className="mt-1 block font-semibold text-slate-800">{quote.passenger_count ?? "N/D"}</span>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Arrivo</span>
                        <span className="mt-1 block font-semibold text-slate-800">{formatDate(quote.arrival_date, "N/D")}</span>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Partenza</span>
                        <span className="mt-1 block font-semibold text-slate-800">{formatDate(quote.departure_date, "N/D")}</span>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Validita</span>
                        <span className="mt-1 block font-semibold text-slate-800">{formatDate(quote.valid_until)}</span>
                      </div>
                      <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Creato</span>
                        <span className="mt-1 block font-semibold text-slate-800">{formatDate(quote.created_at)}</span>
                      </div>
                    </div>

                    {pickupWaypoints.length > 0 || dropoffWaypoints.length > 0 ? (
                      <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                        {pickupWaypoints.length > 0 ? (
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Carico</span>
                            <span className="mt-1 block">{pickupWaypoints.join(" - ")}</span>
                          </div>
                        ) : null}
                        {dropoffWaypoints.length > 0 ? (
                          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                            <span className="block text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-400">Scarico</span>
                            <span className="mt-1 block">{dropoffWaypoints.join(" - ")}</span>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {quote.notes ? <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{quote.notes}</p> : null}

                    <div className="mt-4 flex flex-wrap gap-2">
                      {quote.status === "draft" && quote.client_email ? (
                        <button
                          type="button"
                          onClick={() => void sendQuote(quote.id)}
                          disabled={sending === quote.id}
                          className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-100 disabled:opacity-50"
                        >
                          {sending === quote.id ? "Invio..." : "Invia email"}
                        </button>
                      ) : null}
                      {quote.status === "draft" && !quote.client_email ? (
                        <span className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800">
                          Email cliente mancante
                        </span>
                      ) : null}
                      {quote.status === "sent" ? (
                        <>
                          <button type="button" onClick={() => void updateStatus(quote.id, "accepted")} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-100">
                            Segna accettato
                          </button>
                          <button type="button" onClick={() => void updateStatus(quote.id, "rejected")} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-100">
                            Segna rifiutato
                          </button>
                        </>
                      ) : null}
                      {quote.status === "accepted" || quote.status === "rejected" ? (
                        <button type="button" onClick={() => void updateStatus(quote.id, "draft")} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-100">
                          Riporta a bozza
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => void deleteQuote(quote.id)}
                        disabled={deleting === quote.id}
                        className="ml-auto rounded-lg border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
                      >
                        {deleting === quote.id ? "..." : "Elimina"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </section>
  );
}
