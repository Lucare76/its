"use client";

import { useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard, StatCard } from "@/components/ui";
import { buildOperationalInstances } from "@/lib/operational-service-instances";
import { formatIsoDateShort, getCustomerFullName, getTransportReferenceOutward } from "@/lib/service-display";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { supabase } from "@/lib/supabase/client";
import type { Service, Hotel } from "@/lib/types";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!supabase) return;
    setSaving(true);
    setError(null);
    const { error: err } = await supabase
      .from("services")
      .update({
        hotel_id: hotelId,
        customer_name: customerName,
        pax: Number(pax) || 1,
        time,
        phone,
        notes,
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
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Hotel
            <select value={hotelId} onChange={(e) => setHotelId(e.target.value)} className="mt-1 input-saas w-full">
              {hotels.map((h) => (
                <option key={h.id} value={h.id}>{h.name}</option>
              ))}
            </select>
          </label>
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
            <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" className="mt-1 input-saas w-full" />
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

// ─── Pagina ──────────────────────────────────────────────────────────────────

export default function ArrivalsPage() {
  const { loading, errorMessage, data, refresh } = useTenantOperationalData();
  const todayIso = new Date().toISOString().slice(0, 10);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [agencyFilter, setAgencyFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const hotelsById = useMemo(() => new Map(data.hotels.map((hotel) => [hotel.id, hotel])), [data.hotels]);
  const tenantId = data.services[0]?.tenant_id ?? "";

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

  const deleteService = async (service: Service) => {
    if (!supabase || !tenantId) return;
    if (!confirm(`Eliminare il servizio di ${service.customer_name}? L'operazione non è reversibile.`)) return;
    await supabase.from("services").delete().eq("id", service.id).eq("tenant_id", tenantId);
    void refresh?.();
  };

  const arrivals = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buildOperationalInstances(data.services)
      .filter((instance) =>
        instance.direction === "arrival" &&
        instance.date === selectedDate &&
        (agencyFilter === "all" || instance.service.billing_party_name?.trim().toLowerCase() === agencyFilter.toLowerCase()) &&
        (!q || (instance.service.customer_name ?? "").toLowerCase().includes(q) || (instance.service.phone ?? "").toLowerCase().includes(q))
      )
      .sort((left, right) => left.time.localeCompare(right.time));
  }, [data.services, selectedDate, agencyFilter, search]);

  const totalPax = arrivals.reduce((sum, item) => sum + item.service.pax, 0);
  const busCount = arrivals.filter(
    (item) => item.service.service_type_code === "bus_line" || item.service.booking_service_kind === "bus_city_hotel"
  ).length;
  const privateTransfers = Math.max(arrivals.length - busCount, 0);

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
              <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="input-saas mt-1 min-w-40" />
            </label>
            <label className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-400">Agenzia</span>
              <select value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)} className="input-saas mt-1 min-w-44">
                {agencyNames.map((name) => (
                  <option key={name} value={name}>{name === "all" ? "Tutte le agenzie" : name}</option>
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
              <span>{agencyFilter === "all" ? "Tutte le agenzie" : agencyFilter}</span>
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
          </div>
        }
      >
        {arrivals.length === 0 ? (
          <p className="text-sm text-muted">Nessun arrivo operativo per la data selezionata.</p>
        ) : (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="grid grid-cols-[80px_1.6fr_64px_1fr_1fr_1fr_140px_136px] gap-4 border-b border-slate-100 bg-slate-50/90 px-4 py-3 text-[11px] uppercase tracking-wide text-slate-500">
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
                  className="grid grid-cols-[80px_1.6fr_64px_1fr_1fr_1fr_140px_136px] gap-4 px-4 py-4 transition hover:bg-slate-50/80"
                >
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
                  </div>
                  <div>
                    <span className="inline-flex min-w-[40px] items-center justify-center rounded-full border border-slate-200 bg-white px-2 py-1 text-sm font-semibold text-slate-700">
                      {item.service.pax}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-medium uppercase text-slate-700">{hotelsById.get(item.service.hotel_id)?.name ?? item.service.meeting_point ?? "N/D"}</p>
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
                      className="whitespace-nowrap rounded-xl border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-100"
                    >
                      Elimina
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
    </section>
  );
}
