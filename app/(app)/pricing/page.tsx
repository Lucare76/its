"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Agency = { id: string; name: string; active: boolean };
type RouteItem = { id: string; name: string; origin_label: string; destination_label: string; active: boolean };
type PriceList = { id: string; name: string; currency: string; valid_from: string; valid_to: string | null; active: boolean; is_default: boolean };
type PricingRule = {
  id: string;
  price_list_id: string;
  route_id: string;
  agency_id: string | null;
  service_type: "transfer" | "bus_tour" | null;
  direction: "arrival" | "departure" | null;
  pax_min: number;
  pax_max: number | null;
  rule_kind: "fixed" | "per_pax";
  internal_cost_cents: number;
  public_price_cents: number;
  agency_price_cents: number | null;
  priority: number;
  active: boolean;
};

const agencySchema = z.object({ name: z.string().min(2).max(120) });
const aliasSchema = z.object({ agency_id: z.string().uuid(), alias: z.string().min(2).max(120) });
const routeSchema = z.object({
  name: z.string().min(2).max(120),
  origin_label: z.string().min(2).max(120),
  destination_label: z.string().min(2).max(120)
});
const priceListSchema = z
  .object({
    name: z.string().min(2).max(120),
    currency: z.string().length(3),
    valid_from: z.string().min(10),
    valid_to: z.string().optional().or(z.literal("")),
    is_default: z.boolean().default(false)
  })
  .transform((value) => ({ ...value, valid_to: value.valid_to || null, currency: value.currency.toUpperCase() }));

const pricingRuleSchema = z.object({
  price_list_id: z.string().uuid(),
  route_id: z.string().uuid(),
  agency_id: z.string().uuid().optional().or(z.literal("")),
  service_type: z.enum(["transfer", "bus_tour"]).optional().or(z.literal("")),
  direction: z.enum(["arrival", "departure"]).optional().or(z.literal("")),
  pax_min: z.number().int().min(1),
  pax_max: z.number().int().min(1).optional().nullable(),
  rule_kind: z.enum(["fixed", "per_pax"]),
  internal_cost_cents: z.number().int().min(0),
  public_price_cents: z.number().int().min(0),
  agency_price_cents: z.number().int().min(0).optional().nullable(),
  priority: z.number().int().min(1).max(999)
});

export default function PricingAdminPage() {
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [routes, setRoutes] = useState<RouteItem[]>([]);
  const [priceLists, setPriceLists] = useState<PriceList[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [message, setMessage] = useState("Configurazione tariffe e margini.");
  const [loading, setLoading] = useState(true);

  const loadAll = async (currentTenantId?: string | null) => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Supabase non configurato.");
      setLoading(false);
      return;
    }
    const tid = currentTenantId ?? tenantId;
    if (!tid) return;
    const [a, r, p, pr] = await Promise.all([
      supabase.from("agencies").select("id,name,active").eq("tenant_id", tid).order("name"),
      supabase.from("routes").select("id,name,origin_label,destination_label,active").eq("tenant_id", tid).order("name"),
      supabase.from("price_lists").select("id,name,currency,valid_from,valid_to,active,is_default").eq("tenant_id", tid).order("valid_from", { ascending: false }),
      supabase.from("pricing_rules").select("id,price_list_id,route_id,agency_id,service_type,direction,pax_min,pax_max,rule_kind,internal_cost_cents,public_price_cents,agency_price_cents,priority,active").eq("tenant_id", tid).order("priority")
    ]);
    setAgencies((a.data ?? []) as Agency[]);
    setRoutes((r.data ?? []) as RouteItem[]);
    setPriceLists((p.data ?? []) as PriceList[]);
    setRules((pr.data ?? []) as PricingRule[]);
    setLoading(false);
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (!hasSupabaseEnv || !supabase) return;
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) {
        setMessage("Sessione non valida. Rifai login.");
        setLoading(false);
        return;
      }
      const { data: membership } = await supabase.from("memberships").select("tenant_id").eq("user_id", userData.user.id).maybeSingle();
      if (!membership?.tenant_id) {
        setMessage("Membership tenant non trovata.");
        setLoading(false);
        return;
      }
      setTenantId(membership.tenant_id);
      await loadAll(membership.tenant_id);
    };
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreateAgency = async (formData: FormData) => {
    if (!supabase || !tenantId) return;
    const parsed = agencySchema.safeParse({ name: String(formData.get("name") ?? "") });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Dati agenzia non validi.");
    const { error } = await supabase.from("agencies").insert({ tenant_id: tenantId, name: parsed.data.name, active: true });
    if (error) return setMessage(error.message);
    setMessage("Agenzia creata.");
    await loadAll();
  };

  const onCreateAlias = async (formData: FormData) => {
    if (!supabase || !tenantId) return;
    const parsed = aliasSchema.safeParse({
      agency_id: String(formData.get("agency_id") ?? ""),
      alias: String(formData.get("alias") ?? "")
    });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Alias non valido.");
    const { error } = await supabase.from("agency_aliases").insert({ tenant_id: tenantId, ...parsed.data });
    if (error) return setMessage(error.message);
    setMessage("Alias agenzia creato.");
  };

  const onCreateRoute = async (formData: FormData) => {
    if (!supabase || !tenantId) return;
    const parsed = routeSchema.safeParse({
      name: String(formData.get("name") ?? ""),
      origin_label: String(formData.get("origin_label") ?? ""),
      destination_label: String(formData.get("destination_label") ?? "")
    });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Tratta non valida.");
    const { error } = await supabase.from("routes").insert({ tenant_id: tenantId, ...parsed.data, origin_type: "custom", destination_type: "custom", active: true });
    if (error) return setMessage(error.message);
    setMessage("Tratta creata.");
    await loadAll();
  };

  const onCreatePriceList = async (formData: FormData) => {
    if (!supabase || !tenantId) return;
    const parsed = priceListSchema.safeParse({
      name: String(formData.get("name") ?? ""),
      currency: String(formData.get("currency") ?? "EUR"),
      valid_from: String(formData.get("valid_from") ?? ""),
      valid_to: String(formData.get("valid_to") ?? ""),
      is_default: String(formData.get("is_default") ?? "") === "on"
    });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Listino non valido.");
    const { error } = await supabase.from("price_lists").insert({ tenant_id: tenantId, ...parsed.data, active: true });
    if (error) return setMessage(error.message);
    setMessage("Listino creato.");
    await loadAll();
  };

  const onCreateRule = async (formData: FormData) => {
    if (!supabase || !tenantId) return;
    const parsed = pricingRuleSchema.safeParse({
      price_list_id: String(formData.get("price_list_id") ?? ""),
      route_id: String(formData.get("route_id") ?? ""),
      agency_id: String(formData.get("agency_id") ?? ""),
      service_type: String(formData.get("service_type") ?? ""),
      direction: String(formData.get("direction") ?? ""),
      pax_min: Number(formData.get("pax_min") ?? 1),
      pax_max: formData.get("pax_max") ? Number(formData.get("pax_max")) : null,
      rule_kind: String(formData.get("rule_kind") ?? "fixed") as "fixed" | "per_pax",
      internal_cost_cents: Number(formData.get("internal_cost_cents") ?? 0),
      public_price_cents: Number(formData.get("public_price_cents") ?? 0),
      agency_price_cents: formData.get("agency_price_cents") ? Number(formData.get("agency_price_cents")) : null,
      priority: Number(formData.get("priority") ?? 100)
    });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Regola tariffaria non valida.");

    const payload = {
      ...parsed.data,
      agency_id: parsed.data.agency_id || null,
      service_type: parsed.data.service_type || null,
      direction: parsed.data.direction || null,
      tenant_id: tenantId,
      active: true
    };
    const { error } = await supabase.from("pricing_rules").insert(payload);
    if (error) return setMessage(error.message);
    setMessage("Regola tariffaria creata.");
    await loadAll();
  };

  const onToggle = async (table: "agencies" | "routes" | "price_lists" | "pricing_rules", id: string, current: boolean) => {
    if (!supabase || !tenantId) return;
    const { error } = await supabase.from(table).update({ active: !current }).eq("id", id).eq("tenant_id", tenantId);
    if (error) return setMessage(error.message);
    setMessage(`Stato aggiornato su ${table}.`);
    await loadAll();
  };

  const onDeleteRule = async (id: string) => {
    if (!supabase || !tenantId) return;
    const { error } = await supabase.from("pricing_rules").delete().eq("id", id).eq("tenant_id", tenantId);
    if (error) return setMessage(error.message);
    setMessage("Regola eliminata.");
    await loadAll();
  };

  if (loading) return <div className="card p-4 text-sm text-slate-500">Caricamento pricing...</div>;

  return (
    <section className="space-y-4">
      <h1 className="text-2xl font-semibold">Tariffe e Margini</h1>
      <p className="text-sm text-slate-600">{message}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <form action={onCreateAgency} className="card space-y-2 p-4">
          <h2 className="text-base font-semibold">Nuova Agenzia</h2>
          <input name="name" placeholder="Nome agenzia" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="btn-primary px-4 py-2 text-sm">Crea Agenzia</button>
        </form>

        <form action={onCreateAlias} className="card space-y-2 p-4">
          <h2 className="text-base font-semibold">Nuovo Alias Agenzia</h2>
          <select name="agency_id" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm">
            {agencies.map((agency) => (
              <option key={agency.id} value={agency.id}>
                {agency.name}
              </option>
            ))}
          </select>
          <input name="alias" placeholder="Alias (come appare in email/PDF)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="btn-primary px-4 py-2 text-sm">Crea Alias</button>
        </form>

        <form action={onCreateRoute} className="card space-y-2 p-4">
          <h2 className="text-base font-semibold">Nuova Tratta</h2>
          <input name="name" placeholder="Nome tratta (es. Porto -> Hotel)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input name="origin_label" placeholder="Origine" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <input name="destination_label" placeholder="Destinazione" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <button className="btn-primary px-4 py-2 text-sm">Crea Tratta</button>
        </form>

        <form action={onCreatePriceList} className="card space-y-2 p-4">
          <h2 className="text-base font-semibold">Nuovo Listino</h2>
          <input name="name" placeholder="Nome listino" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          <div className="grid grid-cols-3 gap-2">
            <input name="currency" defaultValue="EUR" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input name="valid_from" type="date" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input name="valid_to" type="date" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="is_default" /> Listino default
          </label>
          <button className="btn-primary px-4 py-2 text-sm">Crea Listino</button>
        </form>
      </div>

      <form action={onCreateRule} className="card grid gap-2 p-4 md:grid-cols-4">
        <h2 className="md:col-span-4 text-base font-semibold">Nuova Regola Tariffaria</h2>
        <select name="price_list_id" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {priceLists.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select name="route_id" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          {routes.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select name="agency_id" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">(tutte le agenzie)</option>
          {agencies.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <select name="rule_kind" defaultValue="fixed" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="fixed">fixed</option>
          <option value="per_pax">per_pax</option>
        </select>
        <select name="service_type" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">(all)</option>
          <option value="transfer">transfer</option>
          <option value="bus_tour">bus_tour</option>
        </select>
        <select name="direction" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">(all)</option>
          <option value="arrival">arrival</option>
          <option value="departure">departure</option>
        </select>
        <input name="pax_min" type="number" min={1} defaultValue={1} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <input name="pax_max" type="number" min={1} placeholder="pax_max (opz)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <input name="internal_cost_cents" type="number" min={0} placeholder="internal_cost_cents" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <input name="public_price_cents" type="number" min={0} placeholder="public_price_cents" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <input name="agency_price_cents" type="number" min={0} placeholder="agency_price_cents (opz)" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <input name="priority" type="number" min={1} max={999} defaultValue={100} className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        <button className="btn-primary md:col-span-4 px-4 py-2 text-sm">Crea Regola</button>
      </form>

      <div className="card p-4">
        <h2 className="mb-2 text-base font-semibold">Anagrafiche</h2>
        <div className="grid gap-4 md:grid-cols-3 text-sm">
          <div>
            <p className="mb-2 font-medium">Agenzie ({agencies.length})</p>
            <div className="space-y-1">
              {agencies.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1">
                  <span>{item.name}</span>
                  <button className="text-xs underline" onClick={() => void onToggle("agencies", item.id, item.active)} type="button">
                    {item.active ? "Disattiva" : "Attiva"}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-medium">Tratte ({routes.length})</p>
            <div className="space-y-1">
              {routes.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1">
                  <span>{item.name}</span>
                  <button className="text-xs underline" onClick={() => void onToggle("routes", item.id, item.active)} type="button">
                    {item.active ? "Disattiva" : "Attiva"}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 font-medium">Listini ({priceLists.length})</p>
            <div className="space-y-1">
              {priceLists.map((item) => (
                <div key={item.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1">
                  <span>{item.name}</span>
                  <button className="text-xs underline" onClick={() => void onToggle("price_lists", item.id, item.active)} type="button">
                    {item.active ? "Disattiva" : "Attiva"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h2 className="mb-2 text-base font-semibold">Regole attive ({rules.length})</h2>
        <div className="overflow-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left">
                <th className="px-2 py-2">Priority</th>
                <th className="px-2 py-2">Listino</th>
                <th className="px-2 py-2">Route</th>
                <th className="px-2 py-2">Agenzia</th>
                <th className="px-2 py-2">Kind</th>
                <th className="px-2 py-2">Cost/Public/Agency</th>
                <th className="px-2 py-2">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-100">
                  <td className="px-2 py-2">{rule.priority}</td>
                  <td className="px-2 py-2">{priceLists.find((x) => x.id === rule.price_list_id)?.name ?? rule.price_list_id.slice(0, 8)}</td>
                  <td className="px-2 py-2">{routes.find((x) => x.id === rule.route_id)?.name ?? rule.route_id.slice(0, 8)}</td>
                  <td className="px-2 py-2">{rule.agency_id ? agencies.find((x) => x.id === rule.agency_id)?.name ?? rule.agency_id.slice(0, 8) : "(all)"}</td>
                  <td className="px-2 py-2">{rule.rule_kind}</td>
                  <td className="px-2 py-2">
                    {rule.internal_cost_cents}/{rule.public_price_cents}/{rule.agency_price_cents ?? "-"}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex gap-2">
                      <button className="text-xs underline" type="button" onClick={() => void onToggle("pricing_rules", rule.id, rule.active)}>
                        {rule.active ? "Disattiva" : "Attiva"}
                      </button>
                      <button className="text-xs text-rose-700 underline" type="button" onClick={() => void onDeleteRule(rule.id)}>
                        Elimina
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-2 py-3 text-slate-500">
                    Nessuna regola.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
