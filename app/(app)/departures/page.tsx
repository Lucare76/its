"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput, EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";

import { formatIsoDateShort, getCustomerFullName, getDepartureFerryLabel, getDepartureTransportReference } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service, Hotel } from "@/lib/types";
import { getPickupRule, getPickupRuleByRange } from "@/lib/departure-pickup-rules";
import { getBusLinePickup, getBusLinePickupByZone } from "@/lib/bus-line-pickup-rules";
import type { BusLine } from "@/lib/bus-line-pickup-rules";

function isValidClockTime(value: string) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

function isShuttleService(service: Service) {
  return service.booking_service_kind === "navetta" || service.booking_service_kind === "shuttle_hotel" || service.vessel?.trim().toLowerCase() === "navetta";
}

function cleanDepartureDisplayClock(value?: string | null, options?: { allowMidnight?: boolean }) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^([01]\d|2[0-3]):([0-5]\d)/);
  if (!match) return null;
  const time = `${match[1]}:${match[2]}`;
  if (!options?.allowMidnight && time === "00:00") return null;
  return time;
}

function isBusLineDepartureService(service: Service) {
  return service.booking_service_kind === "bus_city_hotel" || service.service_type_code === "bus_line";
}

function getDeparturePickupTime(item: { time: string; service: Service }) {
  const service = item.service;
  if (!isBusLineDepartureService(service)) return item.time;
  return (
    cleanDepartureDisplayClock(service.bus_operational_hotel_pickup_time) ??
    cleanDepartureDisplayClock(service.pickup_time) ??
    cleanDepartureDisplayClock(service.departure_time) ??
    cleanDepartureDisplayClock(service.time) ??
    cleanDepartureDisplayClock(item.time) ??
    "--:--"
  );
}

function getDepartureDestinationLabel(service: Service) {
  if (isBusLineDepartureService(service)) {
    return service.bus_operational_destination_label ?? service.bus_operational_stop_name ?? service.meeting_point ?? "Destinazione N/D";
  }
  return service.meeting_point ?? "Destinazione N/D";
}

function getDepartureTransportLabel(service: Service) {
  if (isBusLineDepartureService(service)) {
    return service.bus_operational_line_name ?? service.transport_code ?? service.vessel ?? "Linea bus";
  }
  return getDepartureFerryLabel(service) ?? getDepartureTransportReference(service) ?? service.vessel ?? "Corsa N/D";
}

function getDepartureTimeBand(item: { time: string; service: Service }) {
  const pickupTime = getDeparturePickupTime(item);
  const hour = Number(pickupTime.slice(0, 2));
  if (!Number.isFinite(hour)) return "evening";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function TransportIcon({ service }: { service: Service }) {
  const value = `${service.booking_service_kind ?? ""} ${service.service_type_code ?? ""} ${service.vessel ?? ""} ${service.transport_code ?? ""}`.toLowerCase();
  const common = "h-6 w-6 shrink-0 text-slate-700";
  if (value.includes("airport") || value.includes("volo") || value.includes("flight")) return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={common}><path d="m3 16 8-4-5-7 2-1 7 6 5-2c1.5-.6 2.5 1.4 1.1 2.2L15 14l-2 7-2 1v-7l-6 3-2-2Z"/></svg>;
  if (value.includes("train") || value.includes("station") || value.includes("italo") || value.includes("treno")) return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={common}><rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 7h8M7 13h10M8 21l2-3m6 3-2-3"/><circle cx="9" cy="15" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1" fill="currentColor" stroke="none"/></svg>;
  if (value.includes("bus") || value.includes("navetta")) return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={common}><rect x="4" y="3" width="16" height="16" rx="3"/><path d="M7 7h10v6H7zM7 19v2m10-2v2M7 16h.01M17 16h.01"/></svg>;
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={common}><path d="M5 11h14l-2 7H7l-2-7Zm3 0V6h8v5m-6-5V3h4v3M3 20c2 1 4 1 6 0 2 1 4 1 6 0 2 1 4 1 6 0"/></svg>;
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
  const [time, setTime]               = useState((service.time ?? "").slice(0, 5));
  const [phone, setPhone]             = useState(service.phone ?? "");
  const [notes, setNotes]             = useState(service.notes ?? "");
  const serviceRecord = service as unknown as Record<string, unknown>;
  const [arrivalDate, setArrivalDate] = useState(serviceRecord.arrival_date as string ?? "");
  const [arrivalTime, setArrivalTime] = useState((serviceRecord.arrival_time as string ?? "").slice(0, 5));
  const [departureDate, setDepartureDate] = useState(serviceRecord.departure_date as string ?? "");
  const [departureTime, setDepartureTime] = useState((serviceRecord.departure_time as string ?? "").slice(0, 5));
  const [transportCode, setTransportCode] = useState(serviceRecord.transport_code as string ?? "");
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
      .update({
        hotel_id: hotelId || null,
        customer_name: customerName,
        pax: Number(pax) || 1,
        time: trimmedTime,
        phone,
        notes,
        arrival_date: arrivalDate || null,
        arrival_time: arrivalTime || null,
        departure_date: departureDate || null,
        departure_time: departureTime || null,
        transport_code: transportCode.trim() || null,
      })
      .eq("id", service.id)
      .eq("tenant_id", tenantId);
    setSaving(false);
    if (err) { setError(err.message); return; }
    onSaved();
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-card modal-card-lg space-y-4">
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

          {/* Date prenotazione */}
          <div className="sm:col-span-2">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Date prenotazione</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-medium text-slate-600">
                Data arrivo
                <DateInput value={arrivalDate} onChange={(iso) => setArrivalDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Ora arrivo
                <input type="time" step="300" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Data partenza
                <DateInput value={departureDate} onChange={(iso) => setDepartureDate(iso)} className="mt-1 input-saas w-full" />
              </label>
              <label className="text-xs font-medium text-slate-600">
                Ora partenza
                <input type="time" step="300" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} className="mt-1 input-saas w-full" />
              </label>
            </div>
          </div>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Rif. volo / treno
            <input value={transportCode} onChange={(e) => setTransportCode(e.target.value)} className="mt-1 input-saas w-full" placeholder="Es. FR1234 / IC345" />
          </label>

          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Note
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 input-saas w-full resize-none" />
          </label>
        </div>

        <div className="modal-actions justify-end">
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
    formula_medmar_napoli: { label: "MEDMAR Napoli", className: "border-sky-200 bg-sky-50 text-sky-700" },
    formula_medmar_pozzuoli: { label: "MEDMAR Pozzuoli", className: "border-sky-200 bg-sky-50 text-sky-700" },
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
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  // Sprint Performance 13: same date-scope rationale as Arrivals (see that
  // page for details) — Departures only ever shows/exports one business date
  // at a time, so scope services to it instead of the full tenant history.
  // Note: the agency-filter dropdown (`agencyNames`, derived from data.services
  // below) now only lists agencies present on the loaded date's services
  // instead of the entire tenant history — a direct, documented consequence of
  // scoping, not a business-rule change.
  const { loading, errorMessage, data, refresh } = useTenantOperationalData({
    datasets: { services: true, assignments: true, hotels: true, memberships: true },
    serviceScope: { mode: "date", date: selectedDate }
  });
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [timeBand, setTimeBand] = useState<"all" | "morning" | "afternoon" | "evening">("all");
  const [departureView, setDepartureView] = useState<"transfers" | "shuttles">("transfers");
  const [currentPage, setCurrentPage] = useState(1);

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);

  const resolvePickupNote = useCallback((service: Service): string | null => {
    const hotel = hotelsById.get(service.hotel_id);
    if (hotel?.pickup_note) return hotel.pickup_note;
    const isFormula = ["formula_snav","formula_medmar_napoli","formula_medmar_pozzuoli"]
      .includes(service.booking_service_kind ?? "");
    if (isFormula) return hotel?.name ?? null;
    return service.meeting_point ?? hotel?.name ?? null;
  }, [hotelsById]);
  const tenantId = data.services[0]?.tenant_id ?? "";

  const resolveHotelName = useCallback((service: Service): string => {
    const byId = hotelsById.get(service.hotel_id)?.name;
    if (byId) return byId;
    const fromNotes = service.notes?.match(/Hotel:\s*([^·|\n]+)/)?.[1]?.trim();
    if (fromNotes) return fromNotes;
    const mp = service.meeting_point;
    if (mp && !["meeting point linea bus", "meeting point", "porto napoli", "porto pozzuoli", "aeroporto", "stazione"].includes(mp.toLowerCase().trim())) {
      return mp;
    }
    return "N/D";
  }, [hotelsById]);

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
        instance.date === selectedDate &&
        (agencyFilter === "all" || instance.service.billing_party_name?.trim().toLowerCase() === agencyFilter.toLowerCase()) &&
        (!q || [instance.service.customer_name, instance.service.phone, instance.service.billing_party_name, instance.service.vessel, instance.service.transport_code, instance.service.bus_operational_line_name, instance.service.bus_operational_stop_name, instance.service.bus_operational_destination_label, hotelsById.get(instance.service.hotel_id)?.name].some((value) => (value ?? "").toLowerCase().includes(q))) &&
        (departureView === "shuttles" ? isShuttleService(instance.service) : !isShuttleService(instance.service)) &&
        (timeBand === "all" || getDepartureTimeBand(instance) === timeBand)
      )
      .sort((left, right) => getDeparturePickupTime(left).localeCompare(getDeparturePickupTime(right)));
  }, [data.services, selectedDate, agencyFilter, search, hotelsById, departureView, timeBand]);

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
    let successCount = 0;
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) {
        setBulkDepAssignError("Sessione scaduta. Rifai login.");
        return;
      }

      const serviceIds = Array.from(selectedDepIds);
      for (const serviceId of serviceIds) {
        const res = await fetch("/api/ops/assign-service", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            service_id: serviceId,
            driver_user_id: bulkDepDriverId,
            action: "assign",
          }),
        });
        const body = await res.json().catch(() => null) as { error?: string } | null;
        if (!res.ok) {
          const apiError = body?.error ?? `Errore ${res.status}`;
          const readableError = res.status === 409 && apiError.toLowerCase().includes("disponibilita")
            ? "Disponibilità non confermata per questa data. Conferma la disponibilità prima di assegnare."
            : apiError;
          const failedCount = serviceIds.length - successCount;
          setBulkDepAssignError(
            successCount > 0
              ? `${successCount} assegnati, ${failedCount} non assegnati. ${readableError}`
              : readableError
          );
          if (successCount > 0) void refresh?.();
          return;
        }
        successCount += 1;
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
            : addForm.place_type === "medmar" ? "formula_medmar_pozzuoli"
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
      Ora: getDeparturePickupTime(item),
      Cliente: getCustomerFullName(item.service),
      Pax: item.service.pax,
      "Origine/Hotel": resolveHotelName(item.service),
      "Meeting point": getDepartureDestinationLabel(item.service),
      Riferimento: getDepartureTransportLabel(item.service),
      Tipo: item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "",
      Agenzia: item.service.billing_party_name ?? "",
    }))
  , [departures, resolveHotelName]);

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
  }, [data.services, selectedDate, resolveHotelName]);

  const handleCombinedExcel = () => void exportCombinedExcel(buildArrivalRows(), buildRows(), selectedDate);
  const handleCombinedPrint = () => void printCombined(buildArrivalRows(), buildRows(), formatIsoDateShort(selectedDate));

  const assignmentByServiceId = new Map(data.assignments.map((assignment) => [assignment.service_id, assignment]));
  const driverById = new Map(data.memberships.map((member) => [member.user_id, member.full_name]));
  const unassignedCount = departures.filter((item) => !assignmentByServiceId.get(item.service.id)?.driver_user_id).length;
  const reviewCount = departures.filter((item) => item.service.status === "new").length;
  const shuttleCount = buildOperationalInstances(data.services).filter((item) => item.direction === "departure" && item.date === selectedDate && isShuttleService(item.service)).length;
  const timeBandCounts = buildOperationalInstances(data.services).filter((item) => item.direction === "departure" && item.date === selectedDate && !isShuttleService(item.service)).reduce((counts, item) => {
    counts[getDepartureTimeBand(item)] += 1;
    return counts;
  }, { morning: 0, afternoon: 0, evening: 0 });
  const rowsPerPage = 50;
  const pageCount = Math.max(1, Math.ceil(departures.length / rowsPerPage));
  const safePage = Math.min(currentPage, pageCount);
  const visibleDepartures = departures.slice((safePage - 1) * rowsPerPage, safePage * rowsPerPage);

  return (
    <section className="page-section">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-5">
          <div><h1 className="text-3xl font-extrabold tracking-tight text-slate-950">Partenze</h1><p className="mt-1 text-sm text-slate-500">{new Intl.DateTimeFormat("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${selectedDate}T12:00:00`))}</p></div>
          <div className="flex items-center gap-2"><button type="button" className="btn-secondary px-3 py-2" onClick={() => setSelectedDate(new Date(new Date(`${selectedDate}T12:00:00`).getTime() - 86400000).toISOString().slice(0,10))}>‹</button><DateInput value={selectedDate} onChange={setSelectedDate} className="input-saas w-40"/><button type="button" className="btn-secondary px-3 py-2" onClick={() => setSelectedDate(new Date(new Date(`${selectedDate}T12:00:00`).getTime() + 86400000).toISOString().slice(0,10))}>›</button></div>
        </div>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={handlePrint} className="btn-secondary px-4 py-2">▣ Stampa giornata</button><button type="button" onClick={handleExcel} className="btn-secondary px-4 py-2">▤ Esporta Excel</button><button type="button" onClick={() => { setAddForm((form) => ({...form,date:selectedDate})); setAddModal(true); }} className="btn-primary px-5 py-2">＋ Aggiungi partenza</button></div>
      </header>

      {errorMessage ? <EmptyState title="Partenze non disponibili" description={errorMessage} compact /> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[["↗","Partenze",departures.length,"bg-emerald-50 text-emerald-600"],["♙","Passeggeri",totalPax,"bg-violet-50 text-violet-600"],["♙","Da assegnare",unassignedCount,"bg-orange-50 text-orange-600"],["⌕","Da verificare",reviewCount,"bg-amber-50 text-amber-600"],["◷","In ritardo",0,"bg-rose-50 text-rose-600"]].map(([icon,label,value,tone]) => <div key={String(label)} className="flex h-[104px] items-center gap-4 rounded-xl border border-slate-200 bg-white px-5 shadow-sm"><span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-3xl ${tone}`}>{icon}</span><div><p className="text-sm font-medium text-slate-500">{label}</p><strong className="text-3xl leading-none text-slate-950">{value}</strong></div></div>)}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_290px]">
        <SectionCard title="Lista partenze" subtitle={`Giornata ${formatIsoDateShort(selectedDate)}`} loading={loading} loadingLines={6}>
          <div className="mb-4 border-b border-slate-200 pb-4">
            <div className="flex flex-col gap-3 lg:flex-row"><input type="search" value={search} onChange={(event)=>setSearch(event.target.value)} className="input-saas min-w-0 flex-1" placeholder="Cerca cliente, telefono, hotel, corsa, agenzia..."/><button type="button" onClick={()=>setSelectedDate(todayIso)} className="btn-secondary px-4">Oggi</button><button type="button" onClick={()=>setSelectedDate(new Date(new Date(`${todayIso}T12:00:00`).getTime()+86400000).toISOString().slice(0,10))} className="btn-secondary px-4">Domani</button><select value={agencyFilter} onChange={(event)=>setAgencyFilter(event.target.value)} className="input-saas lg:w-44"><option value="all">Filtri</option>{agencyNames.filter((name)=>name!=="all").map((name)=><option key={name} value={name}>{name}</option>)}</select></div>
            <div className="mt-3 flex flex-wrap gap-2">{([['all','Tutti',departures.length],['morning','Mattina',timeBandCounts.morning],['afternoon','Pomeriggio',timeBandCounts.afternoon],['evening','Sera',timeBandCounts.evening]] as const).map(([value,label,count])=><button key={value} type="button" onClick={()=>{setTimeBand(value);setCurrentPage(1);}} className={timeBand===value?"btn-primary px-3 py-2 text-xs":"btn-secondary px-3 py-2 text-xs"}>{label} {count}</button>)}<button type="button" onClick={()=>setSearch("MEDMAR")} className="btn-secondary px-3 py-2 text-xs">MEDMAR</button><button type="button" onClick={()=>setSearch("SNAV")} className="btn-secondary px-3 py-2 text-xs">SNAV</button><button type="button" onClick={()=>setDepartureView((view)=>view==="transfers"?"shuttles":"transfers")} className="btn-secondary border-dashed px-3 py-2 text-xs">{departureView==="shuttles"?"Mostra transfer":`Navette ${shuttleCount}`}</button></div>
            <p className="mt-3 text-xs text-slate-500">ⓘ {departureView === "shuttles" ? "Vista dedicata alle navette quotidiane" : "Navette escluse dalla vista standard"}</p>
          </div>
          {departures.length === 0 ? <p className="py-12 text-center text-sm text-slate-500">Nessuna partenza nel filtro selezionato.</p> : <>
          <div className="space-y-2 md:hidden">{visibleDepartures.map((item)=><article key={`compact-${item.instanceId}`} className="rounded-xl border border-slate-200 bg-white p-3"><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-slate-800">{getCustomerFullName(item.service)}</p><p className="mt-1 text-xs text-slate-500">{resolveHotelName(item.service)}</p></div><strong className="rounded-lg bg-indigo-50 px-2 py-1 text-indigo-700">{getDeparturePickupTime(item)}</strong></div><div className="mt-3 flex items-center gap-2 text-sm text-slate-600"><TransportIcon service={item.service}/><span>{getDepartureTransportLabel(item.service)}</span></div><div className="mt-3 flex gap-2"><button type="button" onClick={()=>setQrServiceId(item.service.id)} className="btn-secondary px-3 py-1.5 text-xs">Dettagli</button><button type="button" onClick={()=>setEditingService(item.service)} className="btn-secondary px-3 py-1.5 text-xs">Modifica</button><button type="button" onClick={()=>openCancelModal(item.service)} className="btn-secondary px-3 py-1.5 text-xs">•••</button></div></article>)}</div>
          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block">
            <div className="grid grid-cols-[70px_minmax(125px,1.1fr)_32px_minmax(120px,1fr)_minmax(135px,1.15fr)_minmax(105px,.8fr)_94px_124px] gap-2 border-b border-slate-200 px-3 py-3 text-[10px] font-bold uppercase tracking-wide text-slate-500"><span>Ora pickup</span><span>Cliente</span><span>Pax</span><span>Hotel / Pickup</span><span>Corsa / Destinazione</span><span>Autista / Veicolo</span><span>Stato</span><span className="text-right">Azioni</span></div>
            <div className="divide-y divide-slate-100">{visibleDepartures.map((item)=>{const service=item.service;const assignment=assignmentByServiceId.get(service.id);const driverName=assignment?.driver_user_id?driverById.get(assignment.driver_user_id):null;const unassigned=!driverName;const hotel=resolveHotelName(service);const pickupTime=getDeparturePickupTime(item);const destination=getDepartureDestinationLabel(service);const transport=getDepartureTransportLabel(service);return <div key={item.instanceId} className={`grid grid-cols-[70px_minmax(125px,1.1fr)_32px_minmax(120px,1fr)_minmax(135px,1.15fr)_minmax(105px,.8fr)_94px_124px] items-center gap-2 px-3 py-3 ${unassigned?"bg-amber-50/55":"hover:bg-slate-50/70"}`}><strong className="text-sm text-indigo-700">{pickupTime}</strong><div className="min-w-0"><p className="whitespace-normal break-words text-sm font-bold leading-tight text-slate-800">{getCustomerFullName(service)}</p><p className="mt-1 break-all text-[11px] text-slate-500">{service.phone||"Telefono non indicato"}</p></div><span className="text-sm font-semibold">{service.pax}</span><div className="min-w-0"><p className="whitespace-normal break-words text-sm font-semibold leading-tight">{hotel}</p><p className="mt-1 whitespace-normal break-words text-[11px] text-slate-500">{resolvePickupNote(service)||"Pickup hotel"}</p></div><div className="flex min-w-0 items-start gap-2"><TransportIcon service={service}/><div className="min-w-0"><p className="whitespace-normal break-words text-sm font-semibold leading-tight">{transport}</p><p className="mt-1 text-[11px] text-slate-500">{destination}</p></div></div><div className="min-w-0"><p className="whitespace-normal break-words text-sm font-medium">{driverName||"Non assegnato"}</p><p className="mt-1 text-[11px] text-slate-500">{assignment?.vehicle_label||"—"}</p></div><span className={`w-fit whitespace-nowrap rounded-lg px-2 py-1 text-[10px] font-bold ${unassigned?"border border-orange-200 bg-orange-50 text-orange-600":service.status==="new"?"border border-amber-200 bg-amber-50 text-amber-600":"bg-indigo-50 text-indigo-700"}`}>{unassigned?"Da assegnare":service.status==="new"?"Da verificare":"Confermato"}</span><div className="flex justify-end gap-1"><button type="button" onClick={()=>setQrServiceId(service.id)} className="rounded-lg border border-slate-200 bg-white px-1.5 py-1.5 text-[11px] text-slate-600">Dettagli</button><button type="button" onClick={()=>setEditingService(service)} className="rounded-lg border border-slate-200 bg-white px-1.5 py-1.5 text-[11px] text-slate-600">Modifica</button><button type="button" onClick={()=>openCancelModal(service)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-bold text-slate-600">•••</button></div></div>})}</div>
            <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-xs text-slate-500"><span>Visualizzati {departures.length?((safePage-1)*rowsPerPage)+1:0}–{Math.min(safePage*rowsPerPage,departures.length)} di {departures.length}</span><div className="flex gap-1"><button type="button" disabled={safePage===1} onClick={()=>setCurrentPage(safePage-1)} className="btn-secondary px-3 py-1.5 disabled:opacity-40">‹</button><span className="btn-primary px-3 py-1.5">{safePage}</span><button type="button" disabled={safePage===pageCount} onClick={()=>setCurrentPage(safePage+1)} className="btn-secondary px-3 py-1.5 disabled:opacity-40">›</button></div></div>
          </div></>}
        </SectionCard>
        <aside className="space-y-4"><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-slate-950">Controllo partenze</h2><div className="mt-4 divide-y divide-slate-100">{[["Senza autista",unassignedCount,"bg-orange-100 text-orange-700"],["Senza veicolo",unassignedCount,"bg-indigo-100 text-indigo-700"],["Dati da verificare",reviewCount,"bg-amber-100 text-amber-700"],["Ritardi segnalati",0,"bg-rose-100 text-rose-700"]].map(([label,value,tone])=><div key={String(label)} className="flex items-center justify-between py-4 text-sm font-medium"><span>{label}</span><strong className={`rounded-lg px-2.5 py-1 ${tone}`}>{value}</strong></div>)}</div><a href="/control-room" className="btn-secondary mt-4 block w-full py-3 text-center">Apri Control Room</a></div><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-extrabold text-slate-950">Prossime partenze</h2><div className="mt-3 divide-y divide-slate-100">{departures.slice(0,4).map((item)=><div key={`next-${item.instanceId}`} className="grid grid-cols-[48px_1fr_auto] gap-2 py-4 text-xs"><strong className="text-indigo-700">{getDeparturePickupTime(item)}</strong><div><p className="font-bold text-slate-800">{resolveHotelName(item.service)}</p><p className="mt-1 text-slate-500">{getDepartureDestinationLabel(item.service)}</p></div><span>{item.service.pax} pax</span></div>)}</div></div></aside>
      </div>

      <div className="hidden">
      <PageHeader
        title="Partenze"
        subtitle="Vista dedicata alle partenze operative della giornata selezionata."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Partenze" }]}
        actions={
          <div className="grid w-full gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <label className="text-sm">
              Data
              <DateInput value={selectedDate} onChange={(iso) => setSelectedDate(iso)} className="input-saas mt-1 w-full" />
            </label>
            <label className="text-sm">
              Agenzia
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas mt-1 w-full">
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
                className="input-saas mt-1 w-full"
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
          <>
          <div className="space-y-2 md:hidden">
            {departures.map((item) => {
              const hotelName = resolveHotelName(item.service);
              const meetingPoint = getDepartureDestinationLabel(item.service);
              const riferimento = getDepartureTransportLabel(item.service);
              const pickupTime = getDeparturePickupTime(item);
              const tipoLabel = item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D";
              const hint = pickupHints.get(item.service.id);
              return (
                <article key={`mobile-${item.instanceId}`} className={`rounded-2xl border border-slate-200 bg-white p-3 shadow-sm ${selectedDepIds.has(item.service.id) ? "ring-2 ring-indigo-100" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold uppercase text-slate-800">{getCustomerFullName(item.service)}</p>
                      <p className="mt-1 text-xs text-slate-500">{hotelName}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                        checked={selectedDepIds.has(item.service.id)}
                        onChange={() => toggleDepSelect(item.service.id)}
                      />
                      <span className="inline-flex min-w-[56px] items-center justify-center rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm font-bold text-slate-800">
                        {pickupTime}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
                    <p>Pax: <span className="font-semibold text-slate-800">{item.service.pax}</span></p>
                    <p>Tipo: {tipoLabel}</p>
                  </div>
                  {hint && (
                    <p className="mt-2 text-xs font-medium text-amber-600">
                      Pickup suggerito: {hint.pickup} · {hint.label}
                    </p>
                  )}
                  {meetingPoint ? <p className="mt-2 text-xs uppercase text-slate-400">{meetingPoint}</p> : null}
                  {riferimento ? <p className="mt-1 text-xs text-slate-500">{riferimento}</p> : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => setQrServiceId(item.service.id)} className="btn-secondary px-3 py-1.5 text-xs">QR</button>
                    <button type="button" onClick={() => setEditingService(item.service)} className="btn-secondary px-3 py-1.5 text-xs">Modifica</button>
                    <button type="button" onClick={() => openCancelModal(item.service)} className="btn-secondary border-rose-200 bg-rose-50 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-100">Cancella</button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="table-card-scroll hidden md:block">
          <div className="min-w-[760px] rounded-2xl border border-slate-200 bg-white shadow-sm">
            {/* Header */}
            <div className="grid items-center gap-3 border-b border-slate-100 bg-slate-50/90 px-4 py-2.5 text-[11px] uppercase tracking-wide text-slate-500 grid-cols-[28px_60px_minmax(160px,1.45fr)_40px_minmax(160px,1.15fr)_minmax(0,150px)_148px]">
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
                const meetingPoint = getDepartureDestinationLabel(item.service);
                const riferimento = getDepartureTransportLabel(item.service);
                const pickupTime = getDeparturePickupTime(item);
                const tipoLabel = item.service.service_type_code ?? item.service.booking_service_kind ?? item.service.service_type ?? "N/D";
                const hint = pickupHints.get(item.service.id);
                return (
                  <div
                    key={item.instanceId}
                    className={`grid items-center gap-3 px-4 py-3 transition hover:bg-slate-50/60 grid-cols-[28px_60px_minmax(160px,1.45fr)_40px_minmax(160px,1.15fr)_minmax(0,150px)_148px] ${selectedDepIds.has(item.service.id) ? "bg-indigo-50/60" : ""}`}
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
                        {pickupTime}
                      </span>
                      {hint && hint.pickup !== pickupTime && (
                        <p className="text-[10px] font-semibold text-amber-600 cursor-help" title={`Regole: ${hint.pickup} · ${hint.label}`}>
                          ⏰ {hint.pickup}
                        </p>
                      )}
                      {hint && hint.pickup === pickupTime && (
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
                          <span className="truncate text-[11px] text-slate-400" title={item.service.billing_party_name}>{item.service.billing_party_name.toUpperCase()}</span>
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
                      <span className="inline-flex max-w-full rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-blue-700">
                        <span className="block truncate" title={tipoLabel}>{tipoLabel}</span>
                      </span>
                    </div>
                    {/* AZIONI */}
                    <div className="flex shrink-0 justify-end gap-1">
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
          </div>
          </>
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
              className="input-saas w-full sm:min-w-44 sm:w-auto"
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
      </div>

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
        <div className="modal-overlay" onClick={() => setQrServiceId(null)}>
          <div className="modal-card modal-card-sm text-center space-y-4" onClick={(e) => e.stopPropagation()}>
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
        <div className="modal-overlay" onClick={() => { if (!cancelSubmitting) setCancelModal(null); }}>
          <div className="modal-card modal-card-sm space-y-4" onClick={(e) => e.stopPropagation()}>
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
                <div className="modal-actions">
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
                <div className="modal-actions pt-1">
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
        <div className="modal-overlay" onClick={() => setAddModal(false)}>
          <div className="modal-card modal-card-md space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800">Aggiungi partenza</h2>
              <button type="button" onClick={() => setAddModal(false)} className="text-slate-400 hover:text-slate-600 text-xl leading-none">×</button>
            </div>
            {addError && <p className="text-sm text-rose-600">{addError}</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="col-span-2 text-xs text-slate-600 font-medium">
                Cliente*
                <input className="input-saas mt-1" value={addForm.customer_name} onChange={(e) => setAddForm((f) => ({ ...f, customer_name: e.target.value }))} placeholder="Nome e cognome" />
              </label>
              <label className="text-xs text-slate-600 font-medium">
                Data*
                <DateInput className="input-saas mt-1" value={addForm.date} onChange={(iso) => setAddForm((f) => ({ ...f, date: iso }))} />
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
                  <div className="grid gap-2 sm:grid-cols-2">
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

            <div className="modal-actions pt-1">
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
