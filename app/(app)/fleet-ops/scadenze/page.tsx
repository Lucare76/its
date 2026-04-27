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

type VehicleCompliance = {
  vehicle_id: string;
  label: string;
  plate: string | null;
  active: boolean;
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

const STATUS_DOT: Record<StatusLevel, string> = {
  expired: "bg-rose-500",
  critical: "bg-orange-500",
  warning: "bg-amber-400",
  missing: "bg-slate-300",
  ok: "bg-emerald-500",
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

  useEffect(() => { void load(); }, [load]);

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
    setInsuranceForm(EMPTY_INSURANCE);
    setInspectionForm(EMPTY_INSPECTION);
    setExtinguisherForm(EMPTY_EXTINGUISHER);
    void loadPanelRecords(v.vehicle_id);
  }, [loadPanelRecords]);

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

  // Stats
  const stats = useMemo(() => {
    let expired = 0, critical = 0, warning = 0;
    for (const item of items) {
      const s = item.worst_status;
      if (s === "expired") expired++;
      else if (s === "critical") critical++;
      else if (s === "warning") warning++;
    }
    return { expired, critical, warning, total: items.length };
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

  const renderCell = (entry: ComplianceEntry | null) => {
    if (!entry) {
      return (
        <span className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium bg-slate-50 text-slate-400 border border-slate-200">
          —
        </span>
      );
    }
    return (
      <span className={`inline-flex flex-col gap-0.5 rounded-lg px-2 py-1 text-xs font-medium ${STATUS_CELL[entry.status]}`}>
        <span>{formatDate(entry.expiry_date)}</span>
        <span className="opacity-75">{formatDays(entry.days_left)}</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Scadenze Flotta"
        subtitle="Monitoraggio assicurazioni, collaudi, estintori e tachigrafi"
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Scaduti", value: stats.expired, color: "text-rose-600", bg: "bg-rose-50 border-rose-200" },
          { label: "Critici (≤7gg)", value: stats.critical, color: "text-orange-600", bg: "bg-orange-50 border-orange-200" },
          { label: "In scadenza (≤30gg)", value: stats.warning, color: "text-amber-600", bg: "bg-amber-50 border-amber-200" },
          { label: "Totale veicoli", value: stats.total, color: "text-slate-700", bg: "bg-white border-slate-200" },
        ].map((stat) => (
          <div key={stat.label} className={`rounded-2xl border p-4 ${stat.bg}`}>
            <div className={`text-3xl font-bold ${stat.color}`}>{stat.value}</div>
            <div className="mt-1 text-xs text-muted">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <SectionCard>
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            placeholder="Cerca mezzo o targa..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input w-64"
          />
          <select
            value={docFilter}
            onChange={(e) => setDocFilter(e.target.value as DocType)}
            className="input w-44"
          >
            {(Object.keys(DOC_LABELS) as DocType[]).map((k) => (
              <option key={k} value={k}>{DOC_LABELS[k]}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="input w-44"
          >
            <option value="all">Tutti gli stati</option>
            <option value="expired">Scaduti</option>
            <option value="critical">Critici</option>
            <option value="warning">In scadenza</option>
            <option value="ok">Validi</option>
          </select>
        </div>
      </SectionCard>

      {/* Table */}
      <SectionCard>
        {loading ? (
          <div className="py-12 text-center text-muted">Caricamento...</div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-muted">Nessun veicolo trovato</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-semibold uppercase tracking-wide text-muted">
                  <th className="pb-3 pr-4">Mezzo</th>
                  <th className="pb-3 pr-4">Stato</th>
                  <th className="pb-3 pr-4">Assicurazione</th>
                  <th className="pb-3 pr-4">Collaudo</th>
                  <th className="pb-3 pr-4">Estintori</th>
                  <th className="pb-3">Tachigrafo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map((item) => (
                  <tr
                    key={item.vehicle_id}
                    className="cursor-pointer transition-colors hover:bg-muted/30"
                    onClick={() => openPanel(item)}
                  >
                    <td className="py-3 pr-4">
                      <div className="font-semibold">{item.label}</div>
                      {item.plate && <div className="text-xs text-muted font-mono">{item.plate}</div>}
                    </td>
                    <td className="py-3 pr-4">
                      <span className="flex items-center gap-1.5">
                        <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[item.worst_status]}`} />
                        <span className="text-xs">{STATUS_LABEL[item.worst_status]}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-4">{renderCell(item.insurance)}</td>
                    <td className="py-3 pr-4">{renderCell(item.inspection)}</td>
                    <td className="py-3 pr-4">{renderCell(item.extinguisher)}</td>
                    <td className="py-3">{renderCell(item.tachograph)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Side panel */}
      <SidePanel
        open={!!panel}
        title={panel?.label ?? ""}
        subtitle={panel?.plate ?? undefined}
        onClose={() => setPanel(null)}
        widthClassName="max-w-xl"
      >
        {panel && (
          <div className="space-y-5">
            {/* Tab bar */}
            <div className="flex gap-1 rounded-xl bg-muted/30 p-1">
              {(["insurance", "inspection", "extinguisher"] as const).map((tab) => {
                const labels = { insurance: "Assicurazione", inspection: "Collaudo", extinguisher: "Estintori" };
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => { setPanelTab(tab); setShowForm(false); }}
                    className={`flex-1 rounded-lg py-1.5 text-sm font-medium transition-colors ${
                      panelTab === tab ? "bg-white shadow text-foreground" : "text-muted hover:text-foreground"
                    }`}
                  >
                    {labels[tab]}
                  </button>
                );
              })}
            </div>

            {panelLoading ? (
              <div className="py-8 text-center text-muted text-sm">Caricamento...</div>
            ) : (
              <>
                {/* Records list */}
                <RecordList
                  tab={panelTab}
                  records={panelRecords}
                />

                {/* Add form toggle */}
                {!showForm ? (
                  <button
                    type="button"
                    onClick={() => setShowForm(true)}
                    className="btn-primary w-full"
                  >
                    + Aggiungi / Rinnova
                  </button>
                ) : (
                  <div className="rounded-xl border border-border bg-surface p-4 space-y-3">
                    <div className="text-sm font-semibold">
                      {panelTab === "insurance" ? "Nuova assicurazione" : panelTab === "inspection" ? "Nuovo collaudo" : "Nuovo estintore"}
                    </div>

                    {panelTab === "insurance" && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="label">Compagnia *</label>
                            <input className="input" value={insuranceForm.company} onChange={(e) => setInsuranceForm((f) => ({ ...f, company: e.target.value }))} />
                          </div>
                          <div>
                            <label className="label">N. polizza</label>
                            <input className="input" value={insuranceForm.policy_number} onChange={(e) => setInsuranceForm((f) => ({ ...f, policy_number: e.target.value }))} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
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
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="label">Data collaudo *</label>
                            <input type="date" className="input" value={inspectionForm.inspection_date} onChange={(e) => setInspectionForm((f) => ({ ...f, inspection_date: e.target.value }))} />
                          </div>
                          <div>
                            <label className="label">Scadenza *</label>
                            <input type="date" className="input" value={inspectionForm.expiry_date} onChange={(e) => setInspectionForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
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
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="label">N. seriale</label>
                            <input className="input" value={extinguisherForm.serial_number} onChange={(e) => setExtinguisherForm((f) => ({ ...f, serial_number: e.target.value }))} />
                          </div>
                          <div>
                            <label className="label">Scadenza *</label>
                            <input type="date" className="input" value={extinguisherForm.expiry_date} onChange={(e) => setExtinguisherForm((f) => ({ ...f, expiry_date: e.target.value }))} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
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
        )}
      </SidePanel>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 rounded-2xl px-5 py-3 text-sm font-semibold text-white shadow-lg ${
            toast.ok ? "bg-emerald-600" : "bg-rose-600"
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
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
    return <div className="py-4 text-sm text-muted text-center">Nessun record presente</div>;
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
          <div key={row.id as string ?? i} className={`rounded-xl border p-3 text-sm ${isCurrent ? "border-border bg-surface" : "border-border/50 bg-muted/20 opacity-60"}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="font-medium">
                {tab === "insurance" && (row.company as string)}
                {tab === "inspection" && `Collaudo ${row.inspection_date ? formatDate(row.inspection_date as string) : ""}`}
                {tab === "extinguisher" && (row.serial_number ? `Sn: ${row.serial_number}` : "Estintore")}
              </div>
              <div className="flex items-center gap-2">
                {isCurrent && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">Attivo</span>
                )}
                {expiry && (
                  <span className={`rounded-lg px-2 py-0.5 text-xs font-medium ${STATUS_CELL[status]}`}>
                    {formatDate(expiry)} ({formatDays(days)})
                  </span>
                )}
              </div>
            </div>
            {tab === "insurance" && row.policy_number && (
              <div className="mt-1 text-xs text-muted">Polizza: {row.policy_number as string}</div>
            )}
            {tab === "inspection" && row.outcome && (
              <div className="mt-1 text-xs text-muted">Esito: {row.outcome === "passed" ? "Superato" : row.outcome === "failed" ? "Bocciato" : "In attesa"}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
