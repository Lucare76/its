"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type VehicleOption = { id: string; label: string; plate?: string | null };
type MaintenanceRecord = {
  id: string;
  vehicle_id: string;
  maintenance_date: string;
  description: string;
  cost?: number | null;
  km_at_service?: number | null;
  provider?: string | null;
  notes?: string | null;
  maintenance_kind: "ordinary" | "extraordinary";
  execution_mode: "single" | "multiple";
  replaced_parts: string[];
  vehicle?: VehicleOption | null;
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const EMPTY_FORM = {
  vehicle_id: "",
  maintenance_date: new Date().toISOString().slice(0, 10),
  description: "",
  cost: "",
  km_at_service: "",
  provider: "",
  notes: "",
  maintenance_kind: "ordinary" as "ordinary" | "extraordinary",
  execution_mode: "single" as "single" | "multiple",
  replaced_parts: "",
};

export default function FleetMaintenancePage() {
  const [records, setRecords] = useState<MaintenanceRecord[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [kindFilter, setKindFilter] = useState<"all" | "ordinary" | "extraordinary">("all");
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
    const query = kindFilter === "all" ? "" : `?kind=${kindFilter}`;
    const res = await fetch(`/api/ops/maintenance-register${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; records?: MaintenanceRecord[]; vehicles?: VehicleOption[] } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Errore caricamento manutenzioni.", false);
      setLoading(false);
      return;
    }
    setRecords(json.records ?? []);
    setVehicles(json.vehicles ?? []);
    setLoading(false);
  }, [kindFilter, showToast]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const totals = useMemo(() => ({
    ordinary: records.filter((record) => record.maintenance_kind === "ordinary").length,
    extraordinary: records.filter((record) => record.maintenance_kind === "extraordinary").length,
    totalCost: records.reduce((sum, record) => sum + Number(record.cost ?? 0), 0),
  }), [records]);

  async function createMaintenance() {
    const token = await accessToken();
    if (!token) return;
    setSaving(true);
    const res = await fetch("/api/ops/maintenance-register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create",
        data: {
          vehicle_id: form.vehicle_id,
          maintenance_date: form.maintenance_date,
          description: form.description,
          cost: form.cost ? Number(form.cost) : null,
          km_at_service: form.km_at_service ? Number(form.km_at_service) : null,
          provider: form.provider || null,
          notes: form.notes || null,
          maintenance_kind: form.maintenance_kind,
          execution_mode: form.execution_mode,
          replaced_parts: form.replaced_parts.split(",").map((item) => item.trim()).filter(Boolean),
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setSaving(false);
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Salvataggio manutenzione fallito.", false);
      return;
    }
    setForm(EMPTY_FORM);
    showToast("Manutenzione registrata.", true);
    void load();
  }

  async function deleteMaintenance(id: string) {
    const token = await accessToken();
    if (!token) return;
    const res = await fetch("/api/ops/maintenance-register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "delete", id }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Eliminazione manutenzione fallita.", false);
      return;
    }
    showToast("Manutenzione eliminata.", true);
    void load();
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Manutenzioni"
        subtitle="Registro officina per interventi singoli o multipli, ordinari o straordinari, con costo, km e pezzi cambiati."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta", href: "/fleet-ops" }, { label: "Manutenzioni" }]}
      />

      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_420px]">
        <SectionCard
          title="Registro interventi"
          subtitle={`${records.length} interventi visibili · costo totale €${totals.totalCost.toFixed(2)}`}
          actions={(
            <div className="flex flex-wrap gap-2">
              {([
                ["all", "Tutti"],
                ["ordinary", `Ordinarie (${totals.ordinary})`],
                ["extraordinary", `Straordinarie (${totals.extraordinary})`],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKindFilter(value)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${kindFilter === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        >
          {loading ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-slate-400">Nessun intervento trovato.</p>
          ) : (
            <div className="space-y-3">
              {records.map((record) => (
                <article key={record.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">{record.vehicle?.label ?? "Veicolo"}{record.vehicle?.plate ? ` · ${record.vehicle.plate}` : ""}</p>
                      <p className="mt-1 text-xs text-slate-500">{new Date(record.maintenance_date).toLocaleDateString("it-IT")} · {record.provider ?? "Officina non specificata"}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${record.maintenance_kind === "ordinary" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                        {record.maintenance_kind === "ordinary" ? "Ordinaria" : "Straordinaria"}
                      </span>
                      <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                        {record.execution_mode === "single" ? "Singola" : "Multipla"}
                      </span>
                    </div>
                  </div>
                  <p className="mt-3 text-sm font-medium text-slate-800">{record.description}</p>
                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Costo</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.cost != null ? `€${record.cost.toFixed(2)}` : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Km</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.km_at_service != null ? record.km_at_service.toLocaleString("it-IT") : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Pezzi cambiati</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.replaced_parts.length > 0 ? record.replaced_parts.length : "—"}</p>
                    </div>
                  </div>
                  {record.replaced_parts.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {record.replaced_parts.map((part) => (
                        <span key={part} className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700">{part}</span>
                      ))}
                    </div>
                  ) : null}
                  {record.notes ? <p className="mt-3 text-sm text-slate-500">{record.notes}</p> : null}
                  <div className="mt-3">
                    <button type="button" onClick={() => void deleteMaintenance(record.id)} className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100">
                      Elimina
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Nuovo intervento" subtitle="Compila interventi ordinari o straordinari, singoli o multipli.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-500">
              Mezzo
              <select className="input-saas mt-1 w-full" value={form.vehicle_id} onChange={(event) => setForm((current) => ({ ...current, vehicle_id: event.target.value }))}>
                <option value="">Seleziona mezzo</option>
                {vehicles.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.label}{vehicle.plate ? ` · ${vehicle.plate}` : ""}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Data
              <DateInput className="input-saas mt-1 w-full" value={form.maintenance_date} onChange={(iso) => setForm((current) => ({ ...current, maintenance_date: iso }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Descrizione
              <textarea className="input-saas mt-1 w-full resize-none" rows={3} value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500">
                Tipo manutenzione
                <select className="input-saas mt-1 w-full" value={form.maintenance_kind} onChange={(event) => setForm((current) => ({ ...current, maintenance_kind: event.target.value as "ordinary" | "extraordinary" }))}>
                  <option value="ordinary">Ordinaria</option>
                  <option value="extraordinary">Straordinaria</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Modalità
                <select className="input-saas mt-1 w-full" value={form.execution_mode} onChange={(event) => setForm((current) => ({ ...current, execution_mode: event.target.value as "single" | "multiple" }))}>
                  <option value="single">Singola</option>
                  <option value="multiple">Multipla</option>
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Costo
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.cost} onChange={(event) => setForm((current) => ({ ...current, cost: event.target.value }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Km al servizio
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.km_at_service} onChange={(event) => setForm((current) => ({ ...current, km_at_service: event.target.value }))} />
              </label>
            </div>
            <label className="text-xs font-semibold text-slate-500">
              Officina / Fornitore
              <input className="input-saas mt-1 w-full" value={form.provider} onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Pezzi cambiati
              <input className="input-saas mt-1 w-full" value={form.replaced_parts} onChange={(event) => setForm((current) => ({ ...current, replaced_parts: event.target.value }))} placeholder="es. filtro olio, pastiglie freno, lampada dx" />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Note
              <textarea className="input-saas mt-1 w-full resize-none" rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
            </label>
            <button type="button" disabled={saving || !form.vehicle_id || !form.description.trim()} onClick={() => void createMaintenance()} className="btn-primary py-2 text-sm disabled:opacity-50">
              {saving ? "Salvataggio..." : "Salva manutenzione"}
            </button>
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
