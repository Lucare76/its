"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";

import { formatIsoDateShort, getCustomerFullName, getTransportReferenceReturn } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service, Hotel } from "@/lib/types";
import { getPickupRule, getPickupRuleByRange } from "@/lib/departure-pickup-rules";
import { getBusLinePickup, getBusLinePickupByZone } from "@/lib/bus-line-pickup-rules";
import type { BusLine } from "@/lib/bus-line-pickup-rules";

type AgencyOption = { id: string; name: string };

function isValidClockTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

// ─── Modal modifica partenza ──────────────────────────────────────────────────

function EditDepartureModal({
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
  const [hotelId, setHotelId]         = useState(service.hotel_id ?? "");
  const [customerName, setCustomerName] = useState(service.customer_name ?? "");
  const [pax, setPax]                 = useState(String(service.pax ?? 1));
  const [time, setTime]               = useState(service.time ?? "");
  const [phone, setPhone]             = useState(service.phone ?? "");
  const [notes, setNotes]             = useState(service.notes ?? "");
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState<string | null>(null);

  const save = async () => {
    if (!supabase) return;
    const trimmedTime = time.trim();
    if (!isValidClockTime(trimmedTime)) { setError("Inserisci un orario valido HH:MM."); return; }
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("services")
      .update({ hotel_id: hotelId || null, customer_name: customerName, pax: Number(pax) || 1, time: trimmedTime, phone, notes })
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
          <h2 className="text-base font-semibold text-slate-800">Modifica partenza</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
        </div>

        {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-medium text-slate-600">Hotel</p>
            <select value={hotelId} onChange={(e) => setHotelId(e.target.value)} className="input-saas w-full">
              <option value="">— Nessun hotel —</option>
              {hotels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </select>
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
            <input type="time" step="300" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Telefono
            <input value={phone} onChange={(e) => setPhone(e.target.value)} className="mt-1 input-saas w-full" />
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Note
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 input-saas w-full resize-none" />
          </label>
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

function normalizeZona(raw: string): string {
  const z = raw.toLowerCase().trim();
  if (z.includes("forio"))        return "forio";
  if (z.includes("lacco"))        return "lacco";
  if (z.includes("casamicciola")) return "casamicciola";
  if (z.includes("barano"))       return "barano";
  return "ischia";
}

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
    transfer_airport_hotel_exclusive: { label: "Agenzia · Aeroporto 🔒", className: "border-amber-300 bg-amber-100 text-amber-800" },
    transfer_airport_hotel_aliscafo: { label: "Agenzia · Aeroporto 🚤", className: "border-cyan-200 bg-cyan-50 text-cyan-700" },
    transfer_train_hotel: { label: "Agenzia · Stazione", className: "border-orange-200 bg-orange-50 text-orange-700" },
    transfer_train_hotel_exclusive: { label: "Agenzia · Stazione 🔒", className: "border-orange-300 bg-orange-100 text-orange-800" },
    transfer_train_hotel_aliscafo: { label: "Agenzia · Stazione 🚤", className: "border-teal-200 bg-teal-50 text-teal-700" },
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

  const pickupHints = useMemo(() => {
    const hints = new Map<string, { pickup: string; label: string } | null>();
    for (const item of departures) {
      const svc = item.service;
      const hotel = hotelsById.get(svc.hotel_id);
      const zona = normalizeZona(hotel?.zone ?? "");
      const kind = svc.booking_service_kind;
      const tFrom = (svc.departure_time ?? svc.time ?? "").trim();
      const agency = svc.billing_party_name?.trim() ?? "";

      let hint: { pickup: string; label: string } | null = null;

      if (kind === "bus_city_hotel" && zona) {
        const tc = (svc.transport_code ?? "").toLowerCase();
        const busLine: BusLine | null = tc.includes("italia") ? "italia"
          : tc.includes("adriatica") ? "adriatica"
          : tc.includes("centro") ? "centro"
          : null;
        if (busLine) {
          const res = hotel?.name ? getBusLinePickup(hotel.name, busLine) : null;
          const final = res ?? getBusLinePickupByZone(zona, busLine);
          if (final) hint = { pickup: final.pickup, label: `MEDMAR ${final.nave_time} · ${final.porto}` };
        }
      } else if (tFrom && zona) {
        let rule = null;
        if (kind === "transfer_port_hotel") {
          const v = svc.vessel?.toLowerCase() ?? "";
          if (v.includes("snav")) rule = getPickupRule(agency, "snav", tFrom, zona);
          else if (v.includes("medmar")) rule = getPickupRule(agency, "medmar", tFrom, zona);
        } else if (kind === "transfer_train_hotel") {
          rule = getPickupRule(agency, "treno_traghetto", tFrom, zona)
            ?? getPickupRuleByRange(agency, "treno_traghetto", tFrom, zona)
            ?? getPickupRule(agency, "treno_aliscafo", tFrom, zona)
            ?? getPickupRuleByRange(agency, "treno_aliscafo", tFrom, zona);
        } else if (kind === "transfer_airport_hotel") {
          rule = getPickupRule("", "volo_traghetto", tFrom, zona)
            ?? getPickupRuleByRange("", "volo_traghetto", tFrom, zona)
            ?? getPickupRule("", "volo_aliscafo", tFrom, zona)
            ?? getPickupRuleByRange("", "volo_aliscafo", tFrom, zona);
        }
        if (rule) hint = { pickup: rule.pickup, label: `${rule.boat_co} ${rule.boat_t} · ${rule.porto_p}` };
      }

      hints.set(svc.id, hint);
    }
    return hints;
  }, [departures, hotelsById]);

  const [appOrigin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [qrServiceId, setQrServiceId] = useState<string | null>(null);

  const [cancelModal, setCancelModal] = useState<Service | null>(null);
  const [cancelLegs, setCancelLegs] = useState<"arrival" | "departure" | "both">("both");
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [cancelSuccess, setCancelSuccess] = useState<string | null>(null);

  // Selezione bulk + assegnazione autista
  const [selectedDepIds, setSelectedDepIds]       = useState<Set<string>>(new Set());
  const [bulkDepDriverId, setBulkDepDriverId]     = useState("");
  const [bulkDepAssigning, setBulkDepAssigning]   = useState(false);
  const [bulkDepAssignError, setBulkDepAssignError] = useState<string | null>(null);

  const depDrivers = data.memberships.filter((m) => m.role === "driver");

  const toggleDepSelect = (id: string) =>
    setSelectedDepIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const assignDepBulk = async () => {
    if (!bulkDepDriverId || selectedDepIds.size === 0 || !supabase) return;
    setBulkDepAssigning(true);
    setBulkDepAssignError(null);
    try {
      const existingMap = new Map(data.assignments.map((a) => [a.service_id, a]));
      for (const serviceId of selectedDepIds) {
        const existing = existingMap.get(serviceId);
        if (existing) {
          await supabase.from("assignments").update({ driver_user_id: bulkDepDriverId }).eq("id", existing.id).eq("tenant_id", tenantId);
        } else {
          await supabase.from("assignments").insert({ tenant_id: tenantId, service_id: serviceId, driver_user_id: bulkDepDriverId, vehicle_label: "" });
        }
        await supabase.from("services").update({ status: "assigned" }).eq("id", serviceId).eq("tenant_id", tenantId).neq("status", "assigned");
      }
      setSelectedDepIds(new Set());
      setBulkDepDriverId("");
      void refresh?.();
    } catch {
      setBulkDepAssignError("Errore durante l'assegnazione.");
    } finally {
      setBulkDepAssigning(false);
    }
  };

  const openCancelModal = (service: Service) => {
    const hasArrival = !!(service.arrival_date ?? service.date);
    const hasDeparture = !!service.departure_date;
    const defaultLegs = hasArrival && hasDeparture ? "both" : hasDeparture ? "departure" : "both";
    setCancelLegs(defaultLegs as "arrival" | "departure" | "both");
    setCancelSuccess(null);
    setCancelModal(service);
  };

  const submitCancelRequest = async () => {
    if (!cancelModal || !supabase) return;
    setCancelSubmitting(true);
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) return;
      const res = await fetch("/api/ops/cancellation-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ service_id: cancelModal.id, cancel_legs: cancelLegs }),
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string; id?: string } | null;
      if (!res.ok) { setCancelSuccess(`Errore: ${body?.error ?? "operazione fallita"}`); return; }
      setCancelSuccess("Richiesta inviata. Vai su Cancellazioni per gestirla.");
      void refresh?.();
    } finally {
      setCancelSubmitting(false);
    }
  };

  const [editingService, setEditingService] = useState<Service | null>(null);
  const [addModal, setAddModal] = useState(false);

  type AddForm = {
    date: string; time: string; customer_name: string; pax: string;
    hotel_id: string; vessel: string; notes: string;
    place_type: "station" | "airport" | "snav" | "medmar" | "";
    pickup_hotel: string;   // calcolato/override
    barca_label: string;    // es. "MEDMAR 06:20 · Pozzuoli" — solo display
    barca_compagnia: string;
    orario_barca: string;
    porto_bruno: string;
  };
  const emptyForm = (): AddForm => ({
    date: selectedDate, time: "12:00", customer_name: "", pax: "2",
    hotel_id: "", vessel: "", notes: "",
    place_type: "", pickup_hotel: "", barca_label: "",
    barca_compagnia: "", orario_barca: "", porto_bruno: "",
  });
  const [addForm, setAddForm] = useState<AddForm>(emptyForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);
  const calcAbort = useRef<AbortController | null>(null);

  // Auto-calcola pickup quando cambiano ora + place_type + hotel
  useEffect(() => {
    const { time, place_type, hotel_id } = addForm;
    if (!time || !place_type || !hotel_id) return;
    const hotel = data.hotels.find((h) => h.id === hotel_id);
    if (!hotel) return;
    const zona = normalizeZona(hotel.zone ?? "");
    const transport_type =
      place_type === "airport" ? "volo_traghetto"
      : place_type === "snav"  ? "snav"
      : place_type === "medmar"? "medmar"
      : "treno_traghetto";

    calcAbort.current?.abort();
    const ctrl = new AbortController();
    calcAbort.current = ctrl;
    setCalcLoading(true);

    supabase?.auth.getSession().then(({ data: s }) => {
      const token = s.session?.access_token;
      if (!token || ctrl.signal.aborted) { setCalcLoading(false); return; }
      fetch("/api/ops/departure-pickup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "transfer", agency_name: "", transport_type, transport_from: time, zona }),
        signal: ctrl.signal,
      })
        .then((r) => r.json())
        .then((res: { ok?: boolean; pickup_time?: string; boat_co?: string; boat_time?: string; porto_p?: string }) => {
          if (ctrl.signal.aborted) return;
          if (res.ok && res.pickup_time) {
            setAddForm((f) => ({
              ...f,
              pickup_hotel: res.pickup_time ?? "",
              barca_compagnia: res.boat_co ?? "",
              orario_barca: res.boat_time ?? "",
              porto_bruno: res.porto_p ?? "",
              barca_label: [res.boat_co, res.boat_time, res.porto_p].filter(Boolean).join(" · "),
              vessel: f.vessel || `${res.boat_co ?? ""} ${res.boat_time ?? ""}`.trim(),
            }));
          } else {
            setAddForm((f) => ({ ...f, pickup_hotel: "", barca_label: "", barca_compagnia: "", orario_barca: "", porto_bruno: "" }));
          }
        })
        .catch(() => { /* abortato o errore silenzioso */ })
        .finally(() => { if (!ctrl.signal.aborted) setCalcLoading(false); });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addForm.time, addForm.place_type, addForm.hotel_id]);

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
        body: JSON.stringify({
          direction: "departure",
          date: addForm.date,
          time: addForm.time,
          customer_name: addForm.customer_name,
          pax: Number(addForm.pax) || 1,
          hotel_id: addForm.hotel_id || undefined,
          vessel: addForm.vessel || undefined,
          notes: addForm.notes || undefined,
          place_type: addForm.place_type || undefined,
          booking_service_kind:
            addForm.place_type === "airport" ? "transfer_airport_hotel"
            : addForm.place_type === "station" ? "transfer_train_hotel"
            : addForm.place_type === "snav"   ? "formula_snav"
            : addForm.place_type === "medmar" ? "formula_medmar"
            : undefined,
          pickup_hotel: addForm.pickup_hotel || undefined,
          barca_compagnia: addForm.barca_compagnia || undefined,
          orario_barca: addForm.orario_barca || undefined,
          porto_bruno: addForm.porto_bruno || undefined,
        })
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok) { setAddError(body?.error ?? "Inserimento fallito."); return; }
      setAddModal(false);
      setAddForm(emptyForm());
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
        {departures.length === 0 ? (
          <p className="text-sm text-muted">Nessuna partenza operativa per la data selezionata.</p>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="grid items-center gap-3 border-b border-slate-100 bg-slate-50/90 px-4 py-2.5 text-[11px] uppercase tracking-wide text-slate-500 grid-cols-[28px_60px_minmax(160px,1.5fr)_40px_minmax(160px,1.2fr)_minmax(130px,1fr)_128px]">
              <div>
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 rounded border-slate-300 accent-indigo-600"
                  checked={departures.length > 0 && selectedDepIds.size === departures.length}
                  onChange={() => {
                    if (selectedDepIds.size === departures.length) setSelectedDepIds(new Set());
                    else setSelectedDepIds(new Set(departures.map((i) => i.service.id)));
                  }}
                  title="Seleziona tutti"
                />
              </div>
              <div>Ora</div>
              <div>Cliente</div>
              <div>Pax</div>
              <div>Hotel · Meeting point</div>
              <div>Rif. · Tipo</div>
              <div className="text-right">Azioni</div>
            </div>
            <div className="divide-y divide-slate-100">
              {departures.map((item) => {
                const hotelName = resolveHotelName(item.service);
                const meetingPoint = item.service.meeting_point ?? null;
                const riferimento = getTransportReferenceReturn(item.service) ?? item.service.transport_code ?? item.service.vessel ?? null;
                const tipoLabel = item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D";
                const hint = pickupHints.get(item.service.id);
                return (
                  <div
                    key={item.instanceId}
                    className={`grid items-center gap-3 px-4 py-3 transition hover:bg-slate-50/60 grid-cols-[28px_60px_minmax(160px,1.5fr)_40px_minmax(160px,1.2fr)_minmax(130px,1fr)_128px] ${selectedDepIds.has(item.service.id) ? "bg-indigo-50/60" : ""}`}
                  >
                    {/* CHECKBOX */}
                    <div>
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-slate-300 accent-indigo-600"
                        checked={selectedDepIds.has(item.service.id)}
                        onChange={() => toggleDepSelect(item.service.id)}
                      />
                    </div>
                    {/* ORA + hint pickup */}
                    <div className="space-y-0.5">
                      <span className="inline-flex min-w-[48px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-bold text-slate-800">
                        {item.time}
                      </span>
                      {hint && hint.pickup !== item.time && (
                        <p className="text-[10px] font-semibold text-amber-600 cursor-help" title={`Regole: ${hint.pickup} · ${hint.label}`}>
                          ⏰ {hint.pickup}
                        </p>
                      )}
                      {hint && hint.pickup === item.time && (
                        <p className="text-[10px] text-emerald-500" title="Orario conforme alle regole">✓</p>
                      )}
                    </div>
                    {/* CLIENTE */}
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-semibold uppercase tracking-[0.01em] text-slate-800" title={getCustomerFullName(item.service)}>
                        {getCustomerFullName(item.service)}
                      </p>
                      <div className="flex flex-wrap items-center gap-1">
                        <AgencyKindBadge service={item.service} />
                        {item.service.billing_party_name ? (
                          <span className="truncate text-[11px] text-slate-400" title={item.service.billing_party_name}>{item.service.billing_party_name}</span>
                        ) : null}
                      </div>
                    </div>
                    {/* PAX */}
                    <div>
                      <span className="inline-flex min-w-[32px] items-center justify-center rounded-full border border-slate-200 bg-white px-1.5 py-0.5 text-sm font-semibold text-slate-700">
                        {item.service.pax}
                      </span>
                    </div>
                    {/* HOTEL + MEETING POINT */}
                    <div className="min-w-0 space-y-0.5">
                      <p className="truncate text-sm font-medium uppercase text-slate-700" title={hotelName}>{hotelName}</p>
                      {meetingPoint ? (
                        <p className="truncate text-[11px] uppercase text-slate-400" title={meetingPoint}>{meetingPoint}</p>
                      ) : null}
                    </div>
                    {/* RIFERIMENTO + TIPO */}
                    <div className="min-w-0 space-y-0.5">
                      {riferimento ? (
                        <p className="truncate text-sm text-slate-600" title={riferimento}>{riferimento}</p>
                      ) : null}
                      <span className="inline-flex rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-blue-700">
                        {tipoLabel}
                      </span>
                    </div>
                    {/* AZIONI */}
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => setQrServiceId(item.service.id)}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-2 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100"
                        title="Mostra QR smarcamento"
                      >
                        QR
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingService(item.service)}
                        className="rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
                      >
                        Modifica
                      </button>
                      <button
                        type="button"
                        onClick={() => openCancelModal(item.service)}
                        className="rounded-xl border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-100"
                      >
                        Cancella
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* Toolbar assegnazione bulk */}
        {selectedDepIds.size > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-indigo-200 bg-indigo-50 px-4 py-3">
            <span className="text-sm font-semibold text-indigo-700">
              {selectedDepIds.size} servizi selezionati
            </span>
            <select
              value={bulkDepDriverId}
              onChange={(e) => setBulkDepDriverId(e.target.value)}
              className="input-saas min-w-44"
            >
              <option value="">Scegli autista…</option>
              {depDrivers.map((d) => (
                <option key={d.user_id} value={d.user_id}>{d.full_name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void assignDepBulk()}
              disabled={!bulkDepDriverId || bulkDepAssigning}
              className="rounded-xl border border-indigo-300 bg-indigo-600 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50 transition"
            >
              {bulkDepAssigning ? "Assegnando…" : "Assegna"}
            </button>
            <button
              type="button"
              onClick={() => { setSelectedDepIds(new Set()); setBulkDepAssignError(null); }}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
            >
              Deseleziona
            </button>
            {bulkDepAssignError && (
              <span className="text-xs text-rose-600">{bulkDepAssignError}</span>
            )}
          </div>
        )}
      </SectionCard>

      {editingService && (
        <EditDepartureModal
          service={editingService}
          hotels={data.hotels}
          tenantId={tenantId}
          onClose={() => setEditingService(null)}
          onSaved={() => { void refresh?.(); }}
        />
      )}

      {qrServiceId && appOrigin && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setQrServiceId(null)}>
          <div className="w-full max-w-xs rounded-2xl bg-white p-6 shadow-xl text-center space-y-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-slate-700">Scansiona per smarcamento</h2>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(`${appOrigin}/scan/${qrServiceId}`)}`}
              alt="QR smarcamento"
              width={200}
              height={200}
              className="mx-auto rounded-xl border border-slate-200"
            />
            <a
              href={`/scan/${qrServiceId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-xs font-medium text-indigo-600 hover:underline"
            >
              Apri pagina smarcamento →
            </a>
            <button
              type="button"
              onClick={() => setQrServiceId(null)}
              className="w-full rounded-xl border border-slate-200 py-2 text-sm text-slate-500 hover:bg-slate-50"
            >
              Chiudi
            </button>
          </div>
        </div>
      )}

      {/* Modale cancellazione */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!cancelSubmitting) setCancelModal(null); }}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800">Richiesta cancellazione</h2>
              {!cancelSubmitting && (
                <button type="button" onClick={() => setCancelModal(null)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
              )}
            </div>
            <p className="text-sm text-slate-600">
              <span className="font-semibold">{cancelModal.customer_name}</span> — {cancelModal.pax} pax
            </p>
            {cancelSuccess ? (
              <div className="space-y-3">
                <p className={`text-sm ${cancelSuccess.startsWith("Errore") ? "text-rose-600" : "text-emerald-600"}`}>{cancelSuccess}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setCancelModal(null)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">Chiudi</button>
                  {!cancelSuccess.startsWith("Errore") && (
                    <a href="/cancellazioni" className="flex-1 rounded-xl bg-slate-800 px-4 py-2.5 text-center text-sm font-semibold text-white hover:bg-slate-700">Vai a Cancellazioni →</a>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Cosa cancellare?</p>
                  {cancelModal.arrival_date && (
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
                      <input type="radio" name="cancel_legs" value="both" checked={cancelLegs === "both"} onChange={() => setCancelLegs("both")} className="accent-rose-500" />
                      <span className="text-sm text-slate-700">Arrivo e partenza (intero servizio)</span>
                    </label>
                  )}
                  <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
                    <input type="radio" name="cancel_legs" value="departure" checked={cancelLegs === "departure"} onChange={() => setCancelLegs("departure")} className="accent-rose-500" />
                    <span className="text-sm text-slate-700">Solo partenza</span>
                  </label>
                  {cancelModal.arrival_date && (
                    <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-slate-200 px-3 py-2.5 hover:bg-slate-50">
                      <input type="radio" name="cancel_legs" value="arrival" checked={cancelLegs === "arrival"} onChange={() => setCancelLegs("arrival")} className="accent-rose-500" />
                      <span className="text-sm text-slate-700">Solo arrivo</span>
                    </label>
                  )}
                </div>
                <p className="text-xs text-slate-400">La richiesta sarà inviata all&apos;admin/operatore per decidere l&apos;eventuale penale.</p>
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => setCancelModal(null)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50">Annulla</button>
                  <button type="button" onClick={() => void submitCancelRequest()} disabled={cancelSubmitting}
                    className="flex-1 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40">
                    {cancelSubmitting ? "Invio..." : "Invia richiesta"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
                {addForm.place_type === "snav" || addForm.place_type === "medmar" ? "Ora barca*" : "Ora volo/treno*"}
                <input type="time" className="input-saas mt-1" value={addForm.time} onChange={(e) => setAddForm((f) => ({ ...f, time: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Tipo*
                <select className="input-saas mt-1" value={addForm.place_type} onChange={(e) => setAddForm((f) => ({ ...f, place_type: e.target.value as AddForm["place_type"] }))}>
                  <option value="">— seleziona —</option>
                  <option value="station">🚂 Stazione / Treno</option>
                  <option value="airport">✈️ Aeroporto / Volo</option>
                  <option value="snav">⛴ Formula SNAV</option>
                  <option value="medmar">⛴ Formula MEDMAR</option>
                </select>
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Hotel
                <select className="input-saas mt-1" value={addForm.hotel_id} onChange={(e) => setAddForm((f) => ({ ...f, hotel_id: e.target.value }))}>
                  <option value="">— seleziona hotel —</option>
                  {[...data.hotels].sort((a, b) => a.name.localeCompare(b.name, "it")).map((h) => (
                    <option key={h.id} value={h.id}>{h.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Pax*
                <input type="number" min={1} max={50} className="input-saas mt-1" value={addForm.pax} onChange={(e) => setAddForm((f) => ({ ...f, pax: e.target.value }))} />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Volo / Riferimento
                <input className="input-saas mt-1" placeholder="Es. FR1234, IC722..." value={addForm.vessel} onChange={(e) => setAddForm((f) => ({ ...f, vessel: e.target.value }))} />
              </label>
              <label className="col-span-2 text-xs text-slate-600 font-medium">
                Note
                <input className="input-saas mt-1" value={addForm.notes} onChange={(e) => setAddForm((f) => ({ ...f, notes: e.target.value }))} />
              </label>
            </div>

            {/* Sezione pickup calcolato automaticamente */}
            {(addForm.place_type && addForm.hotel_id && addForm.time) && (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                <p className="text-xs font-semibold text-emerald-700 flex items-center gap-1.5">
                  {calcLoading ? "⏳ Calcolo in corso..." : "🤖 Pickup calcolato automaticamente"}
                </p>
                {!calcLoading && (
                  <div className="grid grid-cols-2 gap-2">
                    <label className="text-xs text-slate-600 font-medium">
                      Prelevamento hotel
                      <input
                        className="input-saas mt-1"
                        value={addForm.pickup_hotel}
                        onChange={(e) => setAddForm((f) => ({ ...f, pickup_hotel: e.target.value }))}
                        placeholder="HH:MM"
                      />
                    </label>
                    <label className="text-xs text-slate-600 font-medium">
                      Traghetto / Aliscafo
                      <input
                        className="input-saas mt-1"
                        value={addForm.vessel}
                        onChange={(e) => setAddForm((f) => ({ ...f, vessel: e.target.value }))}
                        placeholder="es. MEDMAR 06:20"
                      />
                    </label>
                    {addForm.barca_label && (
                      <p className="col-span-2 text-xs text-emerald-600">
                        ⚓ {addForm.barca_label}
                      </p>
                    )}
                    {!addForm.pickup_hotel && !calcLoading && (
                      <p className="col-span-2 text-xs text-amber-600">Nessuna regola trovata — inserisci manualmente</p>
                    )}
                  </div>
                )}
              </div>
            )}

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
