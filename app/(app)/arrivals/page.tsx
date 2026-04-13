"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard, StatCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatIsoDateShort, getCustomerFullName, getTransportReferenceOutward } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service, Hotel } from "@/lib/types";

function isValidClockTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function formatArrivalServiceTypeLabel(service: Service) {
  const key = service.service_type_code ?? service.booking_service_kind ?? service.service_type ?? "";
  if (key === "transfer_port_hotel") return "Porto - Hotel";
  if (key === "transfer_airport_hotel") return "Aeroporto - Hotel";
  if (key === "transfer_station_hotel" || key === "transfer_train_hotel") return "Stazione - Hotel";
  if (key === "transfer_hotel_port") return "Hotel - Porto";
  if (key === "bus_line" || key === "bus_city_hotel") return "Linea bus";
  if (key === "ferry_transfer") return "Traghetto";
  if (key === "excursion") return "Escursione";
  if (key === "transfer") return "Transfer";
  return "Servizio";
}

function AgencyKindBadge({ service }: { service: Service }) {
  const kind = service.booking_service_kind;
  if (!kind) return null;
  const map: Record<string, { label: string; className: string }> = {
    formula_snav: { label: "SNAV", className: "border-indigo-200 bg-indigo-50 text-indigo-700" },
    formula_medmar: { label: "MEDMAR", className: "border-sky-200 bg-sky-50 text-sky-700" },
    transfer_airport_hotel: { label: "Agenzia · Aeroporto", className: "border-amber-200 bg-amber-50 text-amber-700" },
    transfer_train_hotel: { label: "Agenzia · Stazione", className: "border-orange-200 bg-orange-50 text-orange-700" },
    bus_city_hotel: { label: "Agenzia · Bus", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    excursion: { label: "Agenzia · Escursione", className: "border-purple-200 bg-purple-50 text-purple-700" },
    transfer_port_hotel: { label: "Agenzia · Porto", className: "border-slate-200 bg-slate-50 text-slate-600" }
  };
  const entry = map[kind];
  if (!entry) return null;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${entry.className}`}>
      {entry.label}
    </span>
  );
}

// ─── Modal edit servizio ─────────────────────────────────────────────────────

function EditServiceModal({
  service,
  hotels,
  tenantId,
  onClose,
  onSaved,
}: {
  service: Service;
  hotels: Hotel[];
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [hotelId, setHotelId] = useState(service.hotel_id ?? "");
  const [customerName, setCustomerName] = useState(service.customer_name ?? "");
  const [pax, setPax] = useState(String(service.pax ?? 1));
  const [time, setTime] = useState(service.time ?? "");
  const [phone, setPhone] = useState(service.phone ?? "");
  const [notes, setNotes] = useState(service.notes ?? "");
  const [placeType, setPlaceType] = useState<"hotel" | "station" | "airport">((service as { place_type?: string }).place_type as "hotel" | "station" | "airport" ?? "hotel");
  const [meetingPoint, setMeetingPoint] = useState<string>((service as { meeting_point?: string }).meeting_point ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Aggiunta nuovo hotel
  const [addingHotel, setAddingHotel] = useState(false);
  const [newHotelName, setNewHotelName] = useState("");
  const [savingHotel, setSavingHotel] = useState(false);

  const createHotel = async () => {
    if (!supabase || !newHotelName.trim()) return;
    setSavingHotel(true);
    const { data, error: err } = await supabase
      .from("hotels")
      .insert({ name: newHotelName.trim(), tenant_id: tenantId, address: "", lat: 0, lng: 0, zone: "" })
      .select("id")
      .single();
    setSavingHotel(false);
    if (err) { setError(err.message); return; }
    if (data) setHotelId(data.id);
    setAddingHotel(false);
    setNewHotelName("");
    onSaved(); // ricarica lista hotel
  };

  const save = async () => {
    if (!supabase) return;
    const trimmedTime = time.trim();
    if (!isValidClockTime(trimmedTime)) {
      setError("Inserisci un orario valido nel formato HH:MM.");
      return;
    }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("services")
      .update({
        hotel_id: hotelId || null,
        customer_name: customerName,
        pax: Number(pax) || 1,
        time: trimmedTime,
        phone,
        notes,
        place_type: placeType,
        meeting_point: placeType !== "hotel" ? meetingPoint.trim() || null : null,
      })
      .eq("id", service.id)
      .eq("tenant_id", tenantId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    onSaved();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">Modifica servizio</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-slate-600">Hotel</span>
              <button
                type="button"
                onClick={() => setAddingHotel((v) => !v)}
                className="text-xs text-indigo-600 hover:text-indigo-800"
              >
                {addingHotel ? "Annulla" : "+ Nuovo hotel"}
              </button>
            </div>
            {addingHotel ? (
              <div className="flex gap-2">
                <input
                  autoFocus
                  value={newHotelName}
                  onChange={(e) => setNewHotelName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void createHotel(); }}
                  placeholder="Nome hotel..."
                  className="input-saas flex-1"
                />
                <button
                  type="button"
                  onClick={() => void createHotel()}
                  disabled={savingHotel || !newHotelName.trim()}
                  className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {savingHotel ? "..." : "Crea"}
                </button>
              </div>
            ) : (
              <select value={hotelId} onChange={(e) => setHotelId(e.target.value)} className="input-saas w-full">
                <option value="">— Nessun hotel —</option>
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </select>
            )}
          </div>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Nome cliente
            <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Pax
            <input type="number" min="1" max="99" value={pax} onChange={(e) => setPax(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Orario
            <input
              type="time"
              step="300"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="mt-1 input-saas w-full"
            />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Telefono
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Note
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 input-saas w-full resize-none" />
          </label>

          {/* Provenienza — Liste Bruno */}
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-slate-600">Provenienza <span className="font-normal text-slate-400">(Liste Bruno)</span></p>
            <div className="flex gap-2">
              <select
                value={placeType}
                onChange={(e) => setPlaceType(e.target.value as "hotel" | "station" | "airport")}
                className="input-saas w-36 shrink-0">
                <option value="hotel">🏨 Hotel</option>
                <option value="station">🚂 Stazione</option>
                <option value="airport">✈️ Aeroporto</option>
              </select>
              {placeType !== "hotel" && (
                <input
                  value={meetingPoint}
                  onChange={(e) => setMeetingPoint(e.target.value)}
                  placeholder={placeType === "station" ? "es. Napoli Centrale" : "es. Capodichino"}
                  className="input-saas flex-1"
                />
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="btn-secondary px-4 py-2 text-sm">Annulla</button>
          <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary px-5 py-2 text-sm disabled:opacity-50">
            {saving ? "Salvataggio..." : "Salva"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Export helpers ──────────────────────────────────────────────────────────

type ExportRow = { Ora: string; Cliente: string; Pax: number; Hotel: string; "Meeting point": string; Riferimento: string; Tipo: string; Agenzia: string; Data?: string };

function buildTable(rows: ExportRow[]): string {
  if (rows.length === 0) return "<p style='color:#94a3b8;font-size:12px'>Nessun servizio.</p>";
  const cols = Object.keys(rows[0]);
  const thead = cols.map((c) => `<th style="padding:6px 10px;background:#1e293b;color:#fff;font-size:11px;text-align:left">${c}</th>`).join("");
  const tbody = rows.map((r) =>
    `<tr>${cols.map((c, i) => `<td style="padding:5px 10px;font-size:12px;border-bottom:1px solid #e2e8f0;${i === 0 ? "white-space:nowrap" : ""}">${(r as Record<string, unknown>)[c] ?? ""}</td>`).join("")}</tr>`
  ).join("");
  return `<table style="border-collapse:collapse;width:100%"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
}

async function exportToExcel(rows: ExportRow[], filename: string) {
  const XLSX = await import("xlsx");
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Arrivi");
  XLSX.writeFile(wb, filename);
}

async function exportCombinedExcel(arrivals: ExportRow[], departures: ExportRow[], date: string) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(arrivals.length ? arrivals : [{ Nota: "Nessun arrivo" }]), "Arrivi");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(departures.length ? departures : [{ Nota: "Nessuna partenza" }]), "Partenze");
  XLSX.writeFile(wb, `giornata-${date}.xlsx`);
}

function printTable(rows: ExportRow[], title: string, date: string) {
  const logoUrl = `${window.location.origin}/brand/logo-ischia-transfer-email.png`;
  const html = `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:Arial,sans-serif;margin:20px}h2{font-size:16px;margin-bottom:4px}p{font-size:12px;color:#64748b;margin:0 0 12px}@media print{@page{size:landscape}}</style>
</head><body>
<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0">
  <img src="${logoUrl}" alt="Ischia Transfer Service" style="height:44px;width:auto">
  <div>
    <div style="font-weight:700;font-size:16px;color:#0f172a">${title}</div>
    <div style="font-size:12px;color:#64748b">${date} · ${rows.length} servizi</div>
  </div>
</div>
${buildTable(rows)}
<script>window.onload=()=>{window.print();window.close()}<\/script></body></html>`;
  const w = window.open("", "_blank", "width=1100,height=700");
  w?.document.write(html);
  w?.document.close();
}

function printCombined(arrivals: ExportRow[], departures: ExportRow[], date: string) {
  const logoUrl = `${window.location.origin}/brand/logo-ischia-transfer-email.png`;
  const html = `<!DOCTYPE html><html><head><title>Giornata ${date}</title>
<style>body{font-family:Arial,sans-serif;margin:20px}h2{font-size:15px;margin:0 0 4px}h3{font-size:13px;margin:24px 0 4px;color:#1e293b;border-bottom:2px solid #1e293b;padding-bottom:4px}p{font-size:12px;color:#64748b;margin:0 0 10px}@media print{@page{size:landscape}.pb{page-break-before:always}}</style>
</head><body>
<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0">
  <img src="${logoUrl}" alt="Ischia Transfer Service" style="height:44px;width:auto">
  <div style="font-weight:700;font-size:16px;color:#0f172a">Ischia Transfer Service — Giornata ${date}</div>
</div>
<h3>▼ ARRIVI (${arrivals.length})</h3>
${buildTable(arrivals)}
<div class="pb"></div>
<h3>▲ PARTENZE (${departures.length})</h3>
${buildTable(departures)}
<script>window.onload=()=>{window.print();window.close()}<\/script></body></html>`;
  const w = window.open("", "_blank", "width=1100,height=800");
  w?.document.write(html);
  w?.document.close();
}

// ─── Pagina ──────────────────────────────────────────────────────────────────

type AgencyOption = { id: string; name: string };

export default function ArrivalsPage() {
  const { loading, errorMessage, data, refresh, tenantId: tenantIdFromHook } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [showAllDates, setShowAllDates] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [agenciesList, setAgenciesList] = useState<AgencyOption[]>([]);

  // Carica agenzie reali dal DB
  useEffect(() => {
    if (!supabase || !tenantIdFromHook) return;
    supabase
      .from("agencies")
      .select("id, name")
      .eq("tenant_id", tenantIdFromHook)
      .eq("active", true)
      .order("name")
      .then(({ data: rows }) => {
        if (rows) setAgenciesList(rows as AgencyOption[]);
      });
  }, [tenantIdFromHook]);

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const tenantId = tenantIdFromHook ?? data.services[0]?.tenant_id ?? "";

  function resolveHotelName(service: Service): string {
    const byId = hotelsById.get(service.hotel_id)?.name;
    if (byId) return byId;
    // Fallback: cerca pattern "Hotel: X" nelle note (import vecchi)
    const fromNotes = service.notes?.match(/Hotel:\s*([^·|\n]+)/)?.[1]?.trim();
    if (fromNotes) return fromNotes;
    // Fallback: meeting_point se non è un terminale generico
    const mp = service.meeting_point;
    if (mp && !["meeting point linea bus", "meeting point", "porto napoli", "porto pozzuoli", "aeroporto", "stazione"].includes(mp.toLowerCase().trim())) {
      return mp;
    }
    return "N/D";
  }

  const agencyOptions = agenciesList;

  const agencyById = useMemo(() => new Map(agenciesList.map((a) => [a.id, a])), [agenciesList]);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteService = async (service: Service) => {
    if (!supabase) return;
    if (!confirm(`Eliminare il servizio di ${service.customer_name}? L'operazione non è reversibile.`)) return;
    setDeletingId(service.id);
    setDeleteError(null);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) { setDeleteError("Sessione scaduta. Rifai login."); return; }
      const res = await fetch("/api/ops/bulk-delete-services", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids: [service.id] })
      });
      const body = await res.json().catch(() => null) as { error?: string } | null;
      if (!res.ok) { setDeleteError(body?.error ?? "Eliminazione fallita."); return; }
      void refresh?.();
    } finally {
      setDeletingId(null);
    }
  };

  const [deletingBulk, setDeletingBulk] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const deleteBulk = async () => {
    if (!supabase || arrivals.length === 0) return;
    if (!confirm(`Eliminare tutti i ${arrivals.length} servizi visibili? L'operazione non è reversibile.`)) return;
    setDeletingBulk(true);
    setBulkError(null);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) { setBulkError("Sessione scaduta. Rifai login."); setDeletingBulk(false); return; }
      const ids = arrivals.map((i) => i.service.id);
      const res = await fetch("/api/ops/bulk-delete-services", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids })
      });
      const body = await res.json().catch(() => null) as { error?: string; deleted?: number } | null;
      if (!res.ok) {
        setBulkError(body?.error ?? `Errore ${res.status}`);
      } else {
        void refresh?.();
      }
    } catch {
      setBulkError("Errore di rete durante l'eliminazione.");
    } finally {
      setDeletingBulk(false);
    }
  };

  const [addModal, setAddModal] = useState(false);
  const [addForm, setAddForm] = useState({ date: selectedDate, time: "12:00", customer_name: "", pax: "2", hotel_id: "", vessel: "", notes: "" });
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addService = async () => {
    if (!supabase) return;
    setAddSaving(true);
    setAddError(null);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) { setAddError("Sessione scaduta."); return; }
      const res = await fetch("/api/ops/add-service", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...addForm, direction: "arrival", pax: Number(addForm.pax) || 1, hotel_id: addForm.hotel_id || undefined })
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok) { setAddError(body?.error ?? "Inserimento fallito."); return; }
      setAddModal(false);
      setAddForm({ date: selectedDate, time: "12:00", customer_name: "", pax: "2", hotel_id: "", vessel: "", notes: "" });
      void refresh?.();
    } finally {
      setAddSaving(false);
    }
  };

  const allArrivalInstances = useMemo(() =>
    buildOperationalInstances(data.services).filter((i) => i.direction === "arrival"),
  [data.services]);

  const arrivals = useMemo(() => {
    const q = search.trim().toLowerCase();
    const selectedAgencyName = agencyFilter !== "all" ? agencyById.get(agencyFilter)?.name?.toLowerCase() : null;
    return allArrivalInstances
      .filter((instance) => {
        const svc = instance.service;
        const matchAgency = agencyFilter === "all"
          || svc.agency_id === agencyFilter
          || (selectedAgencyName != null && (svc.billing_party_name ?? "").toLowerCase().includes(selectedAgencyName));
        return (
          (showAllDates || !q ? (showAllDates || instance.date === selectedDate) : true) &&
          matchAgency &&
          (!q || (svc.customer_name ?? "").toLowerCase().includes(q) || (svc.phone ?? "").toLowerCase().includes(q))
        );
      })
      .sort((left, right) => left.date !== right.date ? left.date.localeCompare(right.date) : left.time.localeCompare(right.time));
  }, [allArrivalInstances, selectedDate, showAllDates, agencyFilter, agencyById, search]);

  // Quanti arrivi ci sono in date diverse da quella selezionata (utile per suggerimento)
  const otherDatesCount = useMemo(() =>
    !showAllDates ? allArrivalInstances.filter((i) => i.date !== selectedDate).length : 0,
  [allArrivalInstances, selectedDate, showAllDates]);

  const totalPax = arrivals.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = arrivals.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;
  const privateTransfers = Math.max(arrivals.length - busCount, 0);

  const buildRows = useCallback((): ExportRow[] =>
    arrivals.map((item) => ({
      ...(showAllDates ? { Data: item.date.slice(5).replace("-", "/") } : {}),
      Ora: item.time,
      Cliente: getCustomerFullName(item.service),
      Pax: item.service.pax,
      Hotel: resolveHotelName(item.service),
      "Meeting point": item.service.meeting_point ?? item.service.vessel ?? "",
      Riferimento: getTransportReferenceOutward(item.service) ?? item.service.transport_code ?? item.service.vessel ?? "",
      Tipo: formatArrivalServiceTypeLabel(item.service),
      Agenzia: item.service.billing_party_name ?? agencyById.get(item.service.agency_id ?? "")?.name ?? "",
    }))
  , [arrivals, showAllDates, agencyById]);

  const handleExcel = () => {
    const rows = buildRows();
    const label = showAllDates ? "tutte-date" : selectedDate;
    void exportToExcel(rows, `arrivi-${label}.xlsx`);
  };

  const handlePrint = () => {
    const rows = buildRows();
    const label = showAllDates ? "Tutte le date" : formatIsoDateShort(selectedDate);
    printTable(rows, "Lista Arrivi", label);
  };

  // Partenze della stessa data per export combinato
  const buildDepartureRows = useCallback((): ExportRow[] => {
    const allInstances = buildOperationalInstances(data.services);
    return allInstances
      .filter((i) => i.direction === "departure" && i.date === selectedDate)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((item) => ({
        Ora: item.time,
        Cliente: getCustomerFullName(item.service),
        Pax: item.service.pax,
        Hotel: hotelsById.get(item.service.hotel_id)?.name ?? item.service.meeting_point ?? "N/D",
        "Meeting point": item.service.meeting_point ?? item.service.vessel ?? "",
        Riferimento: item.service.transport_code ?? item.service.vessel ?? "",
        Tipo: item.service.service_type_code ?? item.service.booking_service_kind ?? "",
        Agenzia: item.service.billing_party_name ?? agencyById.get(item.service.agency_id ?? "")?.name ?? "",
      }));
  }, [data.services, selectedDate, hotelsById, agencyById]);

  const handleCombinedExcel = () => {
    void exportCombinedExcel(buildRows(), buildDepartureRows(), selectedDate);
  };

  const handleCombinedPrint = () => {
    printCombined(buildRows(), buildDepartureRows(), formatIsoDateShort(selectedDate));
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Arrivi"
        subtitle="Vista dedicata agli arrivi operativi della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Arrivi" }]}
        actions={
          <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white/80 px-3 py-3 shadow-sm backdrop-blur-sm">
            <label className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Data</span>
              <input type="date" value={selectedDate} onChange={(event) => { setSelectedDate(event.target.value); setShowAllDates(false); }} className="input-saas mt-1 min-w-40" disabled={showAllDates} />
            </label>
            <div className="flex flex-col gap-1 self-end">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Visualizza</span>
              <button
                type="button"
                onClick={() => setShowAllDates((v) => !v)}
                className={`rounded-xl border px-3 py-2 text-xs font-semibold transition ${showAllDates ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
              >
                {showAllDates ? "📅 Tutte le date" : "Giornata"}
              </button>
            </div>
            <label className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Agenzia</span>
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas mt-1 min-w-44">
                <option value="all">Tutte le agenzie</option>
                {agencyOptions.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Cerca</span>
              <input
                type="search"
                placeholder="Nome, cognome o telefono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-saas mt-1 min-w-52"
              />
            </label>
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <span className="font-semibold text-slate-700">{formatIsoDateShort(selectedDate)}</span>
              <span className="mx-1.5 text-slate-300">•</span>
              <span>{agencyFilter === "all" ? "Tutte le agenzie" : (agencyOptions.find((a) => a.id === agencyFilter)?.name ?? agencyFilter)}</span>
            </div>
          </div>
        }
      />

      {errorMessage ? <EmptyState title="Arrivi non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 lg:grid-cols-3">
        <StatCard label="Servizi arrivo" value={String(arrivals.length)} hint="Operativi per la giornata selezionata" loading={loading} />
        <StatCard label="Pax totali" value={String(totalPax)} hint="Passeggeri da gestire in arrivo" loading={loading} />
        <StatCard label="Linea bus" value={String(busCount)} hint={`${privateTransfers} altri servizi privati`} loading={loading} />
      </div>

      <SectionCard
        title="Lista arrivi"
        subtitle={`Giornata ${formatIsoDateShort(selectedDate)}`}
        loading={loading}
        loadingLines={6}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
              {arrivals.length} servizi
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600">
              {totalPax} pax
            </span>
            <button
              type="button"
              onClick={() => { setAddForm((f) => ({ ...f, date: selectedDate })); setAddModal(true); setAddError(null); }}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 transition"
            >
              + Aggiungi arrivo
            </button>
            {arrivals.length > 0 && (<>
              <button type="button" onClick={handlePrint} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition">🖨 Stampa</button>
              <button type="button" onClick={handleExcel} className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 transition">📥 Excel</button>
            </>)}
            {!showAllDates && (<>
              <button type="button" onClick={handleCombinedPrint} className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 transition">🖨 Stampa giornata</button>
              <button type="button" onClick={handleCombinedExcel} className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 transition">📄 Excel giornata</button>
            </>)}
            {arrivals.length > 0 && (
              <button
                type="button"
                onClick={() => void deleteBulk()}
                disabled={deletingBulk}
                className="rounded-full border border-rose-200 bg-rose-50 px-2.5 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-100 disabled:opacity-50 transition"
              >
                {deletingBulk ? "Eliminando..." : `Elimina tutti (${arrivals.length})`}
              </button>
            )}
          </div>
        }
      >
        {(bulkError ?? deleteError) && (
          <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{bulkError ?? deleteError}</div>
        )}
        {arrivals.length === 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">Nessun arrivo operativo per la data selezionata.</p>
            {otherDatesCount > 0 && (
              <div className="flex items-center gap-3 rounded-2xl border border-indigo-100 bg-indigo-50 px-4 py-3">
                <span className="text-sm text-indigo-700">
                  Ci sono <strong>{otherDatesCount}</strong> arrivi in altre date nel sistema.
                </span>
                <button
                  type="button"
                  onClick={() => setShowAllDates(true)}
                  className="rounded-xl border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition"
                >
                  Mostra tutti
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className={`grid gap-4 border-b border-slate-100 bg-slate-50/90 px-4 py-3 text-[11px] uppercase tracking-wide text-slate-500 ${showAllDates ? "grid-cols-[90px_80px_1.6fr_64px_1fr_1fr_1fr_140px_136px]" : "grid-cols-[80px_1.6fr_64px_1fr_1fr_1fr_140px_136px]"}`}>
              {showAllDates && <div>Data</div>}
              <div>Ora</div>
              <div>Cliente</div>
              <div>Pax</div>
              <div>Hotel</div>
              <div>Meeting point</div>
              <div>Riferimento</div>
              <div>Tipo</div>
              <div className="text-right">Azioni</div>
            </div>
            <div className="divide-y divide-slate-100">
              {arrivals.map((item) => (
                <div
                  key={item.instanceId}
                  className={`grid gap-4 px-4 py-4 transition hover:bg-slate-50/80 ${showAllDates ? "grid-cols-[90px_80px_1.6fr_64px_1fr_1fr_1fr_140px_136px]" : "grid-cols-[80px_1.6fr_64px_1fr_1fr_1fr_140px_136px]"}`}
                >
                  {showAllDates && (
                    <div>
                      <span className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-600">
                        {item.date.slice(5).replace("-", "/")}
                      </span>
                    </div>
                  )}
                  <div>
                    <span className="inline-flex min-w-[56px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-semibold text-slate-800">
                      {item.time}
                    </span>
                  </div>
                  <div className="min-w-0 space-y-1">
                    <p className="truncate font-semibold uppercase tracking-[0.01em] text-slate-800">{getCustomerFullName(item.service)}</p>
                    {item.service.billing_party_name ? (
                      <p className="truncate text-xs text-slate-500">{item.service.billing_party_name}</p>
                    ) : null}
                    <AgencyKindBadge service={item.service} />
                  </div>
                  <div>
                    <span className="inline-flex min-w-[40px] items-center justify-center rounded-full border border-slate-200 bg-white px-2 py-1 text-sm font-semibold text-slate-700">
                      {item.service.pax}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium uppercase text-slate-700">{resolveHotelName(item.service)}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate uppercase text-slate-600">{item.service.meeting_point ?? item.service.vessel ?? "N/D"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-slate-600">{getTransportReferenceOutward(item.service) ?? item.service.transport_code ?? item.service.vessel}</p>
                  </div>
                  <div className="min-w-0">
                    <span className="inline-flex max-w-full truncate rounded-full border border-blue-100 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-700">
                      {formatArrivalServiceTypeLabel(item.service)}
                    </span>
                  </div>
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => setEditingService(item.service)}
                      className="whitespace-nowrap rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                    >
                      Modifica
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteService(item.service)}
                      disabled={deletingId === item.service.id}
                      className="whitespace-nowrap rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-100 disabled:opacity-50"
                    >
                      {deletingId === item.service.id ? "..." : "Elimina"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>

      {editingService && (
        <EditServiceModal
          service={editingService}
          hotels={data.hotels}
          tenantId={tenantId}
          onClose={() => setEditingService(null)}
          onSaved={() => { void refresh?.(); }}
        />
      )}

      {/* Modale aggiungi arrivo */}
      {addModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setAddModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800">Aggiungi arrivo</h2>
              <button type="button" onClick={() => setAddModal(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            {addError && <p className="text-sm text-rose-600">{addError}</p>}
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-xs text-slate-600 font-medium">
                Cliente*
                <input className="input-saas mt-1" value={addForm.customer_name} onChange={(e) => setAddForm((f) => ({ ...f, customer_name: e.target.value }))} placeholder="Nome e cognome" />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Data*
                <input type="date" className="input-saas mt-1" value={addForm.date} onChange={(e) => setAddForm((f) => ({ ...f, date: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Ora*
                <input type="time" className="input-saas mt-1" value={addForm.time} onChange={(e) => setAddForm((f) => ({ ...f, time: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Pax*
                <input type="number" min={1} max={50} className="input-saas mt-1" value={addForm.pax} onChange={(e) => setAddForm((f) => ({ ...f, pax: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Mezzo / Riferimento
                <input className="input-saas mt-1" placeholder="Es. SNAV, FR1234..." value={addForm.vessel} onChange={(e) => setAddForm((f) => ({ ...f, vessel: e.target.value }))} />
              </label>
              <label className="col-span-2 text-xs text-slate-600 font-medium">
                Note
                <input className="input-saas mt-1" value={addForm.notes} onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))} />
              </label>
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setAddModal(false)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">Annulla</button>
              <button type="button" onClick={() => void addService()} disabled={addSaving || !addForm.customer_name.trim() || !addForm.date || !addForm.time}
                className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40">
                {addSaving ? "Salvataggio..." : "Aggiungi"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
