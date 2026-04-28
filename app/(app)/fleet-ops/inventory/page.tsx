"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type VehicleOption = { id: string; label: string; plate?: string | null };
type InventoryRecord = {
  id: string;
  vehicle_id?: string | null;
  part_name: string;
  part_code?: string | null;
  supplier?: string | null;
  ordered_from?: string | null;
  ordered_by_name?: string | null;
  order_date?: string | null;
  unit_cost?: number | null;
  quantity_on_hand: number;
  quantity_ordered: number;
  status: "available" | "ordered" | "out_of_stock";
  notes?: string | null;
  vehicle?: VehicleOption | null;
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const EMPTY_FORM = {
  vehicle_id: "",
  part_name: "",
  part_code: "",
  supplier: "",
  ordered_from: "",
  ordered_by_name: "",
  order_date: "",
  unit_cost: "",
  quantity_on_hand: "0",
  quantity_ordered: "0",
  status: "available" as "available" | "ordered" | "out_of_stock",
  notes: "",
};

export default function FleetInventoryPage() {
  const [records, setRecords] = useState<InventoryRecord[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "available" | "ordered" | "out_of_stock">("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const showToast = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const query = statusFilter === "all" ? "" : `?status=${statusFilter}`;
    const res = await fetch(`/api/ops/spare-parts-inventory${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; records?: InventoryRecord[]; vehicles?: VehicleOption[] } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Errore caricamento ricambi.", false);
      setLoading(false);
      return;
    }
    setRecords(json.records ?? []);
    setVehicles(json.vehicles ?? []);
    setLoading(false);
  }, [showToast, statusFilter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const totals = useMemo(() => ({
    available: records.filter((record) => record.status === "available").length,
    ordered: records.filter((record) => record.status === "ordered").length,
    out_of_stock: records.filter((record) => record.status === "out_of_stock").length,
  }), [records]);

  async function createInventoryItem() {
    const token = await accessToken();
    if (!token) return;
    setSaving(true);
    const res = await fetch("/api/ops/spare-parts-inventory", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create",
        data: {
          vehicle_id: form.vehicle_id || null,
          part_name: form.part_name,
          part_code: form.part_code || null,
          supplier: form.supplier || null,
          ordered_from: form.ordered_from || null,
          ordered_by_name: form.ordered_by_name || null,
          order_date: form.order_date || null,
          unit_cost: form.unit_cost ? Number(form.unit_cost) : null,
          quantity_on_hand: Number(form.quantity_on_hand || 0),
          quantity_ordered: Number(form.quantity_ordered || 0),
          status: form.status,
          notes: form.notes || null,
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setSaving(false);
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Salvataggio ricambio fallito.", false);
      return;
    }
    setForm(EMPTY_FORM);
    showToast("Ricambio salvato.", true);
    void load();
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Ricambi magazzino"
        subtitle="Inventario centrale pezzi disponibili, ordinati o esauriti con dati ordine, fornitore e costo."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta", href: "/fleet-ops" }, { label: "Ricambi magazzino" }]}
      />

      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_420px]">
        <SectionCard
          title="Inventario"
          subtitle={`${records.length} righe inventario`}
          actions={(
            <div className="flex flex-wrap gap-2">
              {([
                ["all", "Tutti"],
                ["available", `Disponibili (${totals.available})`],
                ["ordered", `Ordinati (${totals.ordered})`],
                ["out_of_stock", `Esauriti (${totals.out_of_stock})`],
              ] as const).map(([value, label]) => (
                <button key={value} type="button" onClick={() => setStatusFilter(value)} className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusFilter === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
        >
          {loading ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-slate-400">Nessun ricambio presente per il filtro selezionato.</p>
          ) : (
            <div className="space-y-3">
              {records.map((record) => (
                <article key={record.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{record.part_name}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {record.part_code ?? "Codice assente"} · {record.vehicle ? `${record.vehicle.label}${record.vehicle.plate ? ` · ${record.vehicle.plate}` : ""}` : "Ricambio generale"}
                      </p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                      record.status === "available" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
                      record.status === "ordered" ? "border-amber-200 bg-amber-50 text-amber-700" :
                      "border-rose-200 bg-rose-50 text-rose-700"
                    }`}>
                      {record.status === "available" ? "Disponibile" : record.status === "ordered" ? "Ordinato" : "Esaurito"}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Giacenza</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.quantity_on_hand}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Ordinati</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.quantity_ordered}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Costo</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.unit_cost != null ? `€${record.unit_cost.toFixed(2)}` : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Data ordine</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.order_date ? new Date(record.order_date).toLocaleDateString("it-IT") : "—"}</p>
                    </div>
                  </div>
                  <p className="mt-3 text-sm text-slate-500">
                    Ordinato da: {record.ordered_by_name ?? "—"} · Dove: {record.ordered_from ?? record.supplier ?? "—"}
                  </p>
                  {record.notes ? <p className="mt-2 text-sm text-slate-500">{record.notes}</p> : null}
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Nuovo ricambio" subtitle="Inserisci disponibilità, ordine o esaurimento.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-500">
              Nome pezzo
              <input className="input-saas mt-1 w-full" value={form.part_name} onChange={(event) => setForm((current) => ({ ...current, part_name: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Codice pezzo
              <input className="input-saas mt-1 w-full font-mono text-xs" value={form.part_code} onChange={(event) => setForm((current) => ({ ...current, part_code: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Mezzo collegato
              <select className="input-saas mt-1 w-full" value={form.vehicle_id} onChange={(event) => setForm((current) => ({ ...current, vehicle_id: event.target.value }))}>
                <option value="">Generale / non assegnato</option>
                {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}{vehicle.plate ? ` · ${vehicle.plate}` : ""}</option>)}
              </select>
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500">
                Stato
                <select className="input-saas mt-1 w-full" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as "available" | "ordered" | "out_of_stock" }))}>
                  <option value="available">Disponibile</option>
                  <option value="ordered">Ordinato</option>
                  <option value="out_of_stock">Esaurito</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Data ordine
                <DateInput className="input-saas mt-1 w-full" value={form.order_date} onChange={(iso) => setForm((current) => ({ ...current, order_date: iso }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                In magazzino
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.quantity_on_hand} onChange={(event) => setForm((current) => ({ ...current, quantity_on_hand: event.target.value }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Ordinati
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.quantity_ordered} onChange={(event) => setForm((current) => ({ ...current, quantity_ordered: event.target.value }))} />
              </label>
            </div>
            <label className="text-xs font-semibold text-slate-500">
              Chi ha ordinato
              <input className="input-saas mt-1 w-full" value={form.ordered_by_name} onChange={(event) => setForm((current) => ({ ...current, ordered_by_name: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Dove è stato ordinato
              <input className="input-saas mt-1 w-full" value={form.ordered_from} onChange={(event) => setForm((current) => ({ ...current, ordered_from: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Fornitore
              <input className="input-saas mt-1 w-full" value={form.supplier} onChange={(event) => setForm((current) => ({ ...current, supplier: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Costo unitario
              <input className="input-saas mt-1 w-full" type="number" min="0" value={form.unit_cost} onChange={(event) => setForm((current) => ({ ...current, unit_cost: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Note
              <textarea className="input-saas mt-1 w-full resize-none" rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
            </label>
            <button type="button" disabled={saving || !form.part_name.trim()} onClick={() => void createInventoryItem()} className="btn-primary py-2 text-sm disabled:opacity-50">
              {saving ? "Salvataggio..." : "Salva ricambio"}
            </button>
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
