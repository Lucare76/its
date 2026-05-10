"use client";

import { useCallback, useEffect, useState } from "react";
import { DateInput, PageHeader, SectionCard } from "@/components/ui";
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [documentModal, setDocumentModal] = useState<FuelDocumentModalState | null>(null);
  const [documentModalSaving, setDocumentModalSaving] = useState(false);
  const [documentModalUrl, setDocumentModalUrl] = useState("");
  const [documentModalName, setDocumentModalName] = useState("");
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

  function documentEditHint(record: FuelRecord) {
    if (record.approval_status !== "approved" || !hasFiscalDocument(record)) return null;
    if (currentRole === "admin") return "Documento fiscale modificabile da admin.";
    return "Documento fiscale già inserito. Modifica riservata ad admin.";
  }

  return (
    <section className="page-section">
      <PageHeader
        title="Rifornimenti"
        subtitle="Coda approvazione QR, inserimento manuale e collegamento documento fiscale."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Flotta", href: "/fleet-ops" }, { label: "Rifornimenti" }]}
      />

      {toast ? (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      ) : null}

      {documentModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">
                {documentModal.mode === "approve" ? "Approva rifornimento" : "Modifica documento fiscale"}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {documentModal.record.vehicle?.label ?? "Veicolo"} · {new Date(documentModal.record.fuel_date).toLocaleDateString("it-IT")}
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

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_420px]">
        <SectionCard
          title="Coda rifornimenti"
          subtitle={`${records.length} registrazioni visibili`}
          actions={(
            <div className="flex flex-wrap gap-2">
              {([
                ["pending", `Da approvare (${counts.pending})`],
                ["approved", `Approvati (${counts.approved})`],
                ["rejected", `Respinti (${counts.rejected})`],
                ["all", "Tutti"],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setStatusFilter(value)}
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusFilter === value ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
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
            <p className="text-sm text-slate-400">Nessun rifornimento trovato per il filtro corrente.</p>
          ) : (
            <div className="space-y-3">
              {records.map((record) => (
                <article key={record.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        {record.vehicle?.label ?? "Veicolo"} {record.vehicle?.plate ? `· ${record.vehicle.plate}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-slate-500">
                        {new Date(record.fuel_date).toLocaleDateString("it-IT")} · {record.station ?? "Distributore non indicato"} · {record.fuel_type ?? "tipo non indicato"}
                      </p>
                      <p className="mt-1 text-xs text-slate-400">
                        {record.submitted_via_qr ? "Caricato da QR driver" : "Inserimento ufficio"}{record.vehicle?.license_number ? ` · Licenza ${record.vehicle.license_number}` : ""}
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
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Litri</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.liters != null ? `${record.liters.toFixed(1)} L` : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Costo</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.cost != null ? `€${record.cost.toFixed(2)}` : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Km</p>
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.km_at_fuel != null ? record.km_at_fuel.toLocaleString("it-IT") : "—"}</p>
                    </div>
                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">Documento fiscale</p>
                      <p className="mt-1 truncate text-sm font-semibold text-slate-700" title={record.fiscal_document_name ?? undefined}>
                        {record.fiscal_document_name ?? "Non collegato"}
                      </p>
                    </div>
                  </div>

                  {record.notes ? <p className="mt-3 text-sm text-slate-500">{record.notes}</p> : null}

                  <div className="mt-3 flex flex-wrap gap-2">
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
                </article>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Nuovo rifornimento ufficio" subtitle="Per inserimenti manuali o correzioni amministrative.">
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-slate-500">
              Mezzo
              <select className="input-saas mt-1 w-full" value={form.vehicle_id} onChange={(event) => setForm((current) => ({ ...current, vehicle_id: event.target.value }))}>
                <option value="">Seleziona mezzo</option>
                {vehicles.map((vehicle) => (
                  <option key={vehicle.id} value={vehicle.id}>
                    {vehicle.label}{vehicle.plate ? ` · ${vehicle.plate}` : ""}
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
    </section>
  );
}
