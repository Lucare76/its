"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Vehicle = {
  id: string;
  label: string;
  plate?: string | null;
  capacity?: number | null;
  active: boolean;
  vehicle_size?: "small" | "medium" | "large" | "bus" | null;
  habitual_driver_user_id?: string | null;
  habitual_driver_profile_id?: string | null;
  default_zone?: string | null;
  blocked_until?: string | null;
  blocked_reason?: string | null;
  notes?: string | null;
  is_blocked_manual?: boolean | null;
  radius_vehicle_id?: string | null;
  insurance_expiry?: string | null;
  road_tax_expiry?: string | null;
  inspection_expiry?: string | null;
};

type Driver = { id: string; full_name: string; phone?: string | null };

type Anomaly = {
  id: string;
  vehicle_id: string;
  severity: "low" | "medium" | "high" | "blocking";
  title: string;
  description?: string | null;
  blocked_until?: string | null;
  active: boolean;
  reported_at: string;
};

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const SIZE_LABEL: Record<string, string> = {
  small: "Piccolo",
  medium: "Medio",
  large: "Grande",
  bus: "Bus",
};

const SIZE_BADGE: Record<string, string> = {
  small: "bg-slate-100 text-slate-600 border-slate-200",
  medium: "bg-teal-50 text-teal-700 border-teal-200",
  large: "bg-blue-50 text-blue-700 border-blue-200",
  bus: "bg-purple-50 text-purple-700 border-purple-200",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "Bassa",
  medium: "Media",
  high: "Alta",
  blocking: "Bloccante",
};

const SEVERITY_BADGE: Record<string, string> = {
  low: "bg-slate-50 text-slate-600 border-slate-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-orange-50 text-orange-700 border-orange-200",
  blocking: "bg-rose-50 text-rose-700 border-rose-200",
};

const EMPTY_FORM = {
  label: "",
  plate: "",
  vehicle_size: "medium",
  habitual_driver_profile_id: "",
  default_zone: "",
  blocked_until: "",
  blocked_reason: "",
  notes: "",
  radius_vehicle_id: "",
  capacity: "",
  insurance_expiry: "",
  road_tax_expiry: "",
  inspection_expiry: "",
};

function expiryStatus(dateStr: string | null | undefined): "ok" | "soon" | "expired" | "none" {
  if (!dateStr) return "none";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const expiry = new Date(`${dateStr}T00:00:00`);
  const diffDays = Math.floor((expiry.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0) return "expired";
  if (diffDays <= 30) return "soon";
  return "ok";
}

const EXPIRY_BADGE: Record<string, string> = {
  ok:      "bg-emerald-50 text-emerald-700 border-emerald-200",
  soon:    "bg-amber-50 text-amber-700 border-amber-200",
  expired: "bg-rose-50 text-rose-700 border-rose-200",
  none:    "bg-slate-50 text-slate-400 border-slate-200",
};

const EMPTY_ANOMALY = {
  title: "",
  severity: "medium",
  blocked_until: "",
  description: "",
};

export default function FleetOpsPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [anomalyForm, setAnomalyForm] = useState(EMPTY_ANOMALY);
  const [showAnomalyPanel, setShowAnomalyPanel] = useState(false);
  const [sizeFilter, setSizeFilter] = useState<string>("all");
  const [isNewVehicle, setIsNewVehicle] = useState(false);
  const [driverFormOpen, setDriverFormOpen] = useState(false);
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [driverForm, setDriverForm] = useState({ full_name: "", phone: "" });

  const load = useEffectEvent(async () => {
    const token = await accessToken();
    if (!token) { setLoading(false); return; }
    const response = await fetch("/api/ops/vehicles", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; drivers?: Driver[]; anomalies?: Anomaly[] } | null;
    if (!response.ok || !body?.ok) { setLoading(false); showToast(body?.error ?? "Errore caricamento flotta.", false); return; }
    setVehicles(body.vehicles ?? []);
    setDrivers(body.drivers ?? []);
    setAnomalies(body.anomalies ?? []);
    setSelectedVehicleId((current) => current || body.vehicles?.[0]?.id || "");
    setLoading(false);
  });

  useEffect(() => { void load(); }, []);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selectedVehicleId) ?? null,
    [vehicles, selectedVehicleId]
  );

  useEffect(() => {
    if (isNewVehicle) {
      setForm(EMPTY_FORM);
      setShowAnomalyPanel(false);
      setAnomalyForm(EMPTY_ANOMALY);
      return;
    }
    if (!selectedVehicle) return;
    setForm({
      label: selectedVehicle.label,
      plate: selectedVehicle.plate ?? "",
      vehicle_size: selectedVehicle.vehicle_size ?? "medium",
      habitual_driver_profile_id: selectedVehicle.habitual_driver_profile_id ?? "",
      default_zone: selectedVehicle.default_zone ?? "",
      blocked_until: selectedVehicle.blocked_until?.slice(0, 16) ?? "",
      blocked_reason: selectedVehicle.blocked_reason ?? "",
      notes: selectedVehicle.notes ?? "",
      radius_vehicle_id: selectedVehicle.radius_vehicle_id ?? "",
      capacity: String(selectedVehicle.capacity ?? ""),
      insurance_expiry: selectedVehicle.insurance_expiry ?? "",
      road_tax_expiry: selectedVehicle.road_tax_expiry ?? "",
      inspection_expiry: selectedVehicle.inspection_expiry ?? "",
    });
    setShowAnomalyPanel(false);
    setAnomalyForm(EMPTY_ANOMALY);
  }, [selectedVehicle?.id, isNewVehicle]);

  const selectedAnomalies = anomalies.filter((a) => a.vehicle_id === selectedVehicleId && a.active);
  const driverNameById = useMemo(() => new Map(drivers.map((d) => [d.id, d.full_name])), [drivers]);

  function showToast(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    const token = await accessToken();
    if (!token) return false;
    setSaving(true);
    const response = await fetch("/api/ops/vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; anomalies?: Anomaly[]; drivers?: Driver[] } | null;
    setSaving(false);
    if (!response.ok || !json?.ok) { showToast(json?.error ?? "Operazione non riuscita.", false); return false; }
    setVehicles(json.vehicles ?? []);
    setDrivers(json.drivers ?? []);
    setAnomalies(json.anomalies ?? []);
    showToast("Salvato.", true);
    return true;
  };

  const filteredVehicles = useMemo(
    () => sizeFilter === "all" ? vehicles : vehicles.filter((v) => v.vehicle_size === sizeFilter),
    [vehicles, sizeFilter]
  );

  if (loading) {
    return (
      <section className="page-section">
        <p className="text-sm text-muted">Caricamento flotta...</p>
      </section>
    );
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Gestione Flotta"
        subtitle="Veicoli, autisti abituali, blocchi e anomalie."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta" }]}
      />

      {/* Toast */}
      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg transition-all ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Mezzi attivi", value: vehicles.filter((v) => v.active).length, color: "text-slate-800" },
          { label: "Mezzi bloccati", value: vehicles.filter((v) => v.is_blocked_manual || v.blocked_until).length, color: "text-rose-700" },
          { label: "Anomalie aperte", value: anomalies.filter((a) => a.active).length, color: "text-amber-700" },
          { label: "Autisti attivi", value: drivers.length, color: "text-slate-800" },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-border bg-white px-5 py-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{stat.label}</p>
            <p className={`mt-1 text-3xl font-semibold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_420px]">

        {/* ── Lista veicoli ───────────────────────────────────────────────── */}
        <SectionCard
          title="Veicoli"
          actions={
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => { setIsNewVehicle(true); setSelectedVehicleId(""); }}
                className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                + Nuovo mezzo
              </button>
              {["all", "bus", "large", "medium", "small"].map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setSizeFilter(size)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition ${sizeFilter === size ? "border-blue-300 bg-blue-50 text-blue-700" : "border-border bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  {size === "all" ? "Tutti" : SIZE_LABEL[size]}
                </button>
              ))}
            </div>
          }
        >
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2.5">Veicolo</th>
                  <th className="px-3 py-2.5">Taglia</th>
                  <th className="px-3 py-2.5">Targa</th>
                  <th className="px-3 py-2.5">Posti</th>
                  <th className="px-3 py-2.5">Autista abituale</th>
                  <th className="px-3 py-2.5">GPS</th>
                  <th className="px-3 py-2.5">Documenti</th>
                  <th className="px-3 py-2.5">Stato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVehicles.map((vehicle) => {
                  const isSelected = vehicle.id === selectedVehicleId;
                  const isBlocked = Boolean(vehicle.is_blocked_manual || vehicle.blocked_until);
                  const hasGps = Boolean(vehicle.radius_vehicle_id);
                  return (
                    <tr
                      key={vehicle.id}
                      onClick={() => { setSelectedVehicleId(vehicle.id); setIsNewVehicle(false); }}
                      className={`cursor-pointer transition ${isSelected ? "bg-blue-50/70" : "hover:bg-slate-50/80"}`}
                    >
                      <td className="px-3 py-2.5">
                        <span className={`font-medium ${isSelected ? "text-blue-800" : "text-slate-800"}`}>{vehicle.label}</span>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SIZE_BADGE[vehicle.vehicle_size ?? ""] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                          {SIZE_LABEL[vehicle.vehicle_size ?? ""] ?? "N/D"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-slate-600">{vehicle.plate ?? "—"}</td>
                      <td className="px-3 py-2.5 text-slate-600">{vehicle.capacity ?? "—"}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {vehicle.habitual_driver_profile_id ? driverNameById.get(vehicle.habitual_driver_profile_id) ?? "—" : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${hasGps ? "bg-emerald-400" : "bg-slate-200"}`} title={hasGps ? vehicle.radius_vehicle_id ?? "" : "Nessun GPS"} />
                      </td>
                      <td className="px-3 py-2.5">
                        {(() => {
                          const docs = [
                            { key: "Ass.", val: vehicle.insurance_expiry },
                            { key: "Bollo", val: vehicle.road_tax_expiry },
                            { key: "Coll.", val: vehicle.inspection_expiry },
                          ];
                          const worst = docs.reduce<"ok" | "soon" | "expired" | "none">((acc, d) => {
                            const s = expiryStatus(d.val);
                            if (s === "expired") return "expired";
                            if (s === "soon" && acc !== "expired") return "soon";
                            if (s === "ok" && acc === "none") return "ok";
                            return acc;
                          }, "none");
                          if (worst === "none") return <span className="text-slate-300 text-xs">—</span>;
                          const expiredDocs = docs.filter(d => expiryStatus(d.val) === "expired").map(d => d.key);
                          const soonDocs = docs.filter(d => expiryStatus(d.val) === "soon").map(d => d.key);
                          const label = expiredDocs.length ? `Scaduto: ${expiredDocs.join(", ")}` : soonDocs.length ? `In scadenza: ${soonDocs.join(", ")}` : "OK";
                          return (
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${EXPIRY_BADGE[worst]}`} title={label}>
                              {worst === "expired" ? "⚠ Scaduto" : worst === "soon" ? "⚠ In scad." : "✓ OK"}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          title={vehicle.active ? "Clicca per disattivare" : "Clicca per attivare"}
                          onClick={() => void post({
                            action: "upsert_vehicle",
                            id: vehicle.id,
                            label: vehicle.label,
                            plate: vehicle.plate ?? null,
                            vehicle_size: vehicle.vehicle_size ?? "medium",
                            habitual_driver_user_id: vehicle.habitual_driver_profile_id ?? null,
                            default_zone: vehicle.default_zone ?? null,
                            blocked_until: vehicle.blocked_until ?? null,
                            blocked_reason: vehicle.blocked_reason ?? null,
                            notes: vehicle.notes ?? null,
                            radius_vehicle_id: vehicle.radius_vehicle_id ?? null,
                            capacity: vehicle.capacity ?? null,
                            is_blocked_manual: vehicle.is_blocked_manual ?? false,
                            active: !vehicle.active,
                          })}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition hover:opacity-80 ${
                            isBlocked
                              ? "border-rose-200 bg-rose-50 text-rose-700"
                              : vehicle.active
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-slate-100 text-slate-400"
                          }`}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${vehicle.active && !isBlocked ? "bg-emerald-500" : isBlocked ? "bg-rose-500" : "bg-slate-300"}`} />
                          {isBlocked ? "Bloccato" : vehicle.active ? "Attivo" : "Inattivo"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>

        {/* ── Pannello modifica ───────────────────────────────────────────── */}
        <div className="space-y-4">
          <SectionCard title={isNewVehicle ? "Nuovo mezzo" : selectedVehicle ? selectedVehicle.label : "Seleziona un mezzo"} subtitle={isNewVehicle ? "Crea nuovo mezzo" : "Dettaglio e modifica"}>
            {!selectedVehicle && !isNewVehicle ? (
              <p className="text-sm text-muted">Clicca un veicolo nella tabella o crea un nuovo mezzo.</p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs font-semibold text-slate-500">
                    Nome mezzo
                    <input className="input-saas mt-1 w-full" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Targa
                    <input className="input-saas mt-1 w-full font-mono" value={form.plate} onChange={(e) => setForm((f) => ({ ...f, plate: e.target.value }))} placeholder="AA123BB" />
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Taglia
                    <select className="input-saas mt-1 w-full" value={form.vehicle_size} onChange={(e) => setForm((f) => ({ ...f, vehicle_size: e.target.value }))}>
                      <option value="small">Piccolo (≤8 pax)</option>
                      <option value="medium">Medio (10–16 pax)</option>
                      <option value="large">Grande (25–26 pax)</option>
                      <option value="bus">Bus (40+ pax)</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Posti
                    <input type="number" min="1" max="120" className="input-saas mt-1 w-full" value={form.capacity} onChange={(e) => setForm((f) => ({ ...f, capacity: e.target.value }))} placeholder="es. 54" />
                  </label>
                  <label className="col-span-2 text-xs font-semibold text-slate-500">
                    Autista abituale
                    <select className="input-saas mt-1 w-full" value={form.habitual_driver_profile_id} onChange={(e) => setForm((f) => ({ ...f, habitual_driver_profile_id: e.target.value }))}>
                      <option value="">Nessun autista abituale</option>
                      {drivers.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}
                    </select>
                  </label>
                  <label className="col-span-2 text-xs font-semibold text-slate-500">
                    ID GPS Radius
                    <input className="input-saas mt-1 w-full font-mono" value={form.radius_vehicle_id} onChange={(e) => setForm((f) => ({ ...f, radius_vehicle_id: e.target.value }))} placeholder="es. VH-1234" />
                  </label>
                  <label className="col-span-2 text-xs font-semibold text-slate-500">
                    Zona abituale
                    <input className="input-saas mt-1 w-full" value={form.default_zone} onChange={(e) => setForm((f) => ({ ...f, default_zone: e.target.value }))} placeholder="es. Porto / Casamicciola" />
                  </label>
                  <label className="col-span-2 text-xs font-semibold text-slate-500">
                    Note
                    <textarea rows={2} className="input-saas mt-1 w-full resize-none" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Note libere sul mezzo" />
                  </label>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    className="btn-primary flex-1 py-2 text-sm disabled:opacity-50"
                    onClick={async () => {
                      const ok = await post({
                        action: "upsert_vehicle",
                        ...(!isNewVehicle && selectedVehicle ? { id: selectedVehicle.id } : {}),
                        label: form.label,
                        plate: form.plate || null,
                        vehicle_size: form.vehicle_size,
                        habitual_driver_user_id: form.habitual_driver_profile_id || null,
                        default_zone: form.default_zone || null,
                        blocked_until: form.blocked_until || null,
                        blocked_reason: form.blocked_reason || null,
                        notes: form.notes || null,
                        radius_vehicle_id: form.radius_vehicle_id || null,
                        capacity: form.capacity ? Number(form.capacity) : null,
                        is_blocked_manual: Boolean(form.blocked_reason),
                        insurance_expiry: form.insurance_expiry || null,
                        road_tax_expiry: form.road_tax_expiry || null,
                        inspection_expiry: form.inspection_expiry || null,
                      });
                      if (ok && isNewVehicle) setIsNewVehicle(false);
                    }}
                  >
                    {saving ? "Salvataggio..." : isNewVehicle ? "Crea mezzo" : "Salva mezzo"}
                  </button>
                  {!isNewVehicle && form.radius_vehicle_id ? (
                    <a href="/mappa-live" className="rounded-xl border border-teal-200 bg-teal-50 px-3 py-2 text-xs font-medium text-teal-700 hover:bg-teal-100 flex items-center">
                      GPS
                    </a>
                  ) : null}
                  {!isNewVehicle && selectedVehicle ? (
                    <button
                      type="button"
                      disabled={saving}
                      className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                      onClick={async () => {
                        if (!confirm(`Eliminare definitivamente "${selectedVehicle.label}"?`)) return;
                        const ok = await post({ action: "delete_vehicle", id: selectedVehicle.id });
                        if (ok) setSelectedVehicleId("");
                      }}
                    >
                      Elimina
                    </button>
                  ) : null}
                </div>

                {/* Documenti, blocco e anomalie solo in modifica */}
                {!isNewVehicle && selectedVehicle ? (
                  <>
                    <details className="rounded-xl border border-slate-200" open={
                      expiryStatus(selectedVehicle.insurance_expiry) !== "ok" ||
                      expiryStatus(selectedVehicle.road_tax_expiry) !== "ok" ||
                      expiryStatus(selectedVehicle.inspection_expiry) !== "ok"
                    }>
                      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-slate-700">
                        Scadenze documenti
                      </summary>
                      <div className="grid grid-cols-1 gap-3 border-t border-slate-100 px-4 py-3">
                        {[
                          { label: "Assicurazione", field: "insurance_expiry" as const, val: selectedVehicle.insurance_expiry },
                          { label: "Bollo",          field: "road_tax_expiry"   as const, val: selectedVehicle.road_tax_expiry },
                          { label: "Collaudo",       field: "inspection_expiry" as const, val: selectedVehicle.inspection_expiry },
                        ].map(({ label, field, val }) => {
                          const status = expiryStatus(form[field] || val);
                          return (
                            <label key={field} className="text-xs font-semibold text-slate-500">
                              <div className="flex items-center justify-between">
                                <span>{label}</span>
                                {form[field] && (
                                  <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${EXPIRY_BADGE[status]}`}>
                                    {status === "expired" ? "Scaduto" : status === "soon" ? "In scadenza" : "OK"}
                                  </span>
                                )}
                              </div>
                              <input
                                type="date"
                                className="input-saas mt-1 w-full"
                                value={form[field]}
                                onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </details>

                    <details className="rounded-xl border border-slate-200">
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700 select-none">
                        {selectedVehicle.is_blocked_manual || selectedVehicle.blocked_until ? "⚠ Mezzo bloccato — modifica blocco" : "Blocca mezzo"}
                      </summary>
                      <div className="grid grid-cols-2 gap-3 border-t border-slate-100 px-4 py-3">
                        <label className="col-span-2 text-xs font-semibold text-slate-500">
                          Motivo blocco
                          <input className="input-saas mt-1 w-full" value={form.blocked_reason} onChange={(e) => setForm((f) => ({ ...f, blocked_reason: e.target.value }))} placeholder="Guasto, revisione..." />
                        </label>
                        <label className="col-span-2 text-xs font-semibold text-slate-500">
                          Bloccato fino a
                          <input type="datetime-local" className="input-saas mt-1 w-full" value={form.blocked_until} onChange={(e) => setForm((f) => ({ ...f, blocked_until: e.target.value }))} />
                        </label>
                      </div>
                    </details>

                    {selectedAnomalies.length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Anomalie aperte ({selectedAnomalies.length})</p>
                        {selectedAnomalies.map((anomaly) => (
                          <div key={anomaly.id} className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-sm">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="font-semibold text-slate-800">{anomaly.title}</p>
                                <p className="text-xs text-slate-500">{anomaly.description ?? ""}</p>
                              </div>
                              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SEVERITY_BADGE[anomaly.severity]}`}>
                                {SEVERITY_LABEL[anomaly.severity]}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                              onClick={() => void post({ action: "resolve_anomaly", anomaly_id: anomaly.id, vehicle_id: selectedVehicle.id })}
                            >
                              Segna come risolto
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <details className="rounded-xl border border-slate-200" open={showAnomalyPanel}>
                      <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700 select-none" onClick={() => setShowAnomalyPanel((v) => !v)}>
                        Segnala anomalia
                      </summary>
                      <div className="grid gap-3 border-t border-slate-100 px-4 py-3">
                        <label className="text-xs font-semibold text-slate-500">
                          Titolo
                          <input className="input-saas mt-1 w-full" value={anomalyForm.title} onChange={(e) => setAnomalyForm((f) => ({ ...f, title: e.target.value }))} placeholder="es. Pneumatico forato" />
                        </label>
                        <label className="text-xs font-semibold text-slate-500">
                          Gravità
                          <select className="input-saas mt-1 w-full" value={anomalyForm.severity} onChange={(e) => setAnomalyForm((f) => ({ ...f, severity: e.target.value }))}>
                            <option value="low">Bassa</option>
                            <option value="medium">Media</option>
                            <option value="high">Alta</option>
                            <option value="blocking">Bloccante</option>
                          </select>
                        </label>
                        <label className="text-xs font-semibold text-slate-500">
                          Bloccato fino a (opzionale)
                          <input type="datetime-local" className="input-saas mt-1 w-full" value={anomalyForm.blocked_until} onChange={(e) => setAnomalyForm((f) => ({ ...f, blocked_until: e.target.value }))} />
                        </label>
                        <label className="text-xs font-semibold text-slate-500">
                          Descrizione
                          <textarea rows={2} className="input-saas mt-1 w-full resize-none" value={anomalyForm.description} onChange={(e) => setAnomalyForm((f) => ({ ...f, description: e.target.value }))} />
                        </label>
                        <button
                          type="button"
                          className="btn-secondary py-2 text-sm"
                          onClick={() => {
                            void post({
                              action: "report_anomaly",
                              vehicle_id: selectedVehicle.id,
                              title: anomalyForm.title,
                              severity: anomalyForm.severity,
                              blocked_until: anomalyForm.blocked_until || null,
                              description: anomalyForm.description || null,
                            });
                            setAnomalyForm(EMPTY_ANOMALY);
                            setShowAnomalyPanel(false);
                          }}
                        >
                          Invia segnalazione
                        </button>
                      </div>
                    </details>
                  </>
                ) : null}
              </div>
            )}
          </SectionCard>

          {/* Autisti */}
          <SectionCard title="Elenco autisti">
            <div className="divide-y divide-slate-100">
              {drivers.map((driver) => (
                <div key={driver.id} className="flex items-center justify-between gap-2 py-2.5 first:pt-0">
                  <span className="font-medium text-slate-800">{driver.full_name}</span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {driver.phone ? (
                      <a href={`tel:${driver.phone}`} className="text-sm text-blue-600 hover:underline">{driver.phone}</a>
                    ) : (
                      <span className="text-xs text-slate-300">N/D</span>
                    )}
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-500 hover:border-blue-300 hover:text-blue-600"
                      onClick={() => { setEditingDriverId(driver.id); setDriverForm({ full_name: driver.full_name, phone: driver.phone ?? "" }); setDriverFormOpen(true); }}
                    >
                      Modifica
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-2 py-0.5 text-xs text-slate-400 hover:border-rose-200 hover:text-rose-600"
                      onClick={async () => {
                        if (!confirm(`Rimuovere ${driver.full_name} dall'elenco?`)) return;
                        await post({ action: "delete_driver", id: driver.id });
                      }}
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
              {drivers.length === 0 ? <p className="text-sm text-muted">Nessun autista.</p> : null}
            </div>

            <div className="mt-3 border-t border-slate-100 pt-3">
              {!driverFormOpen ? (
                <button
                  type="button"
                  className="text-xs font-medium text-blue-600 hover:underline"
                  onClick={() => { setDriverFormOpen(true); setEditingDriverId(null); setDriverForm({ full_name: "", phone: "" }); }}
                >
                  + Nuovo autista
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-500">{editingDriverId ? "Modifica autista" : "Nuovo autista"}</p>
                  <label className="block text-xs font-semibold text-slate-500">
                    Nome e cognome
                    <input className="input-saas mt-1 w-full" value={driverForm.full_name} onChange={(e) => setDriverForm((f) => ({ ...f, full_name: e.target.value }))} placeholder="es. Mario Rossi" />
                  </label>
                  <label className="block text-xs font-semibold text-slate-500">
                    Telefono
                    <input className="input-saas mt-1 w-full" value={driverForm.phone} onChange={(e) => setDriverForm((f) => ({ ...f, phone: e.target.value }))} placeholder="es. 3471234567" />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={saving || !driverForm.full_name.trim()}
                      className="btn-primary flex-1 py-1.5 text-xs disabled:opacity-50"
                      onClick={async () => {
                        const ok = await post({
                          action: "upsert_driver",
                          ...(editingDriverId ? { id: editingDriverId } : {}),
                          full_name: driverForm.full_name.trim(),
                          phone: driverForm.phone.trim() || null,
                        });
                        if (ok) { setDriverFormOpen(false); setEditingDriverId(null); setDriverForm({ full_name: "", phone: "" }); }
                      }}
                    >
                      {saving ? "..." : editingDriverId ? "Salva" : "Crea"}
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50"
                      onClick={() => { setDriverFormOpen(false); setEditingDriverId(null); }}
                    >
                      Annulla
                    </button>
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        </div>
      </div>
    </section>
  );
}
