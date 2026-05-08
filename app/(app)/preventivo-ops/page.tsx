"use client";

import { FormEvent, useEffect, useEffectEvent, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { BUS_LINES_2026 } from "@/lib/bus-lines-catalog";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";

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
  hotel_name?: string | null;
  bus_city_origin?: string | null;
  bus_city_lat?: number | null;
  bus_city_lng?: number | null;
  bus_city_geo_label?: string | null;
  created_at: string;
};

type QuoteWaypoint = { id: string; quote_id: string; label: string; sort_order: number };
type CitySuggestion = { name: string; label: string; lat: number | null; lng: number | null; source: "catalog" | "geo" };

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; border: string }> = {
  draft:    { label: "Bozza",     bg: "#f8fafc", color: "#64748b", border: "#e2e8f0" },
  sent:     { label: "Inviato",   bg: "#eff6ff", color: "#1d4ed8", border: "#bfdbfe" },
  accepted: { label: "Accettato", bg: "#f0fdf4", color: "#166534", border: "#bbf7d0" },
  rejected: { label: "Rifiutato", bg: "#fef2f2", color: "#991b1b", border: "#fecaca" },
  expired:  { label: "Scaduto",   bg: "#fafafa", color: "#9ca3af", border: "#e5e7eb" },
};

const SERVICE_KIND_OPTIONS = [
  "Formula SNAV",
  "Formula MEDMAR - Napoli",
  "Formula MEDMAR - Pozzuoli",
  "Transfer aeroporto - hotel",
  "Transfer aeroporto - hotel (esclusivo)",
  "Transfer aeroporto - hotel (aliscafo)",
  "Transfer stazione / bus - hotel",
  "Transfer stazione / bus - hotel (esclusivo)",
  "Transfer stazione / bus - hotel (aliscafo)",
  "Linea bus - hotel",
  "Escursione",
  "Transfer porto - hotel",
  "Disposizione H24",
] as const;

const DISPO_PREFIX = "__dispo__:";

function normalizeCity(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleCity(value: string) {
  return value.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
}

const CATALOG_CITY_SUGGESTIONS: CitySuggestion[] = Array.from(
  BUS_LINES_2026
    .flatMap((line) => line.stops.map((stop) => ({ stop, line })))
    .reduce((map, item) => {
      const key = normalizeCity(item.stop.city);
      if (!key || map.has(key)) return map;
      map.set(key, {
        name: titleCity(item.stop.city),
        label: `${titleCity(item.stop.city)} - ${item.stop.pickupNote ?? item.line.name}`,
        lat: item.stop.lat ?? null,
        lng: item.stop.lng ?? null,
        source: "catalog" as const,
      });
      return map;
    }, new Map<string, CitySuggestion>())
    .values()
).sort((a, b) => a.name.localeCompare(b.name, "it"));

function isBusQuote(serviceKind: string) {
  return normalizeCity(serviceKind).includes("linea bus") || normalizeCity(serviceKind) === "bus";
}

function isDispoQuote(serviceKind: string) {
  return serviceKind === "Disposizione H24";
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
  const [serviceKind, setServiceKind] = useState<(typeof SERVICE_KIND_OPTIONS)[number]>("Transfer porto - hotel");
  const [routeLabel, setRouteLabel] = useState("");
  const [busCityInput, setBusCityInput] = useState("");
  const [selectedBusCity, setSelectedBusCity] = useState<CitySuggestion | null>(null);
  const [geoSuggestions, setGeoSuggestions] = useState<CitySuggestion[]>([]);
  const [cityLookupLoading, setCityLookupLoading] = useState(false);

  // Dispo H24 state
  const [dispoVehicleType, setDispoVehicleType] = useState("Van");
  const [dispoVehicleCount, setDispoVehicleCount] = useState(2);
  const [dispoDateFrom, setDispoDateFrom] = useState("");
  const [dispoDateTo, setDispoDateTo] = useState("");
  const [dispoTotalDays, setDispoTotalDays] = useState(6);
  const [dispoTimeFrom, setDispoTimeFrom] = useState("");
  const [dispoTimeTo, setDispoTimeTo] = useState("");
  const [dispoRateDay, setDispoRateDay] = useState(50);
  const [dispoRateNight, setDispoRateNight] = useState(60);
  const [dispoPricePerVehicle, setDispoPricePerVehicle] = useState(0);
  const [dispoIncludeAccommodation, setDispoIncludeAccommodation] = useState(false);

  const load = useEffectEvent(async () => {
    setLoading(true);
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch("/api/ops/quotes", { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[] };
    if (res.status === 401) {
      await supabase?.auth.signOut();
      window.location.href = "/login";
      return;
    }
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
  const busSelected = isBusQuote(serviceKind);
  const dispoSelected = isDispoQuote(serviceKind);
  const dispoTotalPrice = dispoPricePerVehicle * dispoVehicleCount;
  const localCitySuggestions = useMemo(() => {
    const query = normalizeCity(busCityInput);
    if (query.length < 2) return [];
    return CATALOG_CITY_SUGGESTIONS
      .filter((item) => normalizeCity(item.name).includes(query))
      .slice(0, 6);
  }, [busCityInput]);
  const citySuggestions = useMemo(() => {
    const seen = new Set<string>();
    return [...localCitySuggestions, ...geoSuggestions]
      .filter((item) => {
        const key = normalizeCity(item.name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  }, [geoSuggestions, localCitySuggestions]);

  useEffect(() => {
    if (!busSelected || busCityInput.trim().length < 2 || selectedBusCity?.name === busCityInput.trim()) {
      setGeoSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCityLookupLoading(true);
      try {
        const response = await fetch(`/api/geocode/comuni?q=${encodeURIComponent(busCityInput.trim())}`, { signal: controller.signal });
        const body = (await response.json().catch(() => null)) as {
          results?: Array<{ shortName: string; displayName: string; lat: number; lng: number }>;
        } | null;
        setGeoSuggestions((body?.results ?? []).map((item) => ({
          name: item.shortName,
          label: item.displayName,
          lat: item.lat,
          lng: item.lng,
          source: "geo" as const,
        })));
      } catch {
        if (!controller.signal.aborted) setGeoSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setCityLookupLoading(false);
      }
    }, 250);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [busCityInput, busSelected, selectedBusCity?.name]);

  const resolveBusCity = async () => {
    const city = busCityInput.trim();
    if (!city) return null;
    const exactLocal = CATALOG_CITY_SUGGESTIONS.find((item) => normalizeCity(item.name) === normalizeCity(city));
    if (exactLocal) return exactLocal;
    if (selectedBusCity && normalizeCity(selectedBusCity.name) === normalizeCity(city)) return selectedBusCity;
    const exactGeo = geoSuggestions.find((item) => normalizeCity(item.name) === normalizeCity(city));
    if (exactGeo) return exactGeo;

    setCityLookupLoading(true);
    try {
      const response = await fetch(`/api/geocode/comuni?q=${encodeURIComponent(city)}`);
      const body = (await response.json().catch(() => null)) as {
        results?: Array<{ shortName: string; displayName: string; lat: number; lng: number }>;
      } | null;
      const first = body?.results?.[0];
      if (!first) return null;
      return {
        name: first.shortName,
        label: first.displayName,
        lat: first.lat,
        lng: first.lng,
        source: "geo" as const,
      };
    } finally {
      setCityLookupLoading(false);
    }
  };

  const resetDispoState = () => {
    setDispoVehicleType("Van");
    setDispoVehicleCount(2);
    setDispoDateFrom("");
    setDispoDateTo("");
    setDispoTotalDays(6);
    setDispoTimeFrom("");
    setDispoTimeTo("");
    setDispoRateDay(50);
    setDispoRateNight(60);
    setDispoPricePerVehicle(0);
    setDispoIncludeAccommodation(false);
  };

  // Calcolo automatico prezzo per mezzo da fasce orarie
  const dispoAutoCalc = useMemo(() => {
    if (!dispoTimeFrom || !dispoTimeTo || !dispoTotalDays) return null;
    const [fh = 0, fm = 0] = dispoTimeFrom.split(":").map(Number);
    const [th = 0, tm = 0] = dispoTimeTo.split(":").map(Number);
    let start = fh * 60 + fm;
    let end = th * 60 + tm;
    if (end <= start) end += 24 * 60;
    const SLOT = 15;
    let costPerDay = 0;
    for (let t = start; t < end; t += SLOT) {
      const midHour = Math.floor(((t + SLOT / 2) % (24 * 60)) / 60);
      const isNight = midHour < 7 || midHour >= 22;
      costPerDay += (isNight ? dispoRateNight : dispoRateDay) * (SLOT / 60);
    }
    return Math.round(costPerDay * dispoTotalDays * 100) / 100;
  }, [dispoTimeFrom, dispoTimeTo, dispoTotalDays, dispoRateDay, dispoRateNight]);

  const createQuote = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const token = await getToken();
    if (!token) return;
    const form = new FormData(formEl);

    if (dispoSelected) {
      if (dispoTotalPrice <= 0) {
        setMessage({ type: "err", text: "Inserisci un prezzo per mezzo valido." });
        return;
      }
      const dispoData = {
        vehicleType: dispoVehicleType.trim() || "Van",
        vehicleCount: dispoVehicleCount,
        dateFrom: dispoDateFrom.trim(),
        dateTo: dispoDateTo.trim(),
        totalDays: dispoTotalDays,
        ...(dispoTimeFrom && dispoTimeTo ? { timeFrom: dispoTimeFrom, timeTo: dispoTimeTo } : {}),
        rateDay: dispoRateDay,
        rateNight: dispoRateNight,
        pricePerVehicle: dispoPricePerVehicle,
        includeAccommodation: dispoIncludeAccommodation,
        customNotes: String(form.get("notes") ?? "").trim() || undefined,
      };
      const timeLabel = dispoTimeFrom && dispoTimeTo ? ` · ${dispoTimeFrom}–${dispoTimeTo}` : " · H24";
      const routeLabelDispo = `${dispoData.dateFrom}–${dispoData.dateTo} · ${dispoData.vehicleCount} ${dispoData.vehicleType}${timeLabel}`;
      const res = await apiCall(token, {
        action: "create_quote",
        service_kind: serviceKind,
        route_label: routeLabelDispo,
        price_cents: Math.round(dispoTotalPrice * 100),
        currency: "EUR",
        passenger_count: dispoVehicleCount,
        valid_until: String(form.get("valid_until") ?? "") || null,
        notes: `${DISPO_PREFIX}${JSON.stringify(dispoData)}`,
        client_name: String(form.get("client_name") ?? "") || null,
        client_email: String(form.get("client_email") ?? "") || null,
        hotel_name: null,
        bus_city_origin: null,
        bus_city_lat: null,
        bus_city_lng: null,
        bus_city_geo_label: null,
        waypoints: [],
      });
      if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Errore." }); return; }
      setQuotes(res.quotes ?? []);
      setWaypoints(res.waypoints ?? []);
      setMessage({ type: "ok", text: "Preventivo creato." });
      formEl.reset();
      setServiceKind("Transfer porto - hotel");
      resetDispoState();
      return;
    }

    const busCity = busSelected ? await resolveBusCity() : null;
    if (busSelected && !busCity) {
      setMessage({ type: "err", text: "Inserisci una citta di partenza valida: deve essere selezionata o geolocalizzata." });
      return;
    }
    const price = Number(String(form.get("price") ?? "0").replace(",", "."));
    const waypointList = String(form.get("waypoints") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const finalRouteLabel = busSelected && busCity && !routeLabel.trim()
      ? `${busCity.name.toUpperCase()} - ISCHIA`
      : routeLabel.trim();
    const res = await apiCall(token, {
      action: "create_quote",
      service_kind: serviceKind,
      route_label: finalRouteLabel,
      price_cents: Math.round(price * 100),
      currency: "EUR",
      passenger_count: form.get("passenger_count") ? Number(form.get("passenger_count")) : null,
      valid_until: String(form.get("valid_until") ?? "") || null,
      notes: String(form.get("notes") ?? "") || null,
      client_name: String(form.get("client_name") ?? "") || null,
      client_email: String(form.get("client_email") ?? "") || null,
      hotel_name: String(form.get("hotel_name") ?? "") || null,
      bus_city_origin: busCity?.name ?? null,
      bus_city_lat: busCity?.lat ?? null,
      bus_city_lng: busCity?.lng ?? null,
      bus_city_geo_label: busCity?.label ?? null,
      waypoints: busCity ? [busCity.name, ...waypointList.filter((item) => normalizeCity(item) !== normalizeCity(busCity.name))] : waypointList,
    });
    if (!res.ok) { setMessage({ type: "err", text: res.error ?? "Errore." }); return; }
    setQuotes(res.quotes ?? []);
    setWaypoints(res.waypoints ?? []);
    setMessage({ type: "ok", text: "Preventivo creato." });
    formEl.reset();
    setServiceKind("Transfer porto - hotel");
    setRouteLabel("");
    setBusCityInput("");
    setSelectedBusCity(null);
    setGeoSuggestions([]);
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
                <select name="service_kind" required value={serviceKind} onChange={(event) => {
                  const nextServiceKind = event.target.value as (typeof SERVICE_KIND_OPTIONS)[number];
                  setServiceKind(nextServiceKind);
                  if (!isBusQuote(event.target.value)) {
                    setBusCityInput("");
                    setSelectedBusCity(null);
                  }
                  if (!isDispoQuote(event.target.value)) resetDispoState();
                }} className="mt-1 input-saas w-full">
                  {SERVICE_KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>{kind}</option>
                  ))}
                </select>
              </label>
              {!dispoSelected && (
                <label className="text-xs font-medium text-slate-600">
                  Tratta{busSelected ? "" : "*"}
                  <input name="route_label" required={!busSelected} value={routeLabel} onChange={(event) => setRouteLabel(event.target.value)} className="mt-1 input-saas w-full" placeholder={busSelected ? "auto: citta - Ischia" : "es. Napoli - Forio"} />
                </label>
              )}
              {!dispoSelected && (
                <label className="text-xs font-medium text-slate-600 sm:col-span-2">
                  Hotel / struttura
                  <input name="hotel_name" className="mt-1 input-saas w-full" placeholder="Nome hotel o struttura cliente" />
                </label>
              )}
              {dispoSelected && (
                <div className="sm:col-span-2 rounded-xl border border-blue-100 bg-blue-50/40 p-3 space-y-2">
                  <p className="text-[11px] font-bold text-blue-700 uppercase tracking-wide">Dettaglio disposizione H24</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <label className="text-xs font-medium text-slate-600">
                      Tipo mezzo*
                      <input value={dispoVehicleType} onChange={(ev) => setDispoVehicleType(ev.target.value)} className="mt-1 input-saas w-full" placeholder="Van, Minivan, Bus…" required />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      N. mezzi*
                      <input type="number" min={1} max={20} value={dispoVehicleCount} onChange={(ev) => setDispoVehicleCount(Number(ev.target.value))} className="mt-1 input-saas w-full" required />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Dal (es. 01/06)
                      <input value={dispoDateFrom} onChange={(ev) => setDispoDateFrom(ev.target.value)} className="mt-1 input-saas w-full" placeholder="01/06" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Al (es. 06/06)
                      <input value={dispoDateTo} onChange={(ev) => setDispoDateTo(ev.target.value)} className="mt-1 input-saas w-full" placeholder="06/06" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      N. giorni*
                      <input type="number" min={1} value={dispoTotalDays} onChange={(ev) => setDispoTotalDays(Number(ev.target.value))} className="mt-1 input-saas w-full" required />
                    </label>
                    <div />
                    <label className="text-xs font-medium text-slate-600">
                      Orario inizio (es. 08:00)
                      <input type="time" value={dispoTimeFrom} onChange={(ev) => setDispoTimeFrom(ev.target.value)} className="mt-1 input-saas w-full" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Orario fine (es. 22:00)
                      <input type="time" value={dispoTimeTo} onChange={(ev) => setDispoTimeTo(ev.target.value)} className="mt-1 input-saas w-full" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Tariffa diurna (€/h)
                      <input type="number" min={0} step={1} value={dispoRateDay} onChange={(ev) => setDispoRateDay(Number(ev.target.value))} className="mt-1 input-saas w-full" placeholder="50" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Tariffa notturna (€/h)
                      <input type="number" min={0} step={1} value={dispoRateNight} onChange={(ev) => setDispoRateNight(Number(ev.target.value))} className="mt-1 input-saas w-full" placeholder="60" />
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Prezzo per 1 mezzo (€)*
                      <input type="number" min={0} step={0.01} value={dispoPricePerVehicle || ""} onChange={(ev) => setDispoPricePerVehicle(Number(ev.target.value))} className="mt-1 input-saas w-full" placeholder="es. 7500" required />
                      {dispoAutoCalc !== null && dispoAutoCalc !== dispoPricePerVehicle && (
                        <button type="button" onClick={() => setDispoPricePerVehicle(dispoAutoCalc)}
                          className="mt-1 text-[11px] text-blue-600 hover:underline">
                          Usa calcolo automatico: €{dispoAutoCalc.toLocaleString("it-IT", { minimumFractionDigits: 2 })}
                        </button>
                      )}
                    </label>
                    <label className="text-xs font-medium text-slate-600">
                      Totale complessivo
                      <input readOnly value={`€ ${dispoTotalPrice.toLocaleString("it-IT", { minimumFractionDigits: 2 })}`} className="mt-1 input-saas w-full cursor-default opacity-75 font-semibold" tabIndex={-1} />
                    </label>
                    <label className="sm:col-span-2 flex items-center gap-2 text-xs font-medium text-slate-600 cursor-pointer mt-1">
                      <input type="checkbox" checked={dispoIncludeAccommodation} onChange={(ev) => setDispoIncludeAccommodation(ev.target.checked)} className="rounded" />
                      Sistemazione autisti inclusa nel preventivo
                    </label>
                  </div>
                </div>
              )}
              {busSelected && (
                <label className="relative text-xs font-medium text-slate-600 sm:col-span-2">
                  Citta di partenza*
                  <input
                    name="bus_city_origin"
                    required
                    autoComplete="off"
                    value={busCityInput}
                    onChange={(event) => {
                      setBusCityInput(event.target.value);
                      setSelectedBusCity(null);
                      setRouteLabel(event.target.value.trim() ? `${event.target.value.trim().toUpperCase()} - ISCHIA` : "");
                    }}
                    onBlur={() => {
                      window.setTimeout(() => {
                        if (!routeLabel.trim() && busCityInput.trim()) setRouteLabel(`${busCityInput.trim().toUpperCase()} - ISCHIA`);
                      }, 120);
                    }}
                    className="mt-1 input-saas w-full"
                    placeholder="Digita una citta: Perugia, Milano, Ravenna..."
                  />
                  {busCityInput.trim().length >= 2 && citySuggestions.length > 0 && !selectedBusCity && (
                    <div className="absolute left-0 right-0 z-20 mt-1 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                      {citySuggestions.map((item) => (
                        <button
                          key={`${item.source}-${item.name}-${item.lat ?? "n"}`}
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setBusCityInput(item.name);
                            setSelectedBusCity(item);
                            setRouteLabel(`${item.name.toUpperCase()} - ISCHIA`);
                          }}
                          className="flex w-full items-start justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-slate-50"
                        >
                          <span>
                            <span className="block font-semibold text-slate-800">{item.name}</span>
                            <span className="block text-slate-500">{item.label}</span>
                          </span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${item.source === "catalog" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700"}`}>
                            {item.source === "catalog" ? "fermata" : "nuova"}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="mt-1 block text-[11px] text-slate-400">
                    {selectedBusCity
                      ? `Geolocalizzata: ${selectedBusCity.lat?.toFixed(4) ?? "lat n/d"}, ${selectedBusCity.lng?.toFixed(4) ?? "lng n/d"}`
                      : cityLookupLoading
                        ? "Cerco la citta..."
                        : "Se non compare tra le fermate, puoi inserirla come nuova e verra geolocalizzata."}
                  </span>
                </label>
              )}
              {!dispoSelected && (
                <label className="text-xs font-medium text-slate-600">
                  Prezzo EUR*
                  <input name="price" required className="mt-1 input-saas w-full" placeholder="es. 120.00" />
                </label>
              )}
              {!dispoSelected && (
                <label className="text-xs font-medium text-slate-600">
                  Pax
                  <input name="passenger_count" type="number" min={1} className="mt-1 input-saas w-full" placeholder="es. 4" />
                </label>
              )}
              <label className="text-xs font-medium text-slate-600">
                Validità offerta
                <input name="valid_until" type="date" className="mt-1 input-saas w-full" />
              </label>
              {!dispoSelected && (
                <label className="text-xs font-medium text-slate-600">
                  Punti di carico
                  <input name="waypoints" className="mt-1 input-saas w-full" placeholder="Luogo1, Luogo2..." />
                </label>
              )}
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
                        {q.hotel_name && (
                          <p className="mt-0.5 text-xs text-slate-500">Hotel: {q.hotel_name}</p>
                        )}
                        {q.bus_city_origin && (
                          <p className="mt-0.5 text-xs text-slate-500">Partenza bus: {q.bus_city_origin}{q.bus_city_geo_label ? ` · ${q.bus_city_geo_label}` : ""}</p>
                        )}
                      </div>
                      <p className="text-lg font-bold text-slate-900 shrink-0">{q.currency} {(q.price_cents / 100).toFixed(2)}</p>
                    </div>
                    <div className="flex flex-wrap gap-3 text-xs text-slate-500">
                      {q.passenger_count && <span>👥 {q.passenger_count} pax</span>}
                      {q.valid_until && <span>📅 Valido fino al {fmtDate(q.valid_until)}</span>}
                      {qWaypoints.length > 0 && <span>📍 {qWaypoints.join(" → ")}</span>}
                      <span>Creato {fmtDate(q.created_at)}</span>
                    </div>
                    {q.notes && !q.notes.startsWith(DISPO_PREFIX) && (
                      <p className="text-xs text-slate-500 italic">{q.notes}</p>
                    )}
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
                          {q.client_email && (
                            <button onClick={() => void sendQuote(q.id)} disabled={sending === q.id}
                              className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition">
                              {sending === q.id ? "Invio..." : "🔁 Reinvia email"}
                            </button>
                          )}
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
