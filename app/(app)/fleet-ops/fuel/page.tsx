"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DateInput, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type VehicleOption = {
  id: string;
  label: string;
  plate?: string | null;
  license_number?: string | null;
};

type FuelRecord = {
  id: string;
  vehicle_id: string;
  fuel_date: string;
  liters?: number | null;
  cost?: number | null;
  km_at_fuel?: number | null;
  fuel_type?: string | null;
  station?: string | null;
  notes?: string | null;
  approval_status: "pending" | "approved" | "rejected";
  fiscal_document_url?: string | null;
  fiscal_document_name?: string | null;
  submitted_via_qr?: boolean;
  vehicle?: VehicleOption | null;
};

type FuelDocumentModalState = {
  record: FuelRecord;
  mode: "approve" | "edit";
};

type EditModalState = {
  record: FuelRecord;
  form: {
    vehicle_id: string;
    fuel_date: string;
    liters: string;
    cost: string;
    km_at_fuel: string;
    fuel_type: string;
    station: string;
    notes: string;
  };
};

type FuelRole = "admin" | "operator" | "supervisor" | string;

async function accessToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const EMPTY_FORM = {
  vehicle_id: "",
  fuel_date: new Date().toISOString().slice(0, 10),
  liters: "",
  cost: "",
  km_at_fuel: "",
  fuel_type: "diesel",
  station: "",
  notes: "",
};

const PLACEHOLDER_FISCAL_DOCUMENT_HOSTS = new Set(["example.com", "example.org", "example.net"]);
const PAGE_SIZE = 10;

function fmtMoney(value: number | null | undefined) {
  return value != null ? `EUR ${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "-";
}

function fmtNumber(value: number | null | undefined, suffix = "") {
  return value != null ? `${value.toLocaleString("it-IT")}${suffix}` : "-";
}

function fmtDate(value: string) {
  return new Date(`${value}T00:00:00`).toLocaleDateString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function fmtUnitPrice(record: FuelRecord) {
  if (!record.cost || !record.liters) return "-";
  return (record.cost / record.liters).toLocaleString("it-IT", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

function normalizeFiscalDocumentUrl(raw: string | null | undefined) {
  const value = (raw ?? "").trim();
  if (!value) return { ok: true as const, url: null };
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { ok: false as const, error: "Il documento fiscale deve usare un link http o https valido." };
    }
    if (PLACEHOLDER_FISCAL_DOCUMENT_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { ok: false as const, error: "Il documento fiscale collegato è un link di esempio e va sostituito con il file reale." };
    }
    return { ok: true as const, url: parsed.toString() };
  } catch {
    return { ok: false as const, error: "Il link del documento fiscale non è valido." };
  }
}

export default function FleetFuelPage() {
  const [records, setRecords] = useState<FuelRecord[]>([]);
  const [vehicles, setVehicles] = useState<VehicleOption[]>([]);
  const [currentRole, setCurrentRole] = useState<FuelRole>("operator");
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "rejected">("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [documentModal, setDocumentModal] = useState<FuelDocumentModalState | null>(null);
  const [documentModalSaving, setDocumentModalSaving] = useState(false);
  const [documentModalUrl, setDocumentModalUrl] = useState("");
  const [documentModalName, setDocumentModalName] = useState("");
  const [editModal, setEditModal] = useState<EditModalState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<FuelRecord | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<FuelRecord | null>(null);
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
    const res = await fetch(`/api/ops/fuel-entries${query}`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      records?: FuelRecord[];
      vehicles?: VehicleOption[];
      counts?: { pending?: number; approved?: number; rejected?: number };
      current_role?: FuelRole;
    } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Errore caricamento rifornimenti.", false);
      setLoading(false);
      return;
    }
    setRecords(json.records ?? []);
    setVehicles(json.vehicles ?? []);
    setCounts({
      pending: json.counts?.pending ?? 0,
      approved: json.counts?.approved ?? 0,
      rejected: json.counts?.rejected ?? 0,
    });
    setCurrentRole(json.current_role ?? "operator");
    setLoading(false);
  }, [showToast, statusFilter]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  const visibleRecords = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return records;
    return records.filter((record) => [
      record.vehicle?.label,
      record.vehicle?.plate,
      record.vehicle?.license_number,
      record.station,
      record.fuel_type,
      record.fiscal_document_name,
      record.notes,
    ].some((value) => (value ?? "").toLowerCase().includes(needle)));
  }, [records, searchQuery]);

  const fuelSummary = useMemo(() => {
    const approved = visibleRecords.filter((record) => record.approval_status === "approved");
    const totalCost = approved.reduce((sum, record) => sum + Number(record.cost ?? 0), 0);
    const totalLiters = approved.reduce((sum, record) => sum + Number(record.liters ?? 0), 0);
    const missingDocuments = visibleRecords.filter((record) => {
      const hasDocument = Boolean((record.fiscal_document_url ?? "").trim() || (record.fiscal_document_name ?? "").trim());
      return record.approval_status === "approved" && !hasDocument;
    }).length;
    return {
      totalCost,
      totalLiters,
      averagePrice: totalLiters > 0 ? totalCost / totalLiters : null,
      missingDocuments,
    };
  }, [visibleRecords]);

  const totalPages = Math.max(1, Math.ceil(visibleRecords.length / PAGE_SIZE));
  const paginatedRecords = useMemo(
    () => visibleRecords.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [currentPage, visibleRecords],
  );

  async function createManualFuelEntry() {
    const token = await accessToken();
    if (!token) return;
    setSaving(true);
    const res = await fetch("/api/ops/fuel-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create",
        data: {
          vehicle_id: form.vehicle_id,
          fuel_date: form.fuel_date,
          liters: form.liters ? Number(form.liters) : null,
          cost: form.cost ? Number(form.cost) : null,
          km_at_fuel: form.km_at_fuel ? Number(form.km_at_fuel) : null,
          fuel_type: form.fuel_type || null,
          station: form.station || null,
          notes: form.notes || null,
          submitted_via_qr: false,
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setSaving(false);
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Salvataggio rifornimento fallito.", false);
      return;
    }
    setForm(EMPTY_FORM);
    setShowCreateModal(false);
    showToast("Rifornimento aggiunto.", true);
    void load();
  }

  async function updateFuelApproval(record: FuelRecord, approval_status: "approved" | "rejected") {
    const token = await accessToken();
    if (!token) return;
    if (approval_status === "approved") {
      setDocumentModal({ record, mode: "approve" });
      setDocumentModalUrl(record.fiscal_document_url ?? "");
      setDocumentModalName(record.fiscal_document_name ?? "");
      return;
    }

    const res = await fetch("/api/ops/fuel-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "approve",
        data: {
          id: record.id,
          approval_status,
          fiscal_document_url: null,
          fiscal_document_name: null,
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Aggiornamento rifornimento fallito.", false);
      return;
    }
    showToast("Rifornimento respinto.", true);
    void load();
  }

  async function updateFuelDocument(record: FuelRecord) {
    setDocumentModal({ record, mode: "edit" });
    setDocumentModalUrl(record.fiscal_document_url ?? "");
    setDocumentModalName(record.fiscal_document_name ?? "");
  }

  async function saveFuelDocumentModal() {
    if (!documentModal) return;
    const token = await accessToken();
    if (!token) return;
    const fiscal_document_url_input = documentModalUrl;
    const fiscal_document_name = documentModalName;
    const fiscalDocumentUrl = normalizeFiscalDocumentUrl(fiscal_document_url_input);
    if (!fiscalDocumentUrl.ok) {
      showToast(fiscalDocumentUrl.error, false);
      return;
    }
    setDocumentModalSaving(true);

    const res = await fetch("/api/ops/fuel-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: documentModal.mode === "approve" ? "approve" : "update_document",
        data: {
          id: documentModal.record.id,
          ...(documentModal.mode === "approve" ? { approval_status: "approved" as const } : {}),
          fiscal_document_url: fiscalDocumentUrl.url,
          fiscal_document_name: fiscal_document_name || null,
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setDocumentModalSaving(false);
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? (documentModal.mode === "approve" ? "Approvazione rifornimento fallita." : "Aggiornamento documento fiscale fallito."), false);
      return;
    }
    setDocumentModal(null);
    setDocumentModalUrl("");
    setDocumentModalName("");
    if (documentModal.mode === "approve" && statusFilter === "pending") {
      setStatusFilter("approved");
      setCurrentPage(1);
      showToast("Rifornimento approvato e spostato nella lista Approvati.", true);
      return;
    }
    showToast(documentModal.mode === "approve" ? "Rifornimento approvato." : "Documento fiscale aggiornato.", true);
    void load();
  }

  function openFiscalDocument(record: FuelRecord) {
    const fiscalDocumentUrl = normalizeFiscalDocumentUrl(record.fiscal_document_url);
    if (!fiscalDocumentUrl.ok || !fiscalDocumentUrl.url) {
      showToast(fiscalDocumentUrl.ok ? "Documento fiscale non collegato." : fiscalDocumentUrl.error, false);
      return;
    }
    window.open(fiscalDocumentUrl.url, "_blank", "noopener,noreferrer");
  }

  function hasFiscalDocument(record: FuelRecord) {
    return Boolean((record.fiscal_document_url ?? "").trim() || (record.fiscal_document_name ?? "").trim());
  }

  function canEditFiscalDocument(record: FuelRecord) {
    return currentRole === "admin" && hasFiscalDocument(record);
  }

  function canInsertFiscalDocument(record: FuelRecord) {
    return !hasFiscalDocument(record);
  }

  function openEditModal(record: FuelRecord) {
    setEditModal({
      record,
      form: {
        vehicle_id: record.vehicle_id,
        fuel_date:  record.fuel_date,
        liters:     record.liters != null ? String(record.liters) : "",
        cost:       record.cost != null ? String(record.cost) : "",
        km_at_fuel: record.km_at_fuel != null ? String(record.km_at_fuel) : "",
        fuel_type:  record.fuel_type ?? "diesel",
        station:    record.station ?? "",
        notes:      record.notes ?? "",
      },
    });
  }

  async function saveEdit() {
    if (!editModal) return;
    const token = await accessToken();
    if (!token) return;
    setEditSaving(true);
    const f = editModal.form;
    const res = await fetch("/api/ops/fuel-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "edit",
        data: {
          id:         editModal.record.id,
          vehicle_id: f.vehicle_id,
          fuel_date:  f.fuel_date,
          liters:     f.liters ? Number(f.liters) : null,
          cost:       f.cost ? Number(f.cost) : null,
          km_at_fuel: f.km_at_fuel ? Number(f.km_at_fuel) : null,
          fuel_type:  f.fuel_type || null,
          station:    f.station || null,
          notes:      f.notes || null,
        },
      }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setEditSaving(false);
    if (!res.ok || !json?.ok) { showToast(json?.error ?? "Salvataggio fallito.", false); return; }
    setEditModal(null);
    showToast("Rifornimento modificato.", true);
    void load();
  }

  async function deleteRecord(record: FuelRecord) {
    const token = await accessToken();
    if (!token) return;
    setDeleteLoading(true);
    const res = await fetch("/api/ops/fuel-entries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "delete", data: { id: record.id } }),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    setDeleteLoading(false);
    if (!res.ok || !json?.ok) { showToast(json?.error ?? "Eliminazione fallita.", false); return; }
    setDeleteConfirm(null);
    showToast("Rifornimento eliminato.", true);
    void load();
  }

  function documentEditHint(record: FuelRecord) {
    if (record.approval_status !== "approved" || !hasFiscalDocument(record)) return null;
    if (currentRole === "admin") return "Documento fiscale modificabile da admin.";
    return "Documento fiscale già inserito. Modifica riservata ad admin.";
  }

  return (
    <section className="page-section">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <nav className="flex items-center gap-1 text-xs text-slate-500" aria-label="Percorso pagina">
            <a href="/dashboard" className="hover:text-slate-900">Operazioni</a><span>/</span><a href="/fleet-ops" className="hover:text-slate-900">Flotta</a><span>/</span><span>Rifornimenti</span>
          </nav>
          <p className="mt-1 text-sm text-slate-600">Controllo consumi, approvazioni e documenti fiscali.</p>
        </div>
        <button type="button" onClick={() => setShowCreateModal(true)} className="btn-primary inline-flex min-h-10 items-center justify-center gap-2 px-4 text-sm">
          <span aria-hidden="true" className="text-lg leading-none">+</span>
          Nuovo rifornimento
        </button>
      </div>

      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[
          { label: "Da approvare", value: String(counts.pending), note: "richiedono controllo", tone: "amber" },
          { label: "Costo approvato", value: fmtMoney(fuelSummary.totalCost), note: "sul filtro corrente", tone: "blue" },
          { label: "Litri approvati", value: `${fuelSummary.totalLiters.toLocaleString("it-IT", { maximumFractionDigits: 1 })} L`, note: "rifornimenti validati", tone: "emerald" },
          { label: "Prezzo medio", value: fuelSummary.averagePrice != null ? `EUR ${fuelSummary.averagePrice.toFixed(3)}/L` : "-", note: "costo / litri", tone: "violet" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${item.tone === "amber" ? "bg-amber-500" : item.tone === "emerald" ? "bg-emerald-500" : item.tone === "violet" ? "bg-violet-500" : "bg-blue-500"}`} />
              <p className="text-[11px] font-semibold uppercase text-slate-500">{item.label}</p>
            </div>
            <p className="mt-2 text-xl font-bold text-slate-950 sm:text-2xl">{loading ? "..." : item.value}</p>
            <p className="mt-1 text-xs text-slate-500">{item.note}</p>
          </div>
        ))}
      </div>

      {documentModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">
                {documentModal.mode === "approve" ? "Approva rifornimento" : "Modifica documento fiscale"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {documentModal.record.vehicle?.label ?? "Veicolo"} - {new Date(documentModal.record.fuel_date).toLocaleDateString("it-IT")}
              </p>
            </div>
            <div className="space-y-4 px-5 py-4">
              <label className="block text-xs font-semibold text-slate-500">
                Numero ricevuta
                <input
                  data-no-uppercase
                  value={documentModalName}
                  onChange={(event) => setDocumentModalName(event.target.value)}
                  placeholder="Ricevuta Q8 09/05/2026"
                  className="input-saas mt-1 w-full"
                />
              </label>
              <label className="block text-xs font-semibold text-slate-500">
                URL documento fiscale (opzionale)
                <input
                  data-no-uppercase
                  value={documentModalUrl}
                  onChange={(event) => setDocumentModalUrl(event.target.value)}
                  placeholder="https://..."
                  className="input-saas mt-1 w-full"
                />
              </label>
              <p className="text-xs text-slate-400">
                Inserisci almeno il numero o riferimento della ricevuta. Lascia vuoto l’URL se il file non è ancora disponibile.
              </p>
            </div>
            <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => {
                  if (documentModalSaving) return;
                  setDocumentModal(null);
                  setDocumentModalUrl("");
                  setDocumentModalName("");
                }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
              <button
                type="button"
                disabled={documentModalSaving}
                onClick={() => void saveFuelDocumentModal()}
                className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {documentModalSaving ? "Salvataggio..." : documentModal.mode === "approve" ? "Approva rifornimento" : "Salva documento"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Modale modifica rifornimento ────────────────────────────────── */}
      {editModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">Modifica rifornimento</p>
              <p className="mt-1 text-xs text-slate-500">{editModal.record.vehicle?.label ?? "Veicolo"}</p>
            </div>
            <div className="grid gap-3 px-5 py-4">
              <label className="text-xs font-semibold text-slate-500">
                Mezzo
                <select className="input-saas mt-1 w-full" value={editModal.form.vehicle_id}
                  onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, vehicle_id: e.target.value } } : null)}>
                  {vehicles.map(v => <option key={v.id} value={v.id}>{v.label}{v.plate ? ` - ${v.plate}` : ""}</option>)}
                </select>
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Data
                <DateInput className="input-saas mt-1 w-full" value={editModal.form.fuel_date}
                  onChange={iso => setEditModal(m => m ? { ...m, form: { ...m.form, fuel_date: iso } } : null)} />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-500">
                  Litri
                  <input className="input-saas mt-1 w-full" type="number" min="0" value={editModal.form.liters}
                    onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, liters: e.target.value } } : null)} />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Costo
                  <input className="input-saas mt-1 w-full" type="number" min="0" value={editModal.form.cost}
                    onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, cost: e.target.value } } : null)} />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Km al rifornimento
                  <input className="input-saas mt-1 w-full" type="number" min="0" value={editModal.form.km_at_fuel}
                    onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, km_at_fuel: e.target.value } } : null)} />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Tipo carburante
                  <select className="input-saas mt-1 w-full" value={editModal.form.fuel_type}
                    onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, fuel_type: e.target.value } } : null)}>
                    <option value="diesel">Diesel</option>
                    <option value="benzina">Benzina</option>
                    <option value="gas">Gas</option>
                    <option value="elettrico">Elettrico</option>
                    <option value="ibrido">Ibrido</option>
                  </select>
                </label>
              </div>
              <label className="text-xs font-semibold text-slate-500">
                Distributore
                <input className="input-saas mt-1 w-full" value={editModal.form.station}
                  onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, station: e.target.value } } : null)} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Note
                <textarea className="input-saas mt-1 w-full resize-none" rows={2} value={editModal.form.notes}
                  onChange={e => setEditModal(m => m ? { ...m, form: { ...m.form, notes: e.target.value } } : null)} />
              </label>
            </div>
            <div className="flex gap-2 border-t border-slate-100 px-5 py-4 sm:justify-end">
              <button type="button" onClick={() => setEditModal(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button type="button" disabled={editSaving} onClick={() => void saveEdit()}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                {editSaving ? "Salvataggio..." : "Salva modifiche"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── Conferma eliminazione ────────────────────────────────────────── */}
      {deleteConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-sm rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="px-6 py-5">
              <p className="text-sm font-semibold text-slate-900">Eliminare questo rifornimento?</p>
              <p className="mt-1 text-xs text-slate-500">
                {deleteConfirm.vehicle?.label ?? "Veicolo"} - {new Date(deleteConfirm.fuel_date).toLocaleDateString("it-IT")}
                {deleteConfirm.cost != null ? ` - EUR ${deleteConfirm.cost.toFixed(2)}` : ""}
              </p>
              <p className="mt-2 text-xs text-rose-600">L&apos;operazione è irreversibile.</p>
            </div>
            <div className="flex gap-2 border-t border-slate-100 px-5 py-4 sm:justify-end">
              <button type="button" onClick={() => setDeleteConfirm(null)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button type="button" disabled={deleteLoading} onClick={() => void deleteRecord(deleteConfirm)}
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50">
                {deleteLoading ? "Eliminazione..." : "Elimina"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div>
        <SectionCard
          title="Coda rifornimenti"
          subtitle={`${visibleRecords.length} registrazioni visibili su ${records.length}`}
          actions={(
            <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto">
              <input
                className="input-saas h-10 min-w-0 basis-full text-xs lg:w-64 lg:basis-auto"
                value={searchQuery}
                onChange={(event) => { setSearchQuery(event.target.value); setCurrentPage(1); }}
                placeholder="Cerca mezzo, targa, distributore"
              />
              {([
                ["pending", `Da approvare (${counts.pending})`],
                ["approved", `Approvati (${counts.approved})`],
                ["rejected", `Respinti (${counts.rejected})`],
                ["all", "Tutti"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => { setStatusFilter(value); setCurrentPage(1); }}
                  className={`min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold ${statusFilter === value ? "border-violet-600 bg-violet-600 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        >
          {loading ? (
            <p className="text-sm text-slate-400">Caricamento...</p>
          ) : visibleRecords.length === 0 ? (
            <p className="text-sm text-slate-400">Nessun rifornimento trovato per il filtro corrente.</p>
          ) : (
            <>
            <div className="hidden overflow-hidden rounded-lg border border-slate-200 lg:block">
              <div className="grid grid-cols-[100px_minmax(180px,1.5fr)_minmax(140px,1.1fr)_70px_95px_70px_90px_minmax(120px,1fr)_130px_28px] items-center gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-[10px] font-bold uppercase text-slate-500">
                <span>Data</span><span>Mezzo</span><span>Distributore</span><span>Litri</span><span>Costo</span><span>EUR/L</span><span>Km</span><span>Documento</span><span>Stato</span><span />
              </div>
              {paginatedRecords.map((record) => (
                <button key={record.id} type="button" onClick={() => setSelectedRecord(record)} className="grid w-full grid-cols-[100px_minmax(180px,1.5fr)_minmax(140px,1.1fr)_70px_95px_70px_90px_minmax(120px,1fr)_130px_28px] items-center gap-3 border-b border-slate-100 bg-white px-4 py-3 text-left text-xs last:border-b-0 hover:bg-violet-50/40">
                  <span className="text-slate-600">{fmtDate(record.fuel_date)}</span>
                  <span className="min-w-0"><strong className="block truncate text-slate-900">{record.vehicle?.label ?? "Veicolo"}</strong><span className="text-slate-500">{record.vehicle?.plate ?? "Targa non indicata"}</span></span>
                  <span className="truncate text-slate-600">{record.station ?? "Non indicato"}</span>
                  <span className="font-semibold text-slate-700">{record.liters != null ? `${record.liters.toFixed(1)} L` : "-"}</span>
                  <span className="font-semibold text-slate-900">{fmtMoney(record.cost)}</span>
                  <span className="text-slate-600">{fmtUnitPrice(record)}</span>
                  <span className="text-slate-600">{fmtNumber(record.km_at_fuel)}</span>
                  <span className={`truncate ${hasFiscalDocument(record) ? "text-blue-700" : "font-medium text-rose-600"}`}>{record.fiscal_document_name ?? "Mancante"}</span>
                  <span className={`w-fit rounded-full border px-2.5 py-1 text-[10px] font-semibold ${record.approval_status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : record.approval_status === "rejected" ? "border-rose-200 bg-rose-50 text-rose-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>{record.approval_status === "approved" ? "Approvato" : record.approval_status === "rejected" ? "Respinto" : "Da approvare"}</span>
                  <span className="text-lg text-slate-400" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="space-y-3 lg:hidden">
              {paginatedRecords.map((record) => (
                <article key={record.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {record.vehicle?.label ?? "Veicolo"} {record.vehicle?.plate ? `- ${record.vehicle.plate}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {new Date(record.fuel_date).toLocaleDateString("it-IT")} - {record.station ?? "Distributore non indicato"} - {record.fuel_type ?? "tipo non indicato"}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {record.submitted_via_qr ? "Caricato da QR driver" : "Inserimento ufficio"}{record.vehicle?.license_number ? ` - Licenza ${record.vehicle.license_number}` : ""}
                      </p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                      record.approval_status === "approved" ? "border-emerald-200 bg-emerald-50 text-emerald-700" :
                      record.approval_status === "rejected" ? "border-rose-200 bg-rose-50 text-rose-700" :
                      "border-amber-200 bg-amber-50 text-amber-700"
                    }`}>
                      {record.approval_status === "approved" ? "Approvato" : record.approval_status === "rejected" ? "Respinto" : "Da approvare"}
                    </span>
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Litri</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.liters != null ? `${record.liters.toFixed(1)} L` : "-"}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Costo</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.cost != null ? `EUR ${record.cost.toFixed(2)}` : "-"}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Km</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.km_at_fuel != null ? record.km_at_fuel.toLocaleString("it-IT") : "-"}</p>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">EUR/L</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{fmtUnitPrice(record)}</p>
                    </div>
                  </div>

                  {record.notes ? <p className="mt-3 text-sm text-slate-500">{record.notes}</p> : null}

                  <div className="hidden">
                    {currentRole === "admin" ? (
                      <>
                        <button type="button" onClick={() => openEditModal(record)}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                          ✏️ Modifica
                        </button>
                        <button type="button" onClick={() => setDeleteConfirm(record)}
                          className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100">
                          🗑️ Elimina
                        </button>
                      </>
                    ) : null}
                    {record.fiscal_document_url ? (
                      <button
                        type="button"
                        onClick={() => openFiscalDocument(record)}
                        className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700 hover:bg-sky-100"
                      >
                        Apri documento fiscale
                      </button>
                    ) : null}
                    {record.approval_status === "approved" && canInsertFiscalDocument(record) ? (
                      <button
                        type="button"
                        onClick={() => void updateFuelDocument(record)}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                      >
                        Aggiungi documento fiscale
                      </button>
                    ) : null}
                    {record.approval_status === "approved" && canEditFiscalDocument(record) ? (
                      <button
                        type="button"
                        onClick={() => void updateFuelDocument(record)}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                      >
                        Modifica documento fiscale
                      </button>
                    ) : null}
                    {record.approval_status !== "approved" ? (
                      <button type="button" onClick={() => void updateFuelApproval(record, "approved")} className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                        Approva
                      </button>
                    ) : null}
                    {record.approval_status !== "rejected" ? (
                      <button type="button" onClick={() => void updateFuelApproval(record, "rejected")} className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 hover:bg-rose-100">
                        Respingi
                      </button>
                    ) : null}
                  </div>
                  {documentEditHint(record) ? (
                    <p className="mt-2 text-xs text-slate-400">
                      {documentEditHint(record)}
                    </p>
                  ) : null}
                  <button type="button" onClick={() => setSelectedRecord(record)} className="mt-3 flex min-h-11 w-full items-center justify-between border-t border-slate-100 pt-3 text-sm font-semibold text-violet-700">
                    <span className={hasFiscalDocument(record) ? "text-blue-700" : "text-rose-600"}>{record.fiscal_document_name ?? "Documento mancante"}</span>
                    <span>Dettagli ›</span>
                  </button>
                </article>
              ))}
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between">
              <span>{Math.min((currentPage - 1) * PAGE_SIZE + 1, visibleRecords.length)}-{Math.min(currentPage * PAGE_SIZE, visibleRecords.length)} di {visibleRecords.length} risultati</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={currentPage === 1} onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} className="min-h-10 rounded-lg border border-slate-200 px-3 font-semibold text-slate-700 disabled:opacity-40">Indietro</button>
                <span className="min-w-16 text-center font-semibold text-slate-700">{currentPage} / {totalPages}</span>
                <button type="button" disabled={currentPage === totalPages} onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))} className="min-h-10 rounded-lg border border-slate-200 px-3 font-semibold text-slate-700 disabled:opacity-40">Avanti</button>
              </div>
            </div>
            </>
          )}
        </SectionCard>

        {showCreateModal ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/35" role="dialog" aria-modal="true" aria-label="Nuovo rifornimento">
        <div className="h-full w-full overflow-y-auto bg-white p-4 shadow-2xl sm:max-w-md sm:p-5">
        <SectionCard
          title="Nuovo rifornimento ufficio"
          subtitle="Per inserimenti manuali o correzioni amministrative."
          className="border-0 p-0 shadow-none"
          actions={<button type="button" onClick={() => setShowCreateModal(false)} className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-xl text-slate-500" aria-label="Chiudi">×</button>}
        >
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-500">
              Mezzo
              <select className="input-saas mt-1 w-full" value={form.vehicle_id} onChange={(event) => setForm((current) => ({ ...current, vehicle_id: event.target.value }))}>
                <option value="">Seleziona mezzo</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.label}{vehicle.plate ? ` - ${vehicle.plate}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Data
              <DateInput className="input-saas mt-1 w-full" value={form.fuel_date} onChange={(iso) => setForm((current) => ({ ...current, fuel_date: iso }))} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500">
                Litri
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.liters} onChange={(event) => setForm((current) => ({ ...current, liters: event.target.value }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Costo
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.cost} onChange={(event) => setForm((current) => ({ ...current, cost: event.target.value }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Km al rifornimento
                <input className="input-saas mt-1 w-full" type="number" min="0" value={form.km_at_fuel} onChange={(event) => setForm((current) => ({ ...current, km_at_fuel: event.target.value }))} />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Tipo carburante
                <select className="input-saas mt-1 w-full" value={form.fuel_type} onChange={(event) => setForm((current) => ({ ...current, fuel_type: event.target.value }))}>
                  <option value="diesel">Diesel</option>
                  <option value="benzina">Benzina</option>
                  <option value="gas">Gas</option>
                  <option value="elettrico">Elettrico</option>
                  <option value="ibrido">Ibrido</option>
                </select>
              </label>
            </div>
            <label className="text-xs font-semibold text-slate-500">
              Distributore
              <input className="input-saas mt-1 w-full" value={form.station} onChange={(event) => setForm((current) => ({ ...current, station: event.target.value }))} />
            </label>
            <label className="text-xs font-semibold text-slate-500">
              Note
              <textarea className="input-saas mt-1 w-full resize-none" rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
            </label>
            <button type="button" disabled={saving || !form.vehicle_id || !form.fuel_date} onClick={() => void createManualFuelEntry()} className="btn-primary py-2 text-sm disabled:opacity-50">
              {saving ? "Salvataggio..." : "Salva rifornimento"}
            </button>
          </div>
        </SectionCard>
        </div>
        </div>
        ) : null}
      </div>

      {selectedRecord ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-slate-950/25" role="dialog" aria-modal="true" aria-label="Dettaglio rifornimento">
          <aside className="flex h-full w-full flex-col bg-white shadow-2xl sm:max-w-md">
            <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <div><p className="text-base font-bold text-slate-950">Dettaglio rifornimento</p><p className="mt-0.5 text-xs text-slate-500">{fmtDate(selectedRecord.fuel_date)}</p></div>
              <button type="button" onClick={() => setSelectedRecord(null)} className="flex h-10 w-10 items-center justify-center rounded-lg border border-slate-200 text-xl text-slate-500" aria-label="Chiudi">×</button>
            </header>
            <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
              <div><p className="text-lg font-bold text-slate-950">{selectedRecord.vehicle?.label ?? "Veicolo"}</p><p className="text-sm text-slate-500">{selectedRecord.vehicle?.plate ?? "Targa non indicata"}</p></div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-5 border-y border-slate-100 py-5">
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Litri</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{selectedRecord.liters != null ? `${selectedRecord.liters.toFixed(1)} L` : "-"}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Costo totale</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{fmtMoney(selectedRecord.cost)}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Prezzo al litro</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{fmtUnitPrice(selectedRecord)} EUR/L</dd></div>
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Chilometraggio</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{fmtNumber(selectedRecord.km_at_fuel, " km")}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Distributore</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{selectedRecord.station ?? "Non indicato"}</dd></div>
                <div><dt className="text-[10px] font-bold uppercase text-slate-400">Provenienza</dt><dd className="mt-1 text-sm font-semibold text-slate-900">{selectedRecord.submitted_via_qr ? "QR autista" : "Inserimento ufficio"}</dd></div>
              </dl>
              <div><p className="text-[10px] font-bold uppercase text-slate-400">Documento fiscale</p><button type="button" disabled={!selectedRecord.fiscal_document_url} onClick={() => openFiscalDocument(selectedRecord)} className="mt-2 text-left text-sm font-semibold text-blue-700 disabled:text-slate-400">{selectedRecord.fiscal_document_name ?? "Documento non collegato"}</button></div>
              {selectedRecord.notes ? <div><p className="text-[10px] font-bold uppercase text-slate-400">Note</p><p className="mt-2 text-sm text-slate-600">{selectedRecord.notes}</p></div> : null}
              {documentEditHint(selectedRecord) ? <p className="text-xs text-slate-400">{documentEditHint(selectedRecord)}</p> : null}
            </div>
            <footer className="grid gap-2 border-t border-slate-200 bg-white p-4">
              {selectedRecord.approval_status !== "approved" ? <button type="button" onClick={() => { setSelectedRecord(null); void updateFuelApproval(selectedRecord, "approved"); }} className="min-h-11 rounded-lg bg-violet-600 px-4 text-sm font-semibold text-white hover:bg-violet-700">Approva</button> : null}
              {selectedRecord.approval_status !== "rejected" ? <button type="button" onClick={() => { setSelectedRecord(null); void updateFuelApproval(selectedRecord, "rejected"); }} className="min-h-11 rounded-lg border border-rose-300 px-4 text-sm font-semibold text-rose-700 hover:bg-rose-50">Respingi</button> : null}
              {selectedRecord.approval_status === "approved" && canInsertFiscalDocument(selectedRecord) ? <button type="button" onClick={() => { const record = selectedRecord; setSelectedRecord(null); void updateFuelDocument(record); }} className="min-h-11 rounded-lg border border-blue-200 px-4 text-sm font-semibold text-blue-700">Aggiungi documento fiscale</button> : null}
              {selectedRecord.approval_status === "approved" && canEditFiscalDocument(selectedRecord) ? <button type="button" onClick={() => { const record = selectedRecord; setSelectedRecord(null); void updateFuelDocument(record); }} className="min-h-11 rounded-lg border border-blue-200 px-4 text-sm font-semibold text-blue-700">Modifica documento fiscale</button> : null}
              {currentRole === "admin" ? <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => { const record = selectedRecord; setSelectedRecord(null); openEditModal(record); }} className="min-h-11 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-slate-700">Modifica</button><button type="button" onClick={() => { const record = selectedRecord; setSelectedRecord(null); setDeleteConfirm(record); }} className="min-h-11 rounded-lg border border-slate-200 px-4 text-sm font-semibold text-rose-700">Elimina</button></div> : null}
            </footer>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
