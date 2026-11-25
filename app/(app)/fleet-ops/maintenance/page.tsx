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
  invoice_document_name?: string | null;
  invoice_uploaded_at?: string | null;
  vehicle?: VehicleOption | null;
};

const INVOICE_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const INVOICE_MAX_BYTES = 10 * 1024 * 1024;
const euro = (value: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(value);

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
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [yearFilter, setYearFilter] = useState("");
  const [years, setYears] = useState<number[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null);
  const [newInvoiceFile, setNewInvoiceFile] = useState<File | null>(null);
  const [formKey, setFormKey] = useState(0);

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
    const params = new URLSearchParams();
    if (kindFilter !== "all") params.set("kind", kindFilter);
    if (vehicleFilter) params.set("vehicle_id", vehicleFilter);
    if (yearFilter) params.set("year", yearFilter);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const res = await fetch(`/api/ops/maintenance-register${query}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null) as {
      ok?: boolean; error?: string; records?: MaintenanceRecord[]; vehicles?: VehicleOption[]; years?: number[]; truncated?: boolean;
    } | null;
    if (!res.ok || !json?.ok) {
      showToast(json?.error ?? "Errore caricamento manutenzioni.", false);
      setLoading(false);
      return;
    }
    setRecords(json.records ?? []);
    setVehicles(json.vehicles ?? []);
    setYears(json.years ?? []);
    setTruncated(Boolean(json.truncated));
    setLoading(false);
  }, [kindFilter, showToast, vehicleFilter, yearFilter]);

  const vehiclesByPlate = useMemo(() => [...vehicles].sort((a, b) =>
    (a.plate ?? a.label).localeCompare(b.plate ?? b.label, "it")), [vehicles]);

  async function postAction(payload: Record<string, unknown>) {
    const token = await accessToken();
    if (!token) return null;
    const res = await fetch("/api/ops/maintenance-register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; [key: string]: unknown } | null;
    return { ok: res.ok && Boolean(json?.ok), json };
  }

  /** Il server firma un caricamento nella cartella dell'intervento; il file va
   *  direttamente allo storage (niente limite di 4,5 MB delle funzioni Vercel). */
  async function uploadInvoice(maintenanceId: string, file: File): Promise<boolean> {
    if (!supabase) return false;
    if (file.size > INVOICE_MAX_BYTES) { showToast("File troppo grande (massimo 10 MB).", false); return false; }
    setBusyInvoiceId(maintenanceId);
    try {
      const signed = await postAction({ action: "invoice_upload_url",
        data: { id: maintenanceId, file_name: file.name, content_type: file.type || "application/octet-stream", size: file.size } });
      if (!signed?.ok) { showToast(String(signed?.json?.error ?? "Caricamento non disponibile."), false); return false; }
      const path = String(signed.json?.path); const uploadToken = String(signed.json?.token);
      const { error: uploadError } = await supabase.storage.from("vehicle-documents")
        .uploadToSignedUrl(path, uploadToken, file, { contentType: file.type });
      if (uploadError) { showToast(`Caricamento fallito: ${uploadError.message}`, false); return false; }
      const attached = await postAction({ action: "invoice_attach", data: { id: maintenanceId, path, file_name: file.name } });
      if (!attached?.ok) { showToast(String(attached?.json?.error ?? "Allegato non salvato."), false); return false; }
      showToast("Fattura allegata.", true);
      return true;
    } finally {
      setBusyInvoiceId(null);
    }
  }

  async function openInvoice(maintenanceId: string) {
    // La finestra si apre subito (click dell'utente) per non essere bloccata come popup.
    const tab = window.open("", "_blank");
    const result = await postAction({ action: "invoice_open", id: maintenanceId });
    if (!result?.ok || typeof result.json?.url !== "string") {
      tab?.close();
      showToast(String(result?.json?.error ?? "Fattura non disponibile."), false);
      return;
    }
    if (tab) tab.location.href = result.json.url; else window.location.href = result.json.url;
  }

  async function removeInvoice(record: MaintenanceRecord) {
    if (!window.confirm(`Rimuovere la fattura "${record.invoice_document_name}"? Il file verrà eliminato.`)) return;
    setBusyInvoiceId(record.id);
    const result = await postAction({ action: "invoice_remove", id: record.id });
    setBusyInvoiceId(null);
    showToast(result?.ok ? "Fattura rimossa." : String(result?.json?.error ?? "Rimozione non riuscita."), Boolean(result?.ok));
    if (result?.ok) void load();
  }

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
    const json = await res.json().catch(() => null) as { ok?: boolean; error?: string; id?: string | null } | null;
    if (!res.ok || !json?.ok) {
      setSaving(false);
      showToast(json?.error ?? "Salvataggio manutenzione fallito.", false);
      return;
    }
    let invoiceOk = true;
    if (newInvoiceFile && json.id) invoiceOk = await uploadInvoice(json.id, newInvoiceFile);
    setSaving(false);
    setForm(EMPTY_FORM);
    setNewInvoiceFile(null);
    setFormKey((key) => key + 1);
    if (invoiceOk) showToast(newInvoiceFile ? "Manutenzione registrata con fattura." : "Manutenzione registrata.", true);
    else showToast("Manutenzione registrata, ma la fattura non è stata allegata: riprova dalla scheda dell'intervento.", false);
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
          subtitle={`${records.length} interventi · costo totale ${euro(totals.totalCost)}${truncated ? " (solo i 250 più recenti: restringi con targa o anno)" : ""}`}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              <select aria-label="Filtra per targa" className="input-saas h-9 w-auto min-w-[170px] text-xs" value={vehicleFilter}
                onChange={(event) => setVehicleFilter(event.target.value)}>
                <option value="">Tutte le targhe</option>
                {vehiclesByPlate.map((vehicle) => <option key={vehicle.id} value={vehicle.id}>{vehicle.plate ?? "senza targa"} · {vehicle.label}</option>)}
              </select>
              <select aria-label="Filtra per anno" className="input-saas h-9 w-auto text-xs" value={yearFilter}
                onChange={(event) => setYearFilter(event.target.value)}>
                <option value="">Tutti gli anni</option>
                {years.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
              {vehicleFilter || yearFilter ? (
                <button type="button" onClick={() => { setVehicleFilter(""); setYearFilter(""); }}
                  className="rounded-full px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50">Azzera</button>
              ) : null}
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
            <p className="text-sm text-slate-400">{vehicleFilter || yearFilter ? "Nessun intervento per questa targa o anno." : "Nessun intervento trovato."}</p>
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
                      <p className="mt-1 text-sm font-semibold text-slate-700">{record.cost != null ? euro(Number(record.cost)) : "—"}</p>
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
                  <div className={`mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 text-xs ${record.invoice_document_name ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
                    {record.invoice_document_name ? (
                      <>
                        <span className="font-semibold text-emerald-800">📄 Fattura: {record.invoice_document_name}</span>
                        <button type="button" disabled={busyInvoiceId === record.id} onClick={() => void openInvoice(record.id)}
                          className="rounded-lg border border-emerald-300 bg-white px-2 py-1 font-semibold text-emerald-800 disabled:opacity-50">Apri</button>
                        <label className={`cursor-pointer rounded-lg border border-slate-300 bg-white px-2 py-1 font-semibold text-slate-700 ${busyInvoiceId === record.id ? "pointer-events-none opacity-50" : ""}`}>
                          Sostituisci
                          <input type="file" accept={INVOICE_ACCEPT} className="hidden" onChange={(event) => {
                            const file = event.target.files?.[0]; event.target.value = "";
                            if (file) void uploadInvoice(record.id, file).then((ok) => { if (ok) void load(); });
                          }} />
                        </label>
                        <button type="button" disabled={busyInvoiceId === record.id} onClick={() => void removeInvoice(record)}
                          className="rounded-lg px-2 py-1 font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50">Rimuovi</button>
                      </>
                    ) : (
                      <>
                        <span className="font-semibold text-amber-800">Fattura non allegata</span>
                        <label className={`cursor-pointer rounded-lg border border-amber-300 bg-white px-2 py-1 font-semibold text-amber-800 ${busyInvoiceId === record.id ? "pointer-events-none opacity-50" : ""}`}>
                          {busyInvoiceId === record.id ? "Caricamento..." : "Allega fattura (PDF o foto)"}
                          <input type="file" accept={INVOICE_ACCEPT} className="hidden" onChange={(event) => {
                            const file = event.target.files?.[0]; event.target.value = "";
                            if (file) void uploadInvoice(record.id, file).then((ok) => { if (ok) void load(); });
                          }} />
                        </label>
                      </>
                    )}
                  </div>
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
            <label className="text-xs font-semibold text-slate-500">
              Fattura (facoltativa, PDF o foto, max 10 MB)
              <input key={formKey} className="input-saas mt-1 w-full" type="file" accept={INVOICE_ACCEPT}
                onChange={(event) => setNewInvoiceFile(event.target.files?.[0] ?? null)} />
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
