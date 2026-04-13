"use client";

import { useCallback, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";

import { formatIsoDateShort, getCustomerFullName, getTransportReferenceReturn } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service } from "@/lib/types";

// ─── Export helpers ──────────────────────────────────────────────────────────
type ExportRow = { Ora: string; Cliente: string; Pax: number; "Origine/Hotel": string; "Meeting point": string; Riferimento: string; Tipo: string; Agenzia: string };

function buildTableHtml(rows: ExportRow[]): string {
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
  XLSX.utils.book_append_sheet(wb, ws, "Partenze");
  XLSX.writeFile(wb, filename);
}

async function exportCombinedExcel(arrivals: ExportRow[], departures: ExportRow[], date: string) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(arrivals.length ? arrivals : [{ Nota: "Nessun arrivo" }]), "Arrivi");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(departures.length ? departures : [{ Nota: "Nessuna partenza" }]), "Partenze");
  XLSX.writeFile(wb, `giornata-${date}.xlsx`);
}

async function fetchLogoSrc(): Promise<string> {
  try {
    const res = await fetch(`${window.location.origin}/brand/logo-ischia-transfer-email.png`);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(blob);
    });
  } catch { return ""; }
}

async function printTable(rows: ExportRow[], date: string) {
  const logoSrc = await fetchLogoSrc();
  const logoHtml = logoSrc ? `<img src="${logoSrc}" alt="Ischia Transfer Service" style="height:120px;width:auto">` : "";
  const html = `<!DOCTYPE html><html><head><title>Lista Partenze</title>
<style>body{font-family:Arial,sans-serif;margin:20px}@media print{@page{size:landscape}}</style>
</head><body>
<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0">
  ${logoHtml}
  <div>
    <div style="font-weight:700;font-size:16px;color:#0f172a">Lista Partenze</div>
    <div style="font-size:12px;color:#64748b">${date} · ${rows.length} servizi</div>
  </div>
</div>
${buildTableHtml(rows)}
<script>window.print()<\/script></body></html>`;
  const w = window.open("", "_blank", "width=1100,height=700");
  w?.document.write(html);
  w?.document.close();
}

async function printCombined(arrivals: ExportRow[], departures: ExportRow[], date: string) {
  const logoSrc = await fetchLogoSrc();
  const logoHtml = logoSrc ? `<img src="${logoSrc}" alt="Ischia Transfer Service" style="height:120px;width:auto">` : "";
  const html = `<!DOCTYPE html><html><head><title>Giornata ${date}</title>
<style>body{font-family:Arial,sans-serif;margin:20px}h3{font-size:13px;margin:24px 0 4px;color:#1e293b;border-bottom:2px solid #1e293b;padding-bottom:4px}@media print{@page{size:landscape}.pb{page-break-before:always}}</style>
</head><body>
<div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;padding-bottom:10px;border-bottom:2px solid #e2e8f0">
  ${logoHtml}
  <div style="font-weight:700;font-size:16px;color:#0f172a">Ischia Transfer Service — Giornata ${date}</div>
</div>
<h3>▼ ARRIVI (${arrivals.length})</h3>
${buildTableHtml(arrivals)}
<div class="pb"></div>
<h3>▲ PARTENZE (${departures.length})</h3>
${buildTableHtml(departures)}
<script>window.print()<\/script></body></html>`;
  const w = window.open("", "_blank", "width=1100,height=800");
  w?.document.write(html);
  w?.document.close();
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
    <span className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${entry.className}`}>
      {entry.label}
    </span>
  );
}

export default function DeparturesPage() {
  const { loading, errorMessage, data, refresh } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const tenantId = data.services[0]?.tenant_id ?? "";

  function resolveHotelName(service: Service): string {
    const byId = hotelsById.get(service.hotel_id)?.name;
    if (byId) return byId;
    const fromNotes = service.notes?.match(/Hotel:\s*([^·|\n]+)/)?.[1]?.trim();
    if (fromNotes) return fromNotes;
    const mp = service.meeting_point;
    if (mp && !["meeting point linea bus", "meeting point", "porto napoli", "porto pozzuoli", "aeroporto", "stazione"].includes(mp.toLowerCase().trim())) {
      return mp;
    }
    return "N/D";
  }

  const agencyNames = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of data.services) {
      const name = s.billing_party_name?.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = seen.get(key);
      if (!existing || (existing === existing.toUpperCase() && name !== name.toUpperCase())) {
        seen.set(key, name);
      }
    }
    return ["all", ...Array.from(seen.values()).sort((a, b) => a.localeCompare(b, "it"))];
  }, [data.services]);

  const departures = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buildOperationalInstances(data.services)
      .filter((instance) =>
        instance.direction === "departure" &&
        (!q ? instance.date === selectedDate : true) &&
        (agencyFilter === "all" || instance.service.billing_party_name?.trim().toLowerCase() === agencyFilter.toLowerCase()) &&
        (!q || (instance.service.customer_name ?? "").toLowerCase().includes(q) || (instance.service.phone ?? "").toLowerCase().includes(q))
      )
      .sort((left, right) => left.time.localeCompare(right.time));
  }, [data.services, selectedDate, agencyFilter, search]);

  const totalPax = departures.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = departures.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteService = async (service: Service) => {
    if (!supabase) return;
    const hasArrival = !!(service.arrival_date ?? service.date);
    const hasDepartureOnly = !hasArrival;
    const label = hasArrival && !hasDepartureOnly
      ? `Rimuovere solo il ritorno di ${service.customer_name}? L'arrivo rimarrà.`
      : `Eliminare il servizio di ${service.customer_name}? L'operazione non è reversibile.`;
    if (!confirm(label)) return;
    setDeletingId(service.id);
    setDeleteError(null);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) { setDeleteError("Sessione scaduta. Rifai login."); return; }
      // Se ha anche l'arrivo → azzera solo departure_date/departure_time
      if (hasArrival) {
        const res = await fetch("/api/ops/clear-service-departure", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: service.id })
        });
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (!res.ok) { setDeleteError(body?.error ?? "Operazione fallita."); return; }
      } else {
        // Solo partenza → elimina il record intero
        const res = await fetch("/api/ops/bulk-delete-services", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ ids: [service.id] })
        });
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (!res.ok) { setDeleteError(body?.error ?? "Eliminazione fallita."); return; }
      }
      void refresh?.();
    } finally {
      setDeletingId(null);
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
        body: JSON.stringify({ ...addForm, direction: "departure", pax: Number(addForm.pax) || 1, hotel_id: addForm.hotel_id || undefined })
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

  const buildRows = useCallback((): ExportRow[] =>
    departures.map((item) => ({
      Ora: item.time,
      Cliente: getCustomerFullName(item.service),
      Pax: item.service.pax,
      "Origine/Hotel": resolveHotelName(item.service),
      "Meeting point": item.service.meeting_point ?? item.service.vessel ?? "",
      Riferimento: getTransportReferenceReturn(item.service) ?? item.service.transport_code ?? item.service.vessel ?? "",
      Tipo: item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "",
      Agenzia: item.service.billing_party_name ?? "",
    }))
  , [departures]);

  const handleExcel = () => void exportToExcel(buildRows(), `partenze-${selectedDate}.xlsx`);
  const handlePrint = () => void printTable(buildRows(), formatIsoDateShort(selectedDate));

  // Arrivi della stessa data per export combinato
  const buildArrivalRows = useCallback((): ExportRow[] => {
    return buildOperationalInstances(data.services)
      .filter((i) => i.direction === "arrival" && i.date === selectedDate)
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((item) => ({
        Ora: item.time,
        Cliente: getCustomerFullName(item.service),
        Pax: item.service.pax,
        "Origine/Hotel": resolveHotelName(item.service),
        "Meeting point": item.service.meeting_point ?? item.service.vessel ?? "",
        Riferimento: item.service.transport_code ?? item.service.vessel ?? "",
        Tipo: item.service.service_type_code ?? item.service.booking_service_kind ?? "",
        Agenzia: item.service.billing_party_name ?? "",
      }));
  }, [data.services, selectedDate]);

  const handleCombinedExcel = () => void exportCombinedExcel(buildArrivalRows(), buildRows(), selectedDate);
  const handleCombinedPrint = () => void printCombined(buildArrivalRows(), buildRows(), formatIsoDateShort(selectedDate));

  return (
    <section className="page-section">
      <PageHeader
        title="Partenze"
        subtitle="Vista dedicata alle partenze operative della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Partenze" }]}
        actions={
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Data
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 min-w-40" />
            </label>
            <label className="text-sm">
              Agenzia
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas mt-1 min-w-44">
                {agencyNames.map((name) => (
                  <option key={name} value={name}>{name === "all" ? "Tutte le agenzie" : name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Cerca
              <input
                type="search"
                placeholder="Nome, cognome o telefono..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input-saas mt-1 min-w-52"
              />
            </label>
          </div>
        }
      />

      {errorMessage ? <EmptyState title="Partenze non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 md:grid-cols-3">
        <SectionCard title="Servizi partenza">
          <p className="text-3xl font-semibold text-text">{departures.length}</p>
        </SectionCard>
        <SectionCard title="Pax totali">
          <p className="text-3xl font-semibold text-text">{totalPax}</p>
        </SectionCard>
        <SectionCard title="Linea bus">
          <p className="text-3xl font-semibold text-text">{busCount}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Lista partenze"
        subtitle={`Giornata ${formatIsoDateShort(selectedDate)}`}
        loading={loading}
        loadingLines={6}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { setAddForm((f) => ({ ...f, date: selectedDate })); setAddModal(true); setAddError(null); }}
              className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 transition">
              + Aggiungi partenza
            </button>
            {departures.length > 0 && (<>
              <button type="button" onClick={handlePrint} className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 transition">🖨 Stampa</button>
              <button type="button" onClick={handleExcel} className="rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold text-teal-700 hover:bg-teal-100 transition">📥 Excel</button>
            </>)}
            <button type="button" onClick={handleCombinedPrint} className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 transition">🖨 Stampa giornata</button>
            <button type="button" onClick={handleCombinedExcel} className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-1 text-[11px] font-semibold text-violet-700 hover:bg-violet-100 transition">📄 Excel giornata</button>
          </div>
        }
      >
        {deleteError && (
          <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{deleteError}</div>
        )}
        {departures.length === 0 ? (
          <p className="text-sm text-muted">Nessuna partenza operativa per la data selezionata.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ora</th>
                  <th className="px-3 py-2">Cliente</th>
                  <th className="px-3 py-2">Pax</th>
                  <th className="px-3 py-2">Origine / hotel</th>
                  <th className="px-3 py-2">Meeting point</th>
                  <th className="px-3 py-2">Riferimento</th>
                  <th className="px-3 py-2">Tipo</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {departures.map((item) => (
                  <tr key={item.instanceId} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2 uppercase">
                      {getCustomerFullName(item.service)}
                      <AgencyKindBadge service={item.service} />
                    </td>
                    <td className="px-3 py-2">{item.service.pax}</td>
                    <td className="px-3 py-2 uppercase">{resolveHotelName(item.service)}</td>
                    <td className="px-3 py-2 uppercase">{item.service.meeting_point ?? "N/D"}</td>
                    <td className="px-3 py-2">{getTransportReferenceReturn(item.service) ?? item.service.transport_code ?? item.service.vessel}</td>
                    <td className="px-3 py-2">{item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D"}</td>
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => void deleteService(item.service)}
                        disabled={deletingId === item.service.id}
                        className="rounded-lg border border-rose-200 px-2 py-1 text-xs text-rose-500 hover:bg-rose-50 disabled:opacity-50">
                        {deletingId === item.service.id ? "..." : (item.service.arrival_date ? "Solo ritorno" : "Elimina")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {/* Modale aggiungi partenza */}
      {addModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setAddModal(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800">Aggiungi partenza</h2>
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
