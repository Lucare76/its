"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

type AgencyRow = {
  id: string;
  name: string;
  billing_name: string | null;
  booking_email: string | null;
  contact_email: string | null;
  phone: string | null;
  sender_domains: string[] | null;
  default_enabled_booking_kinds: string[] | null;
  default_pricing_notes: string | null;
  notes: string | null;
  active: boolean;
};

type PriceListRow = { id: string; agency_id: string | null; active: boolean };
type PricingRuleRow = { id: string; agency_id: string | null; active: boolean };

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

export default function CrmAgenciesPage() {
  const { data: tenantData } = useTenantOperationalData();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [priceLists, setPriceLists] = useState<PriceListRow[]>([]);
  const [rules, setRules] = useState<PricingRuleRow[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "statement" | "active">("all");

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setErrorMessage("Supabase non configurato.");
        setLoading(false);
        return;
      }
      const { data, error } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!active) return;
      if (error || !token) {
        setErrorMessage("Sessione non valida.");
        setLoading(false);
        return;
      }
      const response = await fetch("/api/pricing/bootstrap", { headers: { Authorization: `Bearer ${token}` } });
      const body = (await response.json().catch(() => null)) as { agencies?: AgencyRow[]; price_lists?: PriceListRow[]; pricing_rules?: PricingRuleRow[]; error?: string } | null;
      if (!active) return;
      if (!response.ok) {
        setErrorMessage(body?.error ?? "Errore caricamento CRM agenzie.");
        setLoading(false);
        return;
      }
      setAgencies(body?.agencies ?? []);
      setPriceLists(body?.price_lists ?? []);
      setRules(body?.pricing_rules ?? []);
      setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const activeAgencies = agencies.filter((agency) => agency.active);
  const today = new Date().toISOString().slice(0, 10);
  const window48h = addDays(today, 2);
  const nextSunday = (() => {
    const date = new Date(`${today}T12:00:00`);
    const day = date.getDay();
    const delta = day === 0 ? 7 : 7 - day;
    date.setDate(date.getDate() + delta);
    return date.toISOString().slice(0, 10);
  })();
  const agencyStats = useMemo(
    () =>
      activeAgencies
        .map((agency) => {
          const services = tenantData.services.filter((service) => (service.billing_party_name ?? "").trim() === agency.name);
          const serviceMix = services.reduce<Record<string, number>>((acc, service) => {
            const key = service.service_type_code ?? service.booking_service_kind ?? "non_classificato";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {});
          const next48hServices = services.filter((service) => service.date >= today && service.date <= window48h);
          const nextSundayBus = services.filter(
            (service) => service.date === nextSunday && service.service_type_code === "bus_line"
          );
          const lastService =
            [...services].sort((a, b) => `${b.date}T${b.time}`.localeCompare(`${a.date}T${a.time}`))[0] ?? null;

          return {
            agency,
            lists: priceLists.filter((item) => item.agency_id === agency.id && item.active).length,
            rules: rules.filter((item) => item.agency_id === agency.id && item.active).length,
            services: services.length,
            pax: services.reduce((sum, service) => sum + service.pax, 0),
            latestServiceDate: lastService?.date ?? null,
            next48hServices: next48hServices.length,
            nextSundayBus: nextSundayBus.length,
            serviceMix,
            primaryBookingKind:
              Object.entries(serviceMix).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "N/D",
            statementEnabled: STATEMENT_AGENCY_NAMES.includes(agency.name)
          };
        })
        .filter(({ agency, statementEnabled }) => {
          const text = `${agency.name} ${agency.billing_name ?? ""} ${agency.booking_email ?? ""}`.toLowerCase();
          const searchOk = !search.trim() || text.includes(search.trim().toLowerCase());
          const filterOk =
            filter === "all" ||
            (filter === "statement" && statementEnabled) ||
            (filter === "active" && agency.active);
          return searchOk && filterOk;
        }),
    [activeAgencies, filter, nextSunday, priceLists, rules, search, tenantData.services, today, window48h]
  );

  return (
    <section className="page-section">
      <PageHeader
        title="CRM Agenzie"
        subtitle="Vista sintetica di contatti, domini, regole e note operative delle agenzie."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "CRM Agenzie" }]}
      />

      {errorMessage ? <EmptyState title="CRM non disponibile" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Agenzie attive">
          <p className="text-3xl font-semibold text-text">{activeAgencies.length}</p>
        </SectionCard>
        <SectionCard title="Listini attivi">
          <p className="text-3xl font-semibold text-text">{priceLists.filter((item) => item.active).length}</p>
        </SectionCard>
        <SectionCard title="Regole attive">
          <p className="text-3xl font-semibold text-text">{rules.filter((item) => item.active).length}</p>
        </SectionCard>
      </div>

      <SectionCard title="Filtro CRM" subtitle="Riduci le schede per nome o perimetro report">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            Cerca agenzia
            <input className="input-saas mt-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Nome, fatturazione o email" />
          </label>
          <label className="text-sm">
            Vista
            <select className="input-saas mt-1" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="all">Tutte</option>
              <option value="statement">Solo estratto conto</option>
              <option value="active">Solo attive</option>
            </select>
          </label>
        </div>
      </SectionCard>

      <SectionCard title="Schede agenzia" subtitle="Storico, mix servizi, finestre 48h e prossima domenica bus" loading={loading} loadingLines={6}>
        {agencyStats.length === 0 ? (
          <p className="text-sm text-muted">Nessuna agenzia disponibile.</p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {agencyStats.map(({ agency, lists, rules: agencyRules, services, pax, latestServiceDate, next48hServices, nextSundayBus, serviceMix, primaryBookingKind, statementEnabled }) => (
              <article key={agency.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h3 className="text-base font-semibold text-text">{agency.name}</h3>
                    <p className="text-sm text-muted">{agency.billing_name ?? "Fatturazione non impostata"}</p>
                  </div>
                  <span className={agency.active ? "rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-semibold uppercase text-emerald-700" : "rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold uppercase text-slate-600"}>
                    {agency.active ? "attiva" : "inattiva"}
                  </span>
                </div>
                <div className="mt-3 grid gap-2 text-sm text-slate-700">
                  <p>Email booking: {agency.booking_email ?? "N/D"}</p>
                  <p>Email contatto: {agency.contact_email ?? "N/D"}</p>
                  <p>Telefono: {agency.phone ?? "N/D"}</p>
                  <p>Domini: {(agency.sender_domains ?? []).join(", ") || "N/D"}</p>
                  <p>Booking kind: {(agency.default_enabled_booking_kinds ?? []).join(", ") || "N/D"}</p>
                  <p>Listini attivi: {lists}</p>
                  <p>Regole attive: {agencyRules}</p>
                  <p>Servizi storici: {services}</p>
                  <p>Pax gestiti: {pax}</p>
                  <p>Ultimo servizio: {latestServiceDate ?? "N/D"}</p>
                  <p>Operativo +48h: {next48hServices}</p>
                  <p>Bus prossima domenica: {nextSundayBus}</p>
                  <p>Tipo prevalente: {primaryBookingKind}</p>
                  <p>Estratto conto: {statementEnabled ? "abilitato" : "non abilitato"}</p>
                  <p>Note pricing: {agency.default_pricing_notes || "N/D"}</p>
                  <p>Note CRM: {agency.notes || "N/D"}</p>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(serviceMix)
                    .sort((left, right) => right[1] - left[1])
                    .slice(0, 4)
                    .map(([label, count]) => (
                      <span key={`${agency.id}-${label}`} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-700">
                        {label}: {count}
                      </span>
                    ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
