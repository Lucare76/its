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
  created_at: string;
};

type QuoteWaypoint = { id: string; quote_id: string; label: string; sort_order: number };
type QuoteUser = { user_id: string; feature_code: string; enabled: boolean };

async function token() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export default function PreventivoOpsPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [waypoints, setWaypoints] = useState<QuoteWaypoint[]>([]);
  const [quoteUsers, setQuoteUsers] = useState<QuoteUser[]>([]);
  const [message, setMessage] = useState("Area preventivi operativi. Utente dedicato: Owen.");

  const load = useEffectEvent(async () => {
    const accessToken = await token();
    if (!accessToken) {
      setMessage("Sessione non valida.");
      return;
    }
    const response = await fetch("/api/ops/quotes", { headers: { Authorization: `Bearer ${accessToken}` } });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[]; quote_users?: QuoteUser[] } | null;
    if (!response.ok || !body?.ok) {
      setMessage(body?.error ?? "Errore caricamento preventivi.");
      return;
    }
    setQuotes(body.quotes ?? []);
    setWaypoints(body.waypoints ?? []);
    setQuoteUsers(body.quote_users ?? []);
  });

  useEffect(() => {
    void load();
  }, []);

  const totals = useMemo(
    () => ({
      total: quotes.length,
      draft: quotes.filter((item) => item.status === "draft").length,
      sent: quotes.filter((item) => item.status === "sent").length,
      value: quotes.reduce((sum, item) => sum + item.price_cents, 0)
    }),
    [quotes]
  );

  const createQuote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const accessToken = await token();
    if (!accessToken) return;
    const form = new FormData(event.currentTarget);
    const price = Number(String(form.get("price") ?? "0").replace(",", "."));
    const waypointList = String(form.get("waypoints") ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const response = await fetch("/api/ops/quotes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        action: "create_quote",
        service_kind: String(form.get("service_kind") ?? ""),
        route_label: String(form.get("route_label") ?? ""),
        price_cents: Math.round(price * 100),
        currency: "EUR",
        passenger_count: form.get("passenger_count") ? Number(form.get("passenger_count")) : null,
        valid_until: String(form.get("valid_until") ?? "") || null,
        notes: String(form.get("notes") ?? "") || null,
        waypoints: waypointList
      })
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; quotes?: Quote[]; waypoints?: QuoteWaypoint[]; quote_users?: QuoteUser[] } | null;
    if (!response.ok || !body?.ok) {
      setMessage(body?.error ?? "Preventivo non creato.");
      return;
    }
    setQuotes(body.quotes ?? []);
    setWaypoints(body.waypoints ?? []);
    setQuoteUsers(body.quote_users ?? []);
    setMessage("Preventivo creato.");
    event.currentTarget.reset();
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Preventivi Operativi"
        subtitle="Workspace semplice per Owen / ufficio preventivi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Preventivi" }]}
      />

      <p className="text-sm text-muted">{message}</p>

      <div className="grid gap-3 md:grid-cols-4">
        <SectionCard title="Preventivi"><p className="text-3xl font-semibold text-text">{totals.total}</p></SectionCard>
        <SectionCard title="Bozze"><p className="text-3xl font-semibold text-text">{totals.draft}</p></SectionCard>
        <SectionCard title="Inviati"><p className="text-3xl font-semibold text-text">{totals.sent}</p></SectionCard>
        <SectionCard title="Valore"><p className="text-3xl font-semibold text-text">€ {(totals.value / 100).toFixed(2)}</p></SectionCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <SectionCard title="Nuovo preventivo" subtitle="Form rapido con punti di carico multipli">
          <form className="space-y-3" onSubmit={createQuote}>
            <div className="grid gap-2 md:grid-cols-2">
              <input name="service_kind" className="input-saas" placeholder="Tipo servizio" />
              <input name="route_label" className="input-saas" placeholder="Tratta" />
              <input name="price" className="input-saas" placeholder="Prezzo" />
              <input name="passenger_count" className="input-saas" type="number" min={1} placeholder="Pax" />
              <input name="valid_until" className="input-saas" type="date" />
              <input name="waypoints" className="input-saas" placeholder="Punti di carico multipli separati da virgola" />
              <textarea name="notes" className="input-saas md:col-span-2 min-h-[96px]" placeholder="Note operative" />
            </div>
            <button type="submit" className="btn-primary px-4 py-2 text-sm">Crea preventivo</button>
          </form>
        </SectionCard>

        <SectionCard title="Storico preventivi" subtitle="Proprietario logico Owen">
          <div className="space-y-3">
            {quotes.map((quote) => (
              <article key={quote.id} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{quote.service_kind} | {quote.route_label}</p>
                  <span>{quote.status}</span>
                </div>
                <p className="text-muted">€ {(quote.price_cents / 100).toFixed(2)} | validita {quote.valid_until ?? "aperta"} | owner {quote.owner_label}</p>
                <p className="text-muted">{quote.notes ?? "Nessuna nota"}</p>
                <p className="mt-2 text-xs text-muted">
                  Waypoints: {waypoints.filter((item) => item.quote_id === quote.id).map((item) => item.label).join(" | ") || "nessuno"}
                </p>
              </article>
            ))}
            {quotes.length === 0 ? <p className="text-sm text-muted">Nessun preventivo creato.</p> : null}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Accesso Owen" subtitle="Feature flag dedicata ai preventivi">
        <p className="text-sm text-muted">
          Accessi quote attivi: {quoteUsers.filter((item) => item.enabled).length}. Per ora il workspace e pronto lato dati e API; il flag dedicato
          `quotes_access` puo essere assegnato dal backend/admin.
        </p>
      </SectionCard>
    </section>
  );
}
