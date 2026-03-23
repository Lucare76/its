"use client";

import { useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

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

export default function CrmAgenciesPage() {
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [priceLists, setPriceLists] = useState<PriceListRow[]>([]);
  const [rules, setRules] = useState<PricingRuleRow[]>([]);

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
  const agencyStats = useMemo(
    () =>
      activeAgencies.map((agency) => ({
        agency,
        lists: priceLists.filter((item) => item.agency_id === agency.id && item.active).length,
        rules: rules.filter((item) => item.agency_id === agency.id && item.active).length
      })),
    [activeAgencies, priceLists, rules]
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

      <SectionCard title="Schede agenzia" loading={loading} loadingLines={6}>
        {agencyStats.length === 0 ? (
          <p className="text-sm text-muted">Nessuna agenzia disponibile.</p>
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {agencyStats.map(({ agency, lists, rules: agencyRules }) => (
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
                  <p>Note pricing: {agency.default_pricing_notes || "N/D"}</p>
                  <p>Note CRM: {agency.notes || "N/D"}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </section>
  );
}
