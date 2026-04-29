"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader, SectionCard, SidePanel } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type StatusLevel = "expired" | "critical" | "warning" | "missing" | "ok";

type ComplianceEntry = {
  expiry_date: string;
  days_left: number | null;
  status: StatusLevel;
  company?: string;
  outcome?: string;
  count?: number;
};

type ComplianceOverride = {
  until: string;
  reason: string;
};

type VehicleCompliance = {
  vehicle_id: string;
  label: string;
  plate: string | null;
  active: boolean;
  compliance_override: ComplianceOverride | null;
  insurance: ComplianceEntry | null;
  inspection: ComplianceEntry | null;
  extinguisher: ComplianceEntry | null;
  tachograph: ComplianceEntry | null;
  worst_status: StatusLevel;
};

type SidePanelVehicle = {
  vehicleId: string;
  label: string;
  plate: string | null;
};

const STATUS_RANK: Record<StatusLevel, number> = {
  expired: 0,
  critical: 1,
  warning: 2,
  missing: 3,
  ok: 4,
};

const STATUS_LABEL: Record<StatusLevel, string> = {
  expired: "Scaduto",
  critical: "Critico",
  warning: "In scadenza",
  missing: "Non inserito",
  ok: "Valido",
};

const STATUS_CELL: Record<StatusLevel, string> = {
  expired: "bg-rose-50 text-rose-700 border border-rose-200",
  critical: "bg-orange-50 text-orange-700 border border-orange-200",
  warning: "bg-amber-50 text-amber-700 border border-amber-200",
  missing: "bg-slate-50 text-slate-400 border border-slate-200",
  ok: "bg-emerald-50 text-emerald-700 border border-emerald-200",
};

const STATUS_ROW_BG: Record<StatusLevel, string> = {
  expired: "bg-rose-50/50 hover:bg-rose-50",
  critical: "bg-orange-50/40 hover:bg-orange-50",
  warning: "bg-amber-50/30 hover:bg-amber-50",
  missing: "hover:bg-slate-50",
  ok: "hover:bg-slate-50",
};

const STATUS_DOT: Record<StatusLevel, string> = {
  expired: "bg-rose-500",
  critical: "bg-orange-500",
  warning: "bg-amber-400",
  missing: "bg-slate-300",
  ok: "bg-emerald-500",
};

const STATUS_LEFT_BORDER: Record<StatusLevel, string> = {
  expired: "border-l-4 border-l-rose-400",
  critical: "border-l-4 border-l-orange-400",
  warning: "border-l-4 border-l-amber-400",
  missing: "border-l-4 border-l-slate-200",
  ok: "border-l-4 border-l-emerald-400",
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function formatDays(days: number | null): string {
  if (days === null) return "—";
  if (days < 0) return `${Math.abs(days)}gg fa`;
  if (days === 0) return "Oggi";
  return `${days}gg`;
}

async function getToken(): Promise<string | null> {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

type DocType = "all" | "insurance" | "inspection" | "extinguisher" | "tachograph";
type StatusFilter = "all" | "expired" | "critical" | "warning" | "ok";

const DOC_LABELS: Record<DocType, string> = {
  all: "Tutti",
  insurance: "Assicurazione",
  inspection: "Collaudo",
  extinguisher: "Estintori",
  tachograph: "Tachigrafo",
};

const EMPTY_INSURANCE = {
  company: "",
  policy_number: "",
  expiry_date: "",
  annual_amount_cents: "",
  notes: "",
};

const EMPTY_INSPECTION = {
  inspection_date: new Date().toISOString().slice(0, 10),
  expiry_date: "",
  inspection_center: "",
  outcome: "passed" as "passed" | "failed" | "pending",
  outcome_notes: "",
  notes: "",
};

const EMPTY_EXTINGUISHER = {
  serial_number: "",
  last_revision_date: "",
  expiry_date: "",
  notes: "",
};

// Mini compliance pill used in mobile cards
function CompliancePill({ label, entry }: { label: string; entry: ComplianceEntry | null }) {
  const status: StatusLevel = entry?.status ?? "missing";
  return (
    <div className={`rounded-xl px-3 py-2 text-xs ${STATUS_CELL[status]}`}>
      <div className="font-semibold opacity-60">{label}</div>
      {entry ? (
        <div className="mt-0.5 font-bold">{formatDays(entry.days_left)}</div>
      ) : (
        <div className="mt-0.5 font-bold">—</div>
      )}
    </div>
  );
}

// Compact 4-dot compliance indicator for table view
function ComplianceDots({ item }: { item: VehicleCompliance }) {
  const docs: [string, ComplianceEntry | null][] = [
    ["A", item.insurance],
    ["C", item.inspection],
    ["E", item.extinguisher],
    ["T", item.tachograph],
  ];
  return (
    <div className="flex items-center gap-1">
      {docs.map(([letter, entry]) => {
        const s: StatusLevel = entry?.status ?? "missing";
        return (
          <span
            key={letter}
            title={`${letter === "A" ? "Assicurazione" : letter === "C" ? "Collaudo" : letter === "E" ? "Estintori" : "Tachigrafo"}${entry ? ` · ${formatDays(entry.days_left)}` : " · Non inserito"}`}
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${
              s === "expired" ? "bg-rose-500 text-white" :
              s === "critical" ? "bg-orange-500 text-white" :
              s === "warning" ? "bg-amber-400 text-white" :
              s === "missing" ? "bg-slate-200 text-slate-400" :
              "bg-emerald-100 text-emerald-700"
            }`}
          >
            {letter}
          </span>
        );
      })}
    </div>
  );
}

export default function ScadenzePage() {
  const [items, setItems] = useState<VehicleCompliance[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [search, setSearch] = useState("");
  const [docFilter, setDocFilter] = useState<DocType>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [panel, setPanel] = useState<SidePanelVehicle | null>(null);
  const [panelTab, setPanelTab] = useState<"insurance" | "inspection" | "extinguisher">("insurance");
  const [panelRecords, setPanelRecords] = useState<{
    insurances: unknown[];
    inspections: unknown[];
    extinguishers: unknown[];
  }>({ insurances: [], inspections: [], extinguishers: [] });
  const [panelLoading, setPanelLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [insuranceForm, setInsuranceForm] = useState(EMPTY_INSURANCE);
  const [inspectionForm, setInspectionForm] = useState(EMPTY_INSPECTION);
  const [extinguisherForm, setExtinguisherForm] = useState(EMPTY_EXTINGUISHER);
  const [showForm, setShowForm] = useState(false);
  const [overrideForm, setOverrideForm] = useState({ until: "", reason: "" });
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);

  const showToast = useCallback((text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 4000);
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    const res = await fetch("/api/vehicles/compliance/summary", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => null) as { items?: VehicleCompliance[] } | null;
    setItems(json?.items ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const loadPanelRecords = useCallback(async (vehicleId: string) => {
    const token = await getToken();
    if (!token) return;
    setPanelLoading(true);
    const [insRes, inspRes, extRes] = await Promise.all([
      fetch(`/api/vehicles/${vehicleId}/compliance/insurances`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/vehicles/${vehicleId}/compliance/inspections`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`/api/vehicles/${vehicleId}/compliance/extinguishers`, { headers: { Authorization: `Bearer ${token}` } }),
    ]);
    const [insJson, inspJson, extJson] = await Promise.all([
      insRes.json().catch(() => ({ items: [] })),
      inspRes.json().catch(() => ({ items: [] })),
      extRes.json().catch(() => ({ items: [] })),
    ]);
    setPanelRecords({
      insurances: insJson.items ?? [],
      inspections: inspJson.items ?? [],
      extinguishers: extJson.items ?? [],
    });
    setPanelLoading(false);
  }, []);

  const openPanel = useCallback((v: VehicleCompliance) => {
    setPanel({ vehicleId: v.vehicle_id, label: v.label, plate: v.plate });
    setShowForm(false);
    setShowOverrideForm(false);
    setOverrideForm({ until: "", reason: "" });
    setInsuranceForm(EMPTY_INSURANCE);
    setInspectionForm(EMPTY_INSPECTION);
    setExtinguisherForm(EMPTY_EXTINGUISHER);
    void loadPanelRecords(v.vehicle_id);
  }, [loadPanelRecords]);

  const handleOverride = useCallback(async (clear?: boolean) => {
    if (!panel) return;
    const token = await getToken();
    if (!token) return;
    if (!clear && (!overrideForm.until || !overrideForm.reason.trim())) {
      showToast("Data limite e motivazione obbligatori", false);
      return;
    }
    setSavingOverride(true);
    const res = await fetch(`/api/vehicles/${panel.vehicleId}/compliance/override`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(clear ? { clear: true } : { until: overrideForm.until, reason: overrideForm.reason }),
    });
    const json = await res.json().catch(() => null) as { error?: string } | null;
    if (!res.ok) {
      showToast(json?.error ?? "Errore", false);
    } else {
      showToast(clear ? "Override rimosso" : "Override impostato", true);
      setShowOverrideForm(false);
      await load();
    }
    setSavingOverride(false);
  }, [panel, overrideForm, showToast, load]);

  const handleSave = useCallback(async () => {
    if (!panel) return;
    const token = await getToken();
    if (!token) return;
    setSaving(true);

    let url = "";
    let body: Record<string, unknown> = {};

    if (panelTab === "insurance") {
      if (!insuranceForm.company || !insuranceForm.expiry_date) {
        showToast("Compagnia e data scadenza obbligatori", false);
        setSaving(false);
        return;
      }
      url = `/api/vehicles/${panel.vehicleId}/compliance/insurances`;
      body = {
        company: insuranceForm.company,
        policy_number: insuranceForm.policy_number || null,
        expiry_date: insuranceForm.expiry_date,
        annual_amount_cents: insuranceForm.annual_amount_cents
          ? Math.round(parseFloat(insuranceForm.annual_amount_cents) * 100)
          : null,
        notes: insuranceForm.notes || null,
      };
    } else if (panelTab === "inspection") {
      if (!inspectionForm.expiry_date) {
        showToast("Data scadenza obbligatoria", false);
        setSaving(false);
        return;
      }
      url = `/api/vehicles/${panel.vehicleId}/compliance/inspections`;
      body = {
        inspection_date: inspectionForm.inspection_date,
        expiry_date: inspectionForm.expiry_date,
        inspection_center: inspectionForm.inspection_center || null,
        outcome: inspectionForm.outcome,
        outcome_notes: inspectionForm.outcome_notes || null,
        notes: inspectionForm.notes || null,
      };
    } else {
      if (!extinguisherForm.expiry_date) {
        showToast("Data scadenza obbligatoria", false);
        setSaving(false);
        return;
      }
      url = `/api/vehicles/${panel.vehicleId}/compliance/extinguishers`;
      body = {
        serial_number: extinguisherForm.serial_number || null,
        last_revision_date: extinguisherForm.last_revision_date || null,
        expiry_date: extinguisherForm.expiry_date,
        notes: extinguisherForm.notes || null,
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null) as { error?: string } | null;

    if (!res.ok) {
      showToast(json?.error ?? "Errore salvataggio", false);
    } else {
      showToast("Salvato", true);
      setShowForm(false);
      await Promise.all([loadPanelRecords(panel.vehicleId), load()]);
    }
    setSaving(false);
  }, [panel, panelTab, insuranceForm, inspectionForm, extinguisherForm, showToast, loadPanelRecords, load]);

  const stats = useMemo(() => {
    let expired = 0, critical = 0, warning = 0, ok = 0;
    for (const item of items) {
      if (!item.active) continue;
      const s = item.worst_status;
      if (s === "expired") expired++;
      else if (s === "critical") critical++;
      else if (s === "warning") warning++;
      else ok++;
    }
    return { expired, critical, warning, ok, total: items.filter((i) => i.active).length };
  }, [items]);

  const filtered = useMemo(() => {
    return items
      .filter((item) => {
        if (!item.active) return false;
        if (search) {
          const q = search.toLowerCase();
          if (!item.label.toLowerCase().includes(q) && !(item.plate ?? "").toLowerCase().includes(q)) return false;
        }
        if (statusFilter !== "all") {
          if (item.worst_status !== statusFilter) return false;
        }
        if (docFilter !== "all") {
          const entry = item[docFilter as keyof VehicleCompliance] as ComplianceEntry | null;
          const s = entry?.status ?? "missing";
          if (statusFilter !== "all" && s !== statusFilter) return false;
        }
        return true;
      })
      .sort((a, b) => STATUS_RANK[a.worst_status] - STATUS_RANK[b.worst_status]);
  }, [items, search, docFilter, statusFilter]);

  const toggleStatusFilter = (s: StatusFilter) => {
    setStatusFilter((prev) => prev === s ? "all" : s);
  };

  const renderTableCell = (entry: ComplianceEntry | null) => {
    if (!entry) {
      return <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium bg-slate-50 text-slate-400 border border-slate-200">—</span>;
    }
    return (
      <span className={`inline-flex flex-col gap-0.5 rounded-lg px-2 py-1 text-xs font-medium ${STATUS_CELL[entry.status]}`}>
        <span>{formatDate(entry.expiry_date)}</span>
        <span className="opacity-75">{formatDays(entry.days_left)}</span>
      </span>
    );
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Scadenze documenti"
        subtitle="Assicurazioni, collaudi, estintori e tachigrafi — stato in tempo reale."
        breadcrumbs={[
          { label: "Operazioni", href: "/dashboard" },
          { label: "Flotta", href: "/fleet-ops" },
          { label: "Scadenze documenti" },
        ]}
      />

      {/* Clickable stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          { key: "expired" as StatusFilter, label: "Scaduti", value: stats.expired, color: "text-rose-700", bg: "bg-rose-50 border-rose-200", ring: "ring-rose-400" },
          { key: "critical" as StatusFilter, label: "Critici (≤7 gg)", value: stats.critical, color: "text-orange-700", bg: "bg-orange-50 border-orange-200", ring: "ring-orange-400" },
          { key: "warning" as StatusFilter, label: "In scadenza (≤30 gg)", value: stats.warning, color: "text-amber-700", bg: "bg-amber-50 border-amber-200", ring: "ring-amber-400" },
          { key: "ok" as StatusFilter, label: "Validi", value: stats.ok, color: "text-emerald-700", bg: "bg-white border-slate-200", ring: "ring-emerald-400" },
        ]).map((stat) => (
          <button
            key={stat.key}
            type="button"
            onClick={() => toggleStatusFilter(stat.key)}
            className={`rounded-2xl border p-4 text-left transition-all ${stat.bg} ${statusFilter === stat.key ? `ring-2 ${stat.ring}` : "hover:opacity-80"}`}
          >
            <div className={`text-3xl font-bold tabular-nums ${stat.color}`}>
              {loading ? <span className="text-slate-300">…</span> : stat.value}
            </div>
            <div className="mt-1 text-xs text-slate-500">{stat.label}</div>
            {statusFilter === stat.key && (
              <div className="mt-1.5 text-[10px] font-semibold text-slate-500">Filtro attivo · clicca per rimuovere</div>
            )}
          </button>
        ))}
      </div>

      {/* Filter bar */}
      <SectionCard>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="text"
            placeholder="Cerca mezzo o targa…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input-saas h-9 w-full sm:w-64"
          />
          <select
            value={docFilter}
            onChange={(e) => setDocFilter(e.target.value as DocType)}
            className="input-saas h-9 w-full sm:w-44"
          >
            {(Object.keys(DOC_LABELS) as DocType[]).map((k) => (
              <option key={k} value={k}>{DOC_LABELS[k]}</option>
            ))}
          </select>
          {(search || statusFilter !== "all" || docFilter !== "all") && (
            <button
              type="button"
              onClick={() => { setSearch(""); setStatusFilter("all"); setDocFilter("all"); }}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50"
            >
              Azzera filtri
            </button>
          )}
          <div className="ml-auto text-xs text-slate-400 shrink-0">
            {loading ? "Caricamento…" : `${filtered.length} veicol${filtered.length === 1 ? "o" : "i"}`}
          </div>
        </div>
      </SectionCard>

      {loading ? (
        <SectionCard>
          <div className="py-12 text-center text-sm text-slate-400">Caricamento...</div>
        </SectionCard>
      ) : filtered.length === 0 ? (
        <SectionCard>
          <div className="py-12 text-center text-sm text-slate-400">Nessun veicolo trovato per i filtri correnti</div>
        </SectionCard>
      ) : (
        <>
          {/* Mobile card grid (hidden on sm+) */}
          <div className="sm:hidden space-y-3">
            {filtered.map((item) => (
              <button
                key={item.vehicle_id}
                type="button"
                onClick={() => openPanel(item)}
                className={`w-full rounded-2xl border bg-white text-left shadow-sm transition-shadow hover:shadow-md ${STATUS_LEFT_BORDER[item.worst_status]}`}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold text-slate-900">{item.label}</div>
                      {item.plate && <div className="text-xs font-mono text-slate-500">{item.plate}</div>}
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_CELL[item.worst_status]}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[item.worst_status]}`} />
                        {STATUS_LABEL[item.worst_status]}
                      </span>
                      {item.compliance_override && (
                        <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                          Forzato
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <CompliancePill label="Assicurazione" entry={item.insurance} />
                    <CompliancePill label="Collaudo" entry={item.inspection} />
                    <CompliancePill label="Estintori" entry={item.extinguisher} />
                    <CompliancePill label="Tachigrafo" entry={item.tachograph} />
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Desktop table (hidden on <sm) */}
          <SectionCard className="hidden sm:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <th className="pb-3 pr-3">Mezzo</th>
                    <th className="pb-3 pr-3">Stato</th>
                    <th className="hidden pb-3 pr-3 md:table-cell">Ind.</th>
                    <th className="pb-3 pr-3">Assicurazione</th>
                    <th className="hidden pb-3 pr-3 md:table-cell">Collaudo</th>
                    <th className="hidden pb-3 pr-3 lg:table-cell">Estintori</th>
                    <th className="hidden pb-3 lg:table-cell">Tachigrafo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((item) => (
                    <tr
                      key={item.vehicle_id}
                      className={`cursor-pointer transition-colors ${STATUS_ROW_BG[item.worst_status]}`}
                      onClick={() => openPanel(item)}
                    >
                      <td className="py-3 pr-3">
                        <div className="font-semibold text-slate-800">{item.label}</div>
                        {item.plate && <div className="text-xs font-mono text-slate-400">{item.plate}</div>}
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex flex-col gap-1">
                          <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CELL[item.worst_status]}`}>
                            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[item.worst_status]}`} />
                            {STATUS_LABEL[item.worst_status]}
                          </span>
                          {item.compliance_override && (
                            <span className="inline-flex w-fit items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                              Forzato
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="hidden py-3 pr-3 md:table-cell">
                        <ComplianceDots item={item} />
                      </td>
                      <td className="py-3 pr-3">{renderTableCell(item.insurance)}</td>
                      <td className="hidden py-3 pr-3 md:table-cell">{renderTableCell(item.inspection)}</td>
                      <td className="hidden py-3 pr-3 lg:table-cell">{renderTableCell(item.extinguisher)}</td>
                      <td className="hidden py-3 lg:table-cell">{renderTableCell(item.tachograph)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}

      {/* Side panel */}
      <SidePanel
        open={!!panel}
        title={panel?.label ?? ""}
        subtitle={panel?.plate ?? undefined}
        onClose={() => setPanel(null)}
        widthClassName="max-w-xl"
      >
        {panel && (() => {
          const panelVehicle = items.find((i) => i.vehicle_id === panel.vehicleId);
          const activeOverride = panelVehicle?.compliance_override ?? null;
          return (
            <div className="space-y-5">
              {/* Override status */}
              {activeOverride ? (
                <div className="rounded-xl border border-violet-200 bg-violet-50 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-violet-800">Operatività forzata attiva</div>
                      <div className="mt-0.5 text-xs text-violet-700">{activeOverride.reason}</div>
                      <div className="mt-0.5 text-xs text-violet-600">
                        Scade: {formatDate(activeOverride.until.slice(0, 10))}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleOverride(true)}
                      disabled={savingOverride}
                      className="rounded-lg border border-violet-300 bg-white px-3 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50"
                    >
                      Rimuovi
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  {!showOverrideForm ? (
                    <button
                      type="button"
                      onClick={() => setShowOverrideForm(true)}
                      className="w-full rounded-xl border border-dashed border-orange-300 bg-orange-50 py-2 text-xs font-semibold text-orange-700 hover:bg-orange-100"
                    >
                      Forza operatività mezzo (override scadenze)
                    </button>
                  ) : (
                    <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 space-y-3">
                      <div className="text-sm font-semibold text-orange-800">Override operativo</div>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <div>
                          <label className="label text-xs">Valido fino al *</label>
                          <input
                            type="date"
                            className="input text-sm"
                            value={overrideForm.until}
                            onChange={(e) => setOverrideForm((f) => ({ ...f, until: e.target.value }))}
                          />
                        </div>
                        <div>
                          <label className="label text-xs">Motivazione *</label>
                          <input
                            className="input text-sm"
                            placeholder="es. Polizza in rinnovo"
                            value={overrideForm.reason}
                            onChange={(e) => setOverrideForm((f) => ({ ...f, reason: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleOverride(false)}
                          disabled={savingOverride}
                          className="btn-primary flex-1 text-sm"
                        >
                          {savingOverride ? "..." : "Conferma override"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowOverrideForm(false)}
                          className="btn-secondary text-sm"
                        >
                          Annulla
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Tab bar */}
              <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
                {(["insurance", "inspection", "extinguisher"] as const).map((tab) => {
                  const labels = { insurance: "Assicurazione", inspection: "Collaudo", extinguisher: "Estintori" };
                  const entry = panelVehicle?.[tab === "insurance" ? "insurance" : tab === "inspection" ? "inspection" : "extinguisher"] ?? null;
                  const s: StatusLevel = entry?.status ?? "missing";
                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => { setPanelTab(tab); setShowForm(false); }}
                      className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors ${
                        panelTab === tab ? "bg-white shadow text-slate-900" : "text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      <span className="flex items-center justify-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[s]}`} />
                        {labels[tab]}
                      </span>
                    </button>
                  );
                })}
              </div>

              {panelLoading ? (
                <div className="py-8 text-center text-slate-400 text-sm">Caricamento...</div>
              ) : (
                <>
                  <RecordList tab={panelTab} records={panelRecords} />

                  {!showForm ? (
                    <button
                      type="button"
                      onClick={() => setShowForm(true)}
                      className="btn-primary w-full"
                    >
                      + Aggiungi / Rinnova
                    </button>
                  ) : (
                    <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
                      <div className="text-sm font-semibold text-slate-800">
                        {panelTab === "insurance" ? "Nuova assicurazione" : panelTab === "inspection" ? "Nuovo collaudo" : "Nuovo estintore"}
                      </div>

                      {panelTab === "insurance" && (
                        <>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">Compagnia *</label>
                              <input className="input" value={insuranceForm.company} onChange={(e) => setInsuranceForm((f) => ({ ...f, company: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">N. polizza</label>
                              <input className="input" value={insuranceForm.policy_number} onChange={(e) => setInsuranceForm((f) => ({ ...f, policy_number: e.target.value }))} />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">Scadenza *</label>
                              <input type="date" className="input" value={insuranceForm.expiry_date} onChange={(e) => setInsuranceForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Premio annuo (€)</label>
                              <input type="number" className="input" value={insuranceForm.annual_amount_cents} onChange={(e) => setInsuranceForm((f) => ({ ...f, annual_amount_cents: e.target.value }))} />
                            </div>
                          </div>
                          <div>
                            <label className="label">Note</label>
                            <input className="input" value={insuranceForm.notes} onChange={(e) => setInsuranceForm((f) => ({ ...f, notes: e.target.value }))} />
                          </div>
                        </>
                      )}

                      {panelTab === "inspection" && (
                        <>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">Data collaudo *</label>
                              <input type="date" className="input" value={inspectionForm.inspection_date} onChange={(e) => setInspectionForm((f) => ({ ...f, inspection_date: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Scadenza *</label>
                              <input type="date" className="input" value={inspectionForm.expiry_date} onChange={(e) => setInspectionForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">Centro revisioni</label>
                              <input className="input" value={inspectionForm.inspection_center} onChange={(e) => setInspectionForm((f) => ({ ...f, inspection_center: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Esito</label>
                              <select className="input" value={inspectionForm.outcome} onChange={(e) => setInspectionForm((f) => ({ ...f, outcome: e.target.value as typeof f.outcome }))}>
                                <option value="passed">Superato</option>
                                <option value="pending">In attesa</option>
                                <option value="failed">Bocciato</option>
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="label">Note</label>
                            <input className="input" value={inspectionForm.notes} onChange={(e) => setInspectionForm((f) => ({ ...f, notes: e.target.value }))} />
                          </div>
                        </>
                      )}

                      {panelTab === "extinguisher" && (
                        <>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">N. seriale</label>
                              <input className="input" value={extinguisherForm.serial_number} onChange={(e) => setExtinguisherForm((f) => ({ ...f, serial_number: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Scadenza *</label>
                              <input type="date" className="input" value={extinguisherForm.expiry_date} onChange={(e) => setExtinguisherForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                            </div>
                          </div>
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <div>
                              <label className="label">Ultima revisione</label>
                              <input type="date" className="input" value={extinguisherForm.last_revision_date} onChange={(e) => setExtinguisherForm((f) => ({ ...f, last_revision_date: e.target.value }))} />
                            </div>
                            <div>
                              <label className="label">Note</label>
                              <input className="input" value={extinguisherForm.notes} onChange={(e) => setExtinguisherForm((f) => ({ ...f, notes: e.target.value }))} />
                            </div>
                          </div>
                        </>
                      )}

                      <div className="flex gap-2 pt-1">
                        <button type="button" onClick={handleSave} disabled={saving} className="btn-primary flex-1">
                          {saving ? "Salvataggio..." : "Salva"}
                        </button>
                        <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">
                          Annulla
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}
      </SidePanel>

      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 rounded-2xl px-5 py-3 text-sm font-semibold text-white shadow-lg ${toast.ok ? "bg-emerald-600" : "bg-rose-600"}`}>
          {toast.text}
        </div>
      )}
    </section>
  );
}

type RecordListProps = {
  tab: "insurance" | "inspection" | "extinguisher";
  records: { insurances: unknown[]; inspections: unknown[]; extinguishers: unknown[] };
};

function RecordList({ tab, records }: RecordListProps) {
  const list =
    tab === "insurance" ? records.insurances
    : tab === "inspection" ? records.inspections
    : records.extinguishers;

  if (list.length === 0) {
    return <div className="py-4 text-sm text-slate-400 text-center">Nessun record presente</div>;
  }

  return (
    <div className="space-y-2">
      {(list as Record<string, unknown>[]).map((row, i) => {
        const isCurrent = row.is_current === true || row.active === true;
        const expiry = row.expiry_date as string | null;
        const today = new Date().toISOString().slice(0, 10);
        const days = expiry ? Math.floor((new Date(`${expiry}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86400000) : null;
        const status: StatusLevel = !expiry ? "missing" : days! < 0 ? "expired" : days! <= 7 ? "critical" : days! <= 30 ? "warning" : "ok";

        return (
          <div key={row.id as string ?? i} className={`rounded-xl border p-3 text-sm ${isCurrent ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-60"}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium text-slate-800">
                {tab === "insurance" && (row.company as string)}
                {tab === "inspection" && `Collaudo ${row.inspection_date ? formatDate(row.inspection_date as string) : ""}`}
                {tab === "extinguisher" && (row.serial_number ? `Sn: ${row.serial_number}` : "Estintore")}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {isCurrent && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Attivo</span>
                )}
                {expiry && (
                  <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold ${STATUS_CELL[status]}`}>
                    {formatDate(expiry)} · {formatDays(days)}
                  </span>
                )}
              </div>
            </div>
            {tab === "insurance" && !!row.policy_number && (
              <div className="mt-1 text-xs text-slate-400">Polizza: {row.policy_number as string}</div>
            )}
            {tab === "inspection" && !!row.outcome && (
              <div className="mt-1 text-xs text-slate-400">Esito: {row.outcome === "passed" ? "Superato" : row.outcome === "failed" ? "Bocciato" : "In attesa"}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
