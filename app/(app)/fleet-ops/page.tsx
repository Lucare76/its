"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type Vehicle = {
  id: string;
  label: string;
  plate?: string | null;
  license_number?: string | null;
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
  qr_token?: string | null;
  km?: number | null;
  telaio?: string | null;
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

type Commitment = {
  id: string;
  vehicle_id: string;
  commitment_date: string;
  commitment_type: "collaudo" | "officina" | "fermo_amministrativo" | "altro";
  notes: string | null;
  created_at: string;
};

const COMMITMENT_LABELS: Record<string, string> = {
  collaudo:              "Collaudo",
  officina:              "Officina / Manutenzione",
  fermo_amministrativo:  "Fermo amministrativo",
  altro:                 "Altro",
};

const COMMITMENT_BADGE: Record<string, string> = {
  collaudo:              "bg-blue-50 text-blue-700 border-blue-200",
  officina:              "bg-amber-50 text-amber-700 border-amber-200",
  fermo_amministrativo:  "bg-rose-50 text-rose-700 border-rose-200",
  altro:                 "bg-slate-50 text-slate-600 border-slate-200",
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
  km: "",
  telaio: "",
  license_number: "",
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

function getVehicleDocumentSummary(vehicle: Vehicle) {
  const docs = [
    { key: "Ass.", val: vehicle.insurance_expiry },
    { key: "Bollo", val: vehicle.road_tax_expiry },
    { key: "Coll.", val: vehicle.inspection_expiry },
  ];
  const worst = docs.reduce<"ok" | "soon" | "expired" | "none">((acc, doc) => {
    const status = expiryStatus(doc.val);
    if (status === "expired") return "expired";
    if (status === "soon" && acc !== "expired") return "soon";
    if (status === "ok" && acc === "none") return "ok";
    return acc;
  }, "none");
  const expiredDocs = docs.filter((doc) => expiryStatus(doc.val) === "expired").map((doc) => doc.key);
  const soonDocs = docs.filter((doc) => expiryStatus(doc.val) === "soon").map((doc) => doc.key);
  const label = expiredDocs.length ? `Scaduto: ${expiredDocs.join(", ")}` : soonDocs.length ? `In scadenza: ${soonDocs.join(", ")}` : worst === "ok" ? "Documenti in ordine" : "Nessun documento";
  return { worst, label };
}

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
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [appOrigin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [anomalyForm, setAnomalyForm] = useState(EMPTY_ANOMALY);
  const [showAnomalyPanel, setShowAnomalyPanel] = useState(false);
  const [sizeFilter, setSizeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [isNewVehicle, setIsNewVehicle] = useState(false);
  const [driverFormOpen, setDriverFormOpen] = useState(false);
  const [editingDriverId, setEditingDriverId] = useState<string | null>(null);
  const [driverForm, setDriverForm] = useState({ full_name: "", phone: "" });
  const vehicleListRef = useRef<HTMLDivElement | null>(null);

  const showToast = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const resetVehicleEditor = useCallback(() => {
    setForm(EMPTY_FORM);
    setShowAnomalyPanel(false);
    setAnomalyForm(EMPTY_ANOMALY);
  }, []);

  const populateVehicleEditor = useCallback((vehicle: Vehicle) => {
    setForm({
      label: vehicle.label,
      plate: vehicle.plate ?? "",
      vehicle_size: vehicle.vehicle_size ?? "medium",
      habitual_driver_profile_id: vehicle.habitual_driver_profile_id ?? "",
      default_zone: vehicle.default_zone ?? "",
      blocked_until: vehicle.blocked_until?.slice(0, 16) ?? "",
      blocked_reason: vehicle.blocked_reason ?? "",
      notes: vehicle.notes ?? "",
      radius_vehicle_id: vehicle.radius_vehicle_id ?? "",
      capacity: String(vehicle.capacity ?? ""),
      insurance_expiry: vehicle.insurance_expiry ?? "",
      road_tax_expiry: vehicle.road_tax_expiry ?? "",
      inspection_expiry: vehicle.inspection_expiry ?? "",
      km: String(vehicle.km ?? ""),
      telaio: vehicle.telaio ?? "",
      license_number: vehicle.license_number ?? "",
    });
    setShowAnomalyPanel(false);
    setAnomalyForm(EMPTY_ANOMALY);
  }, []);

  const load = useCallback(async () => {
    const token = await accessToken();
    if (!token) { setLoading(false); return; }
    const response = await fetch("/api/ops/vehicles", { headers: { Authorization: `Bearer ${token}` } });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; drivers?: Driver[]; anomalies?: Anomaly[]; commitments?: Commitment[] } | null;
    if (!response.ok || !body?.ok) { setLoading(false); showToast(body?.error ?? "Errore caricamento flotta.", false); return; }
    const nextVehicles = body.vehicles ?? [];
    setVehicles(nextVehicles);
    setDrivers(body.drivers ?? []);
    setAnomalies(body.anomalies ?? []);
    setCommitments(body.commitments ?? []);
    setSelectedVehicleId((current) => {
      if (current) return current;
      const firstVehicle = nextVehicles[0] ?? null;
      if (firstVehicle) populateVehicleEditor(firstVehicle);
      return firstVehicle?.id ?? "";
    });
    setLoading(false);
  }, [populateVehicleEditor, showToast]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selectedVehicleId) ?? null,
    [vehicles, selectedVehicleId]
  );

  const selectedAnomalies = anomalies.filter((a) => a.vehicle_id === selectedVehicleId && a.active);
  const driverNameById = useMemo(() => new Map(drivers.map((d) => [d.id, d.full_name])), [drivers]);

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    const token = await accessToken();
    if (!token) return false;
    setSaving(true);
    const response = await fetch("/api/ops/vehicles", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; vehicles?: Vehicle[]; anomalies?: Anomaly[]; drivers?: Driver[]; commitments?: Commitment[] } | null;
    setSaving(false);
    if (!response.ok || !json?.ok) { showToast(json?.error ?? "Operazione non riuscita.", false); return false; }
    setVehicles(json.vehicles ?? []);
    setDrivers(json.drivers ?? []);
    setAnomalies(json.anomalies ?? []);
    if (json.commitments) setCommitments(json.commitments);
    showToast("Salvato.", true);
    return true;
  };

  const fleetStats = useMemo(() => ({
    active: vehicles.filter((vehicle) => vehicle.active).length,
    inactive: vehicles.filter((vehicle) => !vehicle.active).length,
    blocked: vehicles.filter((vehicle) => vehicle.is_blocked_manual || vehicle.blocked_until).length,
    anomalies: anomalies.filter((anomaly) => anomaly.active).length,
    gpsMissing: vehicles.filter((vehicle) => !vehicle.radius_vehicle_id).length,
    docsCritical: vehicles.filter((vehicle) => {
      const summary = getVehicleDocumentSummary(vehicle);
      return summary.worst === "expired" || summary.worst === "soon";
    }).length,
  }), [anomalies, vehicles]);

  const urgentVehicles = useMemo(
    () => vehicles.filter((vehicle) => {
      const docSummary = getVehicleDocumentSummary(vehicle);
      return Boolean(vehicle.is_blocked_manual || vehicle.blocked_until)
        || docSummary.worst === "expired"
        || anomalies.some((anomaly) => anomaly.vehicle_id === vehicle.id && anomaly.active);
    }).length,
    [anomalies, vehicles]
  );

  const filteredVehicles = useMemo(() => {
    return vehicles.filter((vehicle) => {
      const matchesSize = sizeFilter === "all" || vehicle.vehicle_size === sizeFilter;
      const haystack = `${vehicle.label} ${vehicle.plate ?? ""} ${vehicle.license_number ?? ""} ${driverNameById.get(vehicle.habitual_driver_profile_id ?? "") ?? ""} ${vehicle.default_zone ?? ""}`.toLowerCase();
      const matchesSearch = !searchQuery.trim() || haystack.includes(searchQuery.trim().toLowerCase());
      const docSummary = getVehicleDocumentSummary(vehicle);
      const matchesStatus = statusFilter === "all"
        || (statusFilter === "blocked" && Boolean(vehicle.is_blocked_manual || vehicle.blocked_until))
        || (statusFilter === "attention" && (docSummary.worst === "expired" || docSummary.worst === "soon" || anomalies.some((anomaly) => anomaly.vehicle_id === vehicle.id && anomaly.active)))
        || (statusFilter === "anomalies" && anomalies.some((anomaly) => anomaly.vehicle_id === vehicle.id && anomaly.active))
        || (statusFilter === "docs" && (docSummary.worst === "expired" || docSummary.worst === "soon"))
        || (statusFilter === "inactive" && !vehicle.active)
        || (statusFilter === "gpsless" && !vehicle.radius_vehicle_id)
        || (statusFilter === "active" && vehicle.active && !vehicle.is_blocked_manual && !vehicle.blocked_until);
      return matchesSize && matchesSearch && matchesStatus;
    }).sort((a, b) => (b.capacity ?? 0) - (a.capacity ?? 0));
  }, [anomalies, driverNameById, searchQuery, sizeFilter, statusFilter, vehicles]);

  const focusProblemArea = useCallback((nextStatus: string) => {
    setStatusFilter(nextStatus);
    window.setTimeout(() => {
      vehicleListRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }, []);

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
        subtitle="Control room flotta: mezzi, licenze, documenti, anomalie e accesso rapido ai moduli operativi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta" }]}
        actions={
          <div className="flex flex-wrap gap-2">
            <a href="/fleet-ops/fuel" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100">Rifornimenti</a>
            <a href="/fleet-ops/maintenance" className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-800 hover:bg-orange-100">Manutenzioni</a>
            <a href="/fleet-ops/inventory" className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100">Ricambi</a>
            <a href="/fleet-ops/reports" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">Report costi/km</a>
          </div>
        }
      />

      {/* Toast */}
      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg transition-all ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      {/* Compact stats strip */}
      <div className="flex items-stretch gap-2">
        {[
          { label: "Attivi", value: fleetStats.active, accent: "bg-emerald-500", num: fleetStats.active > 0 ? "text-slate-900" : "text-slate-400", status: "active" },
          { label: "Inattivi", value: fleetStats.inactive, accent: "bg-slate-400", num: "text-slate-700", status: "inactive" },
          { label: "Bloccati", value: fleetStats.blocked, accent: fleetStats.blocked > 0 ? "bg-rose-500" : "bg-slate-200", num: fleetStats.blocked > 0 ? "text-rose-700" : "text-slate-400", status: "blocked" },
          { label: "Anomalie", value: fleetStats.anomalies, accent: fleetStats.anomalies > 0 ? "bg-amber-500" : "bg-slate-200", num: fleetStats.anomalies > 0 ? "text-amber-700" : "text-slate-400", status: "anomalies" },
          { label: "Senza GPS", value: fleetStats.gpsMissing, accent: "bg-sky-400", num: "text-sky-700", status: "gpsless" },
          { label: "Doc critici", value: fleetStats.docsCritical, accent: fleetStats.docsCritical > 0 ? "bg-fuchsia-500" : "bg-slate-200", num: fleetStats.docsCritical > 0 ? "text-fuchsia-700" : "text-slate-400", status: "docs" },
        ].map((stat) => (
          <button
            key={stat.label}
            type="button"
            onClick={() => focusProblemArea(stat.status)}
            className={`relative flex flex-1 flex-col overflow-hidden rounded-2xl border bg-white px-4 py-3 text-left transition hover:shadow-sm ${statusFilter === stat.status ? "border-slate-400 ring-1 ring-slate-300" : "border-slate-200 hover:border-slate-300"}`}
          >
            <span className={`absolute inset-x-0 top-0 h-[3px] ${stat.accent}`} />
            <span className={`text-2xl font-bold tabular-nums leading-none ${stat.num}`}>{stat.value}</span>
            <span className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{stat.label}</span>
          </button>
        ))}
        {urgentVehicles > 0 && (
          <button
            type="button"
            onClick={() => focusProblemArea("attention")}
            className="relative flex flex-col overflow-hidden rounded-2xl border border-rose-300 bg-rose-50 px-4 py-3 text-left transition hover:bg-rose-100"
          >
            <span className="absolute inset-x-0 top-0 h-[3px] bg-rose-600" />
            <span className="text-2xl font-bold tabular-nums leading-none text-rose-700">{urgentVehicles}</span>
            <span className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-rose-500">Urgenze</span>
          </button>
        )}
      </div>

      <div ref={vehicleListRef} className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">

        {/* ── Lista veicoli ───────────────────────────────────────────────── */}
        <div className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {/* Toolbar */}
          <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-slate-900">Veicoli</span>
              <span className="text-xs text-slate-400">{filteredVehicles.length} / {vehicles.length}</span>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Cerca mezzo, targa, autista..."
                className="w-56 rounded-xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-300"
              />
              <button
                type="button"
                onClick={() => { setIsNewVehicle(true); setSelectedVehicleId(""); resetVehicleEditor(); }}
                className="whitespace-nowrap rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
              >
                + Nuovo mezzo
              </button>
            </div>
          </div>
          {/* Filter bar */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-slate-100 px-3 py-2">
            {[
              ["all", "Tutti"],
              ["active", "Operativi"],
              ["inactive", "Inattivi"],
              ["blocked", "Bloccati"],
              ["attention", "Da controllare"],
              ["anomalies", "Anomalie"],
              ["docs", "Documenti"],
              ["gpsless", "Senza GPS"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setStatusFilter(value)}
                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${statusFilter === value ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
              >
                {label}
              </button>
            ))}
            <span className="mx-1.5 text-slate-200 select-none">|</span>
            {["all", "bus", "large", "medium", "small"].map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => setSizeFilter(size)}
                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition ${sizeFilter === size ? "border-blue-400 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
              >
                {size === "all" ? "Tutte taglie" : SIZE_LABEL[size]}
              </button>
            ))}
          </div>
          {/* Table */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] table-auto whitespace-nowrap text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-3 py-2">Veicolo</th>
                  <th className="px-3 py-2">Taglia / Posti</th>
                  <th className="px-3 py-2">Targa</th>
                  <th className="min-w-[120px] px-3 py-2">Autista</th>
                  <th className="px-3 py-2">GPS</th>
                  <th className="px-3 py-2">Documenti</th>
                  <th className="px-3 py-2">Oggi</th>
                  <th className="px-3 py-2">Stato</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredVehicles.map((vehicle) => {
                  const isSelected = vehicle.id === selectedVehicleId;
                  const isBlocked = Boolean(vehicle.is_blocked_manual || vehicle.blocked_until);
                  const hasGps = Boolean(vehicle.radius_vehicle_id);
                  const today = new Date().toISOString().slice(0, 10);
                  const todayCommitment = commitments.find((c) => c.vehicle_id === vehicle.id && c.commitment_date === today);
                  return (
                    <tr
                      key={vehicle.id}
                      onClick={() => { setSelectedVehicleId(vehicle.id); setIsNewVehicle(false); populateVehicleEditor(vehicle); }}
                      className={`cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : todayCommitment ? "bg-amber-50/40" : "hover:bg-slate-50"}`}
                    >
                      <td className="px-3 py-2">
                        <span className={`block max-w-[200px] truncate font-semibold ${isSelected ? "text-blue-800" : "text-slate-800"}`} title={vehicle.label}>{vehicle.label}</span>
                        {vehicle.license_number && <span className="block font-mono text-[10px] text-slate-400">{vehicle.license_number}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${SIZE_BADGE[vehicle.vehicle_size ?? ""] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                            {SIZE_LABEL[vehicle.vehicle_size ?? ""] ?? "N/D"}
                          </span>
                          {vehicle.capacity && <span className="text-xs font-semibold text-slate-500">{vehicle.capacity}p</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">{vehicle.plate ?? "—"}</td>
                      <td className="px-3 py-2">
                        <span className="block max-w-[120px] truncate text-xs text-slate-600" title={vehicle.habitual_driver_profile_id ? driverNameById.get(vehicle.habitual_driver_profile_id) ?? "" : ""}>
                          {vehicle.habitual_driver_profile_id ? driverNameById.get(vehicle.habitual_driver_profile_id) ?? "—" : <span className="text-slate-300">—</span>}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block h-2.5 w-2.5 rounded-full ${hasGps ? "bg-emerald-400" : "bg-slate-200"}`} title={hasGps ? vehicle.radius_vehicle_id ?? "" : "Nessun GPS"} />
                      </td>
                      <td className="px-3 py-2">
                        {(() => {
                          const docSummary = getVehicleDocumentSummary(vehicle);
                          if (docSummary.worst === "none") return <span className="text-slate-300 text-xs">—</span>;
                          return (
                            <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${EXPIRY_BADGE[docSummary.worst]}`} title={docSummary.label}>
                              {docSummary.worst === "expired" ? "⚠ Scaduto" : docSummary.worst === "soon" ? "⚠ In scad." : "✓ OK"}
                            </span>
                          );
                        })()}
                      </td>
                      <td className="px-3 py-2">
                        {todayCommitment ? (
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${COMMITMENT_BADGE[todayCommitment.commitment_type] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}
                            title={todayCommitment.notes ?? undefined}
                          >
                            {COMMITMENT_LABELS[todayCommitment.commitment_type] ?? todayCommitment.commitment_type}
                          </span>
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          title={vehicle.active ? "Clicca per disattivare" : "Clicca per attivare"}
                          onClick={() => void post({
                            action: "toggle_vehicle_active",
                            id: vehicle.id,
                            active: !vehicle.active,
                          })}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition hover:opacity-80 whitespace-nowrap ${
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
        </div>

        {/* ── Pannello modifica ───────────────────────────────────────────── */}
        <div className="space-y-4">
          <SectionCard title={isNewVehicle ? "Nuovo mezzo" : selectedVehicle ? selectedVehicle.label : "Seleziona un mezzo"} subtitle={isNewVehicle ? "Crea nuovo mezzo" : "Dettaglio e modifica"}>
            {!selectedVehicle && !isNewVehicle ? (
              <p className="text-sm text-muted">Clicca un veicolo nella tabella o crea un nuovo mezzo.</p>
            ) : (
              <div className="space-y-3">
                {!isNewVehicle && selectedVehicle ? (
                    <div className="rounded-2xl border border-slate-200 bg-[linear-gradient(135deg,rgba(248,250,252,0.98),rgba(241,245,249,0.96))] p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-900">{selectedVehicle.label}</p>
                        <p className="mt-1 font-mono text-sm text-slate-500">{selectedVehicle.plate ?? "Targa da inserire"}</p>
                        <p className="mt-1 text-xs font-medium text-slate-400">Licenza: <span className="font-mono text-slate-500">{selectedVehicle.license_number ?? "da inserire"}</span></p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${SIZE_BADGE[selectedVehicle.vehicle_size ?? ""] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                          {SIZE_LABEL[selectedVehicle.vehicle_size ?? ""] ?? "N/D"}
                        </span>
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${selectedVehicle.radius_vehicle_id ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-100 text-slate-500"}`}>
                          {selectedVehicle.radius_vehicle_id ? "GPS collegato" : "GPS mancante"}
                        </span>
                        {(() => {
                          const docSummary = getVehicleDocumentSummary(selectedVehicle);
                          if (docSummary.worst === "none") return null;
                          return (
                            <span className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${EXPIRY_BADGE[docSummary.worst]}`} title={docSummary.label}>
                              {docSummary.worst === "expired" ? "Documenti scaduti" : docSummary.worst === "soon" ? "Documenti in scadenza" : "Documenti OK"}
                            </span>
                          );
                        })()}
                        {selectedVehicle.is_blocked_manual || selectedVehicle.blocked_until ? (
                          <span className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-700">
                            Mezzo bloccato
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-3">
                      {[
                        {
                          label: "Autista abituale",
                          value: selectedVehicle.habitual_driver_profile_id ? driverNameById.get(selectedVehicle.habitual_driver_profile_id) ?? "—" : "Non assegnato",
                        },
                        {
                          label: "Zona abituale",
                          value: selectedVehicle.default_zone ?? "Non definita",
                        },
                        {
                          label: "Licenza mezzo",
                          value: selectedVehicle.license_number ?? "Non inserita",
                        },
                        {
                          label: "Operatività",
                          value: selectedAnomalies.length > 0 ? `${selectedAnomalies.length} anomalie aperte` : "Nessuna anomalia aperta",
                        },
                      ].map((item) => (
                        <div key={item.label} className="rounded-xl border border-slate-200 bg-white px-3 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{item.label}</p>
                          <p className="mt-1 text-sm font-medium text-slate-700">{item.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
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
                    Numero licenza automezzo
                    <input className="input-saas mt-1 w-full font-mono text-xs" value={form.license_number} onChange={(e) => setForm((f) => ({ ...f, license_number: e.target.value }))} placeholder="es. LIC-2026-015" />
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
                  <label className="text-xs font-semibold text-slate-500">
                    Chilometri
                    <input type="number" min="0" className="input-saas mt-1 w-full" value={form.km} onChange={(e) => setForm((f) => ({ ...f, km: e.target.value }))} placeholder="es. 231436" />
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Numero telaio
                    <input className="input-saas mt-1 w-full font-mono text-xs" value={form.telaio} onChange={(e) => setForm((f) => ({ ...f, telaio: e.target.value }))} placeholder="es. ZGA662R000E004247" />
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
                        km: form.km ? Number(form.km) : null,
                        telaio: form.telaio || null,
                        license_number: form.license_number || null,
                      });
                      if (ok && isNewVehicle) setIsNewVehicle(false);
                    }}
                  >
                    {saving ? "Salvataggio..." : isNewVehicle ? "Crea mezzo" : "Salva mezzo"}
                  </button>
                  {!isNewVehicle && selectedVehicle ? (
                    <a href={`/fleet-ops/vehicle/${selectedVehicle.id}`} className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 flex items-center">
                      📋 Scheda
                    </a>
                  ) : null}
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

                {!isNewVehicle && selectedVehicle ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <a href="/fleet-ops/fuel" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100">Apri coda rifornimenti</a>
                    <a href="/fleet-ops/maintenance" className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-800 hover:bg-orange-100">Apri registro manutenzioni</a>
                    <a href="/fleet-ops/inventory" className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-800 hover:bg-sky-100">Apri magazzino ricambi</a>
                    <a href="/fleet-ops/reports" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100">Apri report costi/km</a>
                  </div>
                ) : null}

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
                              <DateInput
                                className="input-saas mt-1 w-full"
                                value={form[field]}
                                onChange={(iso) => setForm((f) => ({ ...f, [field]: iso }))}
                              />
                            </label>
                          );
                        })}
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={saving || !selectedVehicle}
                            className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                            onClick={() => void post({
                              action: "set_vehicle_documents",
                              id: selectedVehicle.id,
                              insurance_expiry: form.insurance_expiry || null,
                              road_tax_expiry: form.road_tax_expiry || null,
                              inspection_expiry: form.inspection_expiry || null,
                            })}
                          >
                            Salva documenti
                          </button>
                        </div>
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
                        <div className="col-span-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={saving || !selectedVehicle}
                            className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                            onClick={() => void post({
                              action: "set_vehicle_block",
                              id: selectedVehicle.id,
                              blocked_reason: form.blocked_reason || null,
                              blocked_until: form.blocked_until ? new Date(form.blocked_until).toISOString() : null,
                              is_blocked_manual: Boolean(form.blocked_reason || form.blocked_until),
                            })}
                          >
                            Applica blocco
                          </button>
                          <button
                            type="button"
                            disabled={saving || !selectedVehicle}
                            className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                            onClick={() => void post({
                              action: "set_vehicle_block",
                              id: selectedVehicle.id,
                              blocked_reason: null,
                              blocked_until: null,
                              is_blocked_manual: false,
                            })}
                          >
                            Sblocca mezzo
                          </button>
                        </div>
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

                    {/* QR Code scheda digitale */}
                    {selectedVehicle.qr_token && (
                      <details className="rounded-xl border border-indigo-200 bg-indigo-50/40">
                        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-indigo-700">
                          📱 QR Code — Scheda digitale
                        </summary>
                        <div className="border-t border-indigo-100 px-4 py-3 flex flex-col items-center gap-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={appOrigin ? `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(`${appOrigin}/vehicle/${selectedVehicle.qr_token}`)}` : ""}
                            alt="QR Code"
                            width={160}
                            height={160}
                            className="rounded-lg border border-indigo-200"
                          />
                          <p className="text-xs text-indigo-600 text-center font-medium">
                            Scansiona per vedere la scheda del veicolo
                          </p>
                          <div className="flex gap-2 w-full">
                            <a
                              href={`/vehicle/${selectedVehicle.qr_token}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex-1 rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 text-center"
                            >
                              🔗 Apri pagina
                            </a>
                            <button
                              type="button"
                              onClick={() => {
                                const url = `${window.location.origin}/vehicle/${selectedVehicle.qr_token}`;
                                void navigator.clipboard.writeText(url);
                                showToast("Link copiato!", true);
                              }}
                              className="flex-1 rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                            >
                              📋 Copia link
                            </button>
                          </div>
                        </div>
                      </details>
                    )}

                    {/* Impegni non operativi */}
                    <CommitmentsPanel
                      vehicleId={selectedVehicle.id}
                      vehicleLabel={selectedVehicle.label}
                      commitments={commitments.filter((c) => c.vehicle_id === selectedVehicle.id)}
                      showToast={showToast}
                      onRefresh={() => void load()}
                    />

                    {/* QR Reports in attesa */}
                    <QrReportsPanel vehicleId={selectedVehicle.id} showToast={showToast} />

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

/* ─── QrReportsPanel ──────────────────────────────────────────────────────── */

type QrReport = {
  id: string;
  reporter_name: string | null;
  description: string;
  severity: "low" | "medium" | "high" | "blocking";
  photo_urls: string[] | null;
  status: string;
  created_at: string;
};

function QrReportsPanel({ vehicleId, showToast }: { vehicleId: string; showToast: (t: string, ok: boolean) => void }) {
  const [reports, setReports] = useState<QrReport[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      accessToken().then((token) => {
        if (!token) { setLoading(false); return; }
        fetch(`/api/ops/vehicle-records?vehicle_id=${vehicleId}&type=qr_reports`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json())
          .then((d) => { setReports(d.records ?? []); setLoading(false); })
          .catch(() => setLoading(false));
      });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [open, vehicleId]);

  const openReports = reports.filter((r) => r.status === "open");
  if (!open && openReports.length === 0 && reports.length === 0) {
    // lazy: non sappiamo ancora se ci sono reports, mostra sempre la sezione se aperta
  }

  async function acknowledge(id: string) {
    const token = await accessToken();
    if (!token) return;
    await fetch("/api/ops/vehicle-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "update", type: "qr_reports", id, data: { status: "acknowledged" } }),
    });
    setReports((prev) => prev.map((r) => r.id === id ? { ...r, status: "acknowledged" } : r));
    showToast("Segnalazione presa in carico.", true);
  }

  return (
    <details className="rounded-xl border border-orange-200 bg-orange-50/30" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-orange-700 flex items-center justify-between">
        <span>
          📱 Segnalazioni QR ricevute
          {openReports.length > 0 && (
            <span className="ml-2 inline-block rounded-full bg-orange-500 text-white text-[10px] font-bold px-1.5 py-0.5">{openReports.length}</span>
          )}
        </span>
        <a
          href="/inbox/fleet-reports"
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] font-semibold text-orange-600 hover:underline"
        >
          Vedi tutte →
        </a>
      </summary>
      <div className="border-t border-orange-100 px-4 py-3 space-y-3">
        {loading ? (
          <p className="text-xs text-slate-400">Caricamento...</p>
        ) : reports.length === 0 ? (
          <p className="text-xs text-slate-400">Nessuna segnalazione ricevuta.</p>
        ) : (
          reports.map((r) => (
            <div key={r.id} className={`rounded-xl border px-3 py-2.5 text-sm ${r.status === "open" ? "border-orange-300 bg-orange-50" : "border-slate-200 bg-slate-50 opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  {r.reporter_name && <div className="font-semibold text-slate-700 text-xs">{r.reporter_name}</div>}
                  <div className="text-slate-600 text-xs mt-0.5">{r.description}</div>
                  <div className="text-slate-400 text-[10px] mt-1">{new Date(r.created_at).toLocaleString("it-IT")}</div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    r.severity === "blocking" ? "bg-rose-100 text-rose-700" :
                    r.severity === "high"     ? "bg-orange-100 text-orange-700" :
                    r.severity === "medium"   ? "bg-amber-100 text-amber-700" :
                                                "bg-slate-100 text-slate-500"
                  }`}>
                    {r.severity === "blocking" ? "Bloccante" : r.severity === "high" ? "Alta" : r.severity === "medium" ? "Media" : "Bassa"}
                  </span>
                  {r.status === "open" && (
                    <button
                      type="button"
                      onClick={() => void acknowledge(r.id)}
                      className="text-[10px] font-semibold text-orange-700 hover:underline"
                    >
                      Prendi in carico
                    </button>
                  )}
                </div>
              </div>
              {r.photo_urls && r.photo_urls.length > 0 && (
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {r.photo_urls.map((url, pi) => (
                    <a key={pi} href={url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={url} alt={`Foto ${pi + 1}`} style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid #e2e8f0" }} />
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </details>
  );
}

/* ─── CommitmentsPanel ────────────────────────────────────────────────────── */

const EMPTY_COMMITMENT = { commitment_date: "", commitment_type: "collaudo", notes: "" };

function CommitmentsPanel({
  vehicleId,
  commitments,
  showToast,
  onRefresh,
}: {
  vehicleId: string;
  vehicleLabel: string;
  commitments: Commitment[];
  showToast: (t: string, ok: boolean) => void;
  onRefresh: () => void;
}) {
  const [form, setForm] = useState(EMPTY_COMMITMENT);
  const [saving, setSaving] = useState(false);

  async function addCommitment() {
    if (!form.commitment_date) { showToast("Seleziona una data.", false); return; }
    setSaving(true);
    const token = await accessToken();
    if (!token) { setSaving(false); return; }
    const res = await fetch("/api/ops/vehicle-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "insert",
        type: "commitments",
        vehicle_id: vehicleId,
        data: {
          commitment_date: form.commitment_date,
          commitment_type: form.commitment_type,
          notes: form.notes || null,
        },
      }),
    });
    setSaving(false);
    if (res.ok) {
      setForm(EMPTY_COMMITMENT);
      showToast("Impegno aggiunto.", true);
      onRefresh();
    } else {
      showToast("Errore durante il salvataggio.", false);
    }
  }

  async function deleteCommitment(id: string) {
    const token = await accessToken();
    if (!token) return;
    const res = await fetch("/api/ops/vehicle-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "delete", type: "commitments", id }),
    });
    if (res.ok) {
      showToast("Impegno rimosso.", true);
      onRefresh();
    } else {
      showToast("Errore durante la rimozione.", false);
    }
  }

  const sorted = [...commitments].sort((a, b) => a.commitment_date.localeCompare(b.commitment_date));

  return (
    <details className="rounded-xl border border-amber-200 bg-amber-50/30">
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium text-amber-800 flex items-center justify-between">
        <span>
          📅 Impegni non operativi
          {commitments.length > 0 && (
            <span className="ml-2 inline-block rounded-full bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5">{commitments.length}</span>
          )}
        </span>
      </summary>
      <div className="border-t border-amber-100 px-4 py-3 space-y-3">
        {sorted.length === 0 ? (
          <p className="text-xs text-slate-400">Nessun impegno pianificato.</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((c) => (
              <div key={c.id} className="flex items-start justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-700">
                      {new Date(`${c.commitment_date}T00:00:00`).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" })}
                    </span>
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${COMMITMENT_BADGE[c.commitment_type] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
                      {COMMITMENT_LABELS[c.commitment_type] ?? c.commitment_type}
                    </span>
                  </div>
                  {c.notes && <p className="mt-0.5 text-xs text-slate-500">{c.notes}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => void deleteCommitment(c.id)}
                  className="shrink-0 rounded-lg border border-slate-200 px-2 py-0.5 text-[10px] text-slate-400 hover:border-rose-200 hover:text-rose-600"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-amber-100 pt-3 grid grid-cols-2 gap-2">
          <label className="col-span-2 text-xs font-semibold text-slate-500">
            Data impegno
            <DateInput
              className="input-saas mt-1 w-full"
              value={form.commitment_date}
              onChange={(iso) => setForm((f) => ({ ...f, commitment_date: iso }))}
            />
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">
            Tipo
            <select
              className="input-saas mt-1 w-full"
              value={form.commitment_type}
              onChange={(e) => setForm((f) => ({ ...f, commitment_type: e.target.value }))}
            >
              {Object.entries(COMMITMENT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 text-xs font-semibold text-slate-500">
            Note (opzionale)
            <input
              className="input-saas mt-1 w-full"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="es. Officina Rossi, via Roma 12"
            />
          </label>
          <button
            type="button"
            disabled={saving || !form.commitment_date}
            className="col-span-2 btn-secondary py-1.5 text-xs disabled:opacity-50"
            onClick={() => void addCommitment()}
          >
            {saving ? "Salvataggio..." : "+ Aggiungi impegno"}
          </button>
        </div>
      </div>
    </details>
  );
}
