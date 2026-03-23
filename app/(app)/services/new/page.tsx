"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { AgencyBookingServiceKind, Hotel, OperationalServiceType, ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";

const vessels = ["Nave Medmar", "Aliscafo Caremar", "NLG Jet"];

type ManualPresetKey = "generic_transfer" | "formula_snav" | "formula_medmar" | "transfer_airport" | "transfer_station" | "linea_bus";

const manualPresets: Array<{
  key: ManualPresetKey;
  label: string;
  description: string;
  serviceType: ServiceType;
  bookingKind: AgencyBookingServiceKind | null;
  serviceTypeCode: OperationalServiceType | null;
  vessel: string;
  meetingPoint: string;
}> = [
  {
    key: "generic_transfer",
    label: "Transfer generico",
    description: "Inserimento manuale base senza formula dedicata.",
    serviceType: "transfer",
    bookingKind: null,
    serviceTypeCode: null,
    vessel: "Transfer Ischia",
    meetingPoint: ""
  },
  {
    key: "formula_snav",
    label: "Formula SNAV",
    description: "Transfer porto/hotel associato a SNAV.",
    serviceType: "transfer",
    bookingKind: "transfer_port_hotel",
    serviceTypeCode: "transfer_port_hotel",
    vessel: "SNAV",
    meetingPoint: "Porto Napoli"
  },
  {
    key: "formula_medmar",
    label: "Formula MEDMAR",
    description: "Transfer porto/hotel associato a Medmar.",
    serviceType: "transfer",
    bookingKind: "transfer_port_hotel",
    serviceTypeCode: "transfer_port_hotel",
    vessel: "MEDMAR",
    meetingPoint: "Porto Pozzuoli"
  },
  {
    key: "transfer_airport",
    label: "Transfer aeroporto",
    description: "Airport -> hotel o hotel -> airport.",
    serviceType: "transfer",
    bookingKind: "transfer_airport_hotel",
    serviceTypeCode: "transfer_airport_hotel",
    vessel: "Aeroporto Napoli",
    meetingPoint: "Aeroporto"
  },
  {
    key: "transfer_station",
    label: "Transfer stazione",
    description: "Stazione -> hotel o hotel -> stazione.",
    serviceType: "transfer",
    bookingKind: "transfer_train_hotel",
    serviceTypeCode: "transfer_station_hotel",
    vessel: "Stazione Napoli",
    meetingPoint: "Stazione"
  },
  {
    key: "linea_bus",
    label: "Linea bus",
    description: "Linea bus/citta-hotel con origine e tratta operativa.",
    serviceType: "transfer",
    bookingKind: "bus_city_hotel",
    serviceTypeCode: "bus_line",
    vessel: "Linea bus",
    meetingPoint: "Meeting point linea bus"
  }
];

export default function NewServicePage() {
  const [query, setQuery] = useState("");
  const [presetKey, setPresetKey] = useState<ManualPresetKey>("generic_transfer");
  const selectedPreset = manualPresets.find((item) => item.key === presetKey) ?? manualPresets[0];
  const [serviceType, setServiceType] = useState<ServiceType>(selectedPreset.serviceType);
  const [message, setMessage] = useState("Inserisci i dati e conferma.");
  const [isLoading, setIsLoading] = useState(true);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [hotels, setHotels] = useState<Hotel[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;

      setActorUserId(session.userId);
      setTenantId(session.tenantId);
      if (!session.userId || !session.tenantId || !hasSupabaseEnv || !supabase) {
        setMessage("Sessione non valida. Rifai login.");
        setIsLoading(false);
        return;
      }

      const { data: hotelsRows, error: hotelsError } = await supabase
        .from("hotels")
        .select("*")
        .eq("tenant_id", session.tenantId)
        .order("name", { ascending: true });

      if (!active) return;
      if (hotelsError) {
        setMessage("Errore caricamento hotel.");
        setIsLoading(false);
        return;
      }

      setHotels((hotelsRows ?? []) as Hotel[]);
      setIsLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredHotels = useMemo(() => {
    if (!query.trim()) return hotels.slice(0, 60);
    return hotels.filter((hotel) => hotel.name.toLowerCase().includes(query.toLowerCase()));
  }, [hotels, query]);

  const submit = async (formData: FormData) => {
    const rawStops = String(formData.get("stops") ?? "");
    const parsedStops = rawStops
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);

    const payload = {
      date: String(formData.get("date")),
      time: String(formData.get("time")),
      service_type: String(formData.get("service_type") ?? "transfer"),
      direction: String(formData.get("direction")),
      vessel: String(formData.get("vessel")),
      pax: Number(formData.get("pax")),
      hotel_id: String(formData.get("hotel_id")),
      customer_name: String(formData.get("customer_name")),
      phone: String(formData.get("phone")),
      notes: String(formData.get("notes") ?? ""),
      tour_name: String(formData.get("tour_name") ?? ""),
      capacity: formData.get("capacity") ? Number(formData.get("capacity")) : null,
      meeting_point: String(formData.get("meeting_point") ?? ""),
      stops: parsedStops.length > 0 ? parsedStops : [],
      bus_plate: String(formData.get("bus_plate") ?? ""),
      billing_party_name: String(formData.get("billing_party_name") ?? ""),
      customer_email: String(formData.get("customer_email") ?? ""),
      booking_service_kind: String(formData.get("booking_service_kind") ?? ""),
      service_type_code: String(formData.get("service_type_code") ?? ""),
      arrival_date: String(formData.get("arrival_date") ?? ""),
      arrival_time: String(formData.get("arrival_time") ?? ""),
      departure_date: String(formData.get("departure_date") ?? ""),
      departure_time: String(formData.get("departure_time") ?? ""),
      transport_code: String(formData.get("transport_code") ?? ""),
      bus_city_origin: String(formData.get("bus_city_origin") ?? ""),
      status: "new"
    };

    const parsed = serviceCreateSchema.safeParse(payload);
    if (!parsed.success) {
      setMessage(parsed.error.errors[0]?.message ?? "Dati non validi.");
      return;
    }

    if (!tenantId || !actorUserId || !supabase) {
      setMessage("Tenant non disponibile.");
      return;
    }

    const { data: insertedService, error: serviceError } = await supabase
      .from("services")
      .insert({
        ...parsed.data,
        tenant_id: tenantId,
        created_by_user_id: actorUserId,
        is_draft: false,
        billing_party_name: parsed.data.billing_party_name || null,
        customer_email: parsed.data.customer_email || null,
        booking_service_kind: parsed.data.booking_service_kind || null,
        service_type_code: parsed.data.service_type_code || null,
        arrival_date: parsed.data.arrival_date || parsed.data.date,
        arrival_time: parsed.data.arrival_time || parsed.data.time,
        departure_date: parsed.data.departure_date || null,
        departure_time: parsed.data.departure_time || null,
        transport_code: parsed.data.transport_code || null,
        bus_city_origin: parsed.data.bus_city_origin || null
      })
      .select("id")
      .single();

    if (serviceError || !insertedService?.id) {
      setMessage(serviceError?.message ?? "Creazione prenotazione non riuscita.");
      return;
    }

    await supabase.from("status_events").insert({
      tenant_id: tenantId,
      service_id: insertedService.id,
      status: "new",
      by_user_id: actorUserId
    });

    setMessage("Prenotazione creata. Stato iniziale: Da assegnare.");
  };

  if (isLoading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento form...</div>;
  }

  if (filteredHotels.length === 0) {
    return (
      <section className="mx-auto max-w-4xl page-section">
        <h1 className="section-title">Nuova Prenotazione</h1>
        <p className="section-subtitle">Nessun hotel disponibile per il tenant corrente.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/onboarding" className="btn-primary px-3 py-1.5 text-xs">
            Vai a onboarding
          </Link>
          <Link href="/hotels" className="btn-secondary px-3 py-1.5 text-xs">
            Apri hotel
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl page-section">
      <div className="section-head">
        <h1 className="section-title">Nuova Prenotazione</h1>
      </div>
      <form action={(formData) => void submit(formData)} className="card grid gap-3 p-4 md:grid-cols-2 md:p-5">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3 md:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">Preset operativo</p>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            {manualPresets.map((preset) => (
              <button
                key={preset.key}
                type="button"
                onClick={() => {
                  setPresetKey(preset.key);
                  setServiceType(preset.serviceType);
                }}
                className={presetKey === preset.key ? "rounded-xl border border-primary bg-white p-3 text-left shadow-sm" : "rounded-xl border border-slate-200 bg-white p-3 text-left"}
              >
                <p className="text-sm font-semibold text-slate-900">{preset.label}</p>
                <p className="mt-1 text-xs text-muted">{preset.description}</p>
              </button>
            ))}
          </div>
        </div>
        <label className="text-sm">
          Data
          <input name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="input-saas mt-1" required />
        </label>
        <label className="text-sm">
          Ora
          <input name="time" type="time" defaultValue="14:30" className="input-saas mt-1" required />
        </label>
        <label className="text-sm">
          Tipo servizio
          <select
            name="service_type"
            value={serviceType}
            onChange={(event) => setServiceType(event.target.value as ServiceType)}
            className="input-saas mt-1"
          >
            <option value="transfer">transfer</option>
            <option value="bus_tour">bus_tour</option>
          </select>
        </label>
        <label className="text-sm">
          Direzione
          <select name="direction" className="input-saas mt-1">
            <option value="arrival">arrival</option>
            <option value="departure">departure</option>
          </select>
        </label>
        <input type="hidden" name="booking_service_kind" value={selectedPreset.bookingKind ?? ""} />
        <input type="hidden" name="service_type_code" value={selectedPreset.serviceTypeCode ?? ""} />
        <label className="text-sm">
          Mezzo / riferimento
          <select key={`vessel-${presetKey}`} name="vessel" className="input-saas mt-1" defaultValue={selectedPreset.vessel}>
            {vessels.map((vessel) => (
              <option key={vessel} value={vessel}>
                {vessel}
              </option>
            ))}
            <option value={selectedPreset.vessel}>{selectedPreset.vessel}</option>
            <option value="Transfer Ischia">Transfer Ischia</option>
            <option value="SNAV">SNAV</option>
            <option value="MEDMAR">MEDMAR</option>
            <option value="Aeroporto Napoli">Aeroporto Napoli</option>
            <option value="Stazione Napoli">Stazione Napoli</option>
            <option value="Linea bus">Linea bus</option>
          </select>
        </label>
        <label className="text-sm">
          Cliente
          <input name="customer_name" className="input-saas mt-1" required />
        </label>
        <label className="text-sm">
          Telefono
          <input name="phone" className="input-saas mt-1" required />
        </label>
        <label className="text-sm">
          Email cliente
          <input name="customer_email" type="email" className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Passeggeri
          <input name="pax" type="number" min={1} max={16} defaultValue={2} className="input-saas mt-1" required />
        </label>
        <label className="text-sm">
          Cerca hotel
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Autocomplete hotel"
            className="input-saas mt-1"
          />
        </label>
        <label className="text-sm md:col-span-2">
          Hotel
          <select name="hotel_id" className="input-saas mt-1" required>
            {filteredHotels.map((hotel) => (
              <option key={hotel.id} value={hotel.id}>
                {hotel.name} - {hotel.zone}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Agenzia di fatturazione
          <input name="billing_party_name" defaultValue="" className="input-saas mt-1" placeholder="Privato / nome agenzia" />
        </label>
        <label className="text-sm">
          Meeting point
          <input key={`meeting-${presetKey}`} name="meeting_point" defaultValue={selectedPreset.meetingPoint} className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Data andata operativa
          <input name="arrival_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Ora andata operativa
          <input name="arrival_time" type="time" defaultValue="14:30" className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Data ritorno
          <input name="departure_date" type="date" className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Ora ritorno
          <input name="departure_time" type="time" className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Riferimento mezzo
          <input
            name="transport_code"
            className="input-saas mt-1"
            placeholder={
              selectedPreset.key === "transfer_airport"
                ? "Numero volo"
                : selectedPreset.key === "transfer_station"
                  ? "Numero treno"
                  : selectedPreset.key === "linea_bus"
                    ? "Linea / mezzo bus"
                    : "Riferimento corsa"
            }
          />
        </label>
        {selectedPreset.key === "linea_bus" ? (
          <label className="text-sm">
            Origine linea bus
            <input name="bus_city_origin" className="input-saas mt-1" placeholder="Citta di partenza" />
          </label>
        ) : (
          <label className="text-sm">
            Targa / mezzo interno
            <input name="bus_plate" className="input-saas mt-1" />
          </label>
        )}
        {serviceType === "bus_tour" ? (
          <>
            <label className="text-sm md:col-span-2">
              Nome tour
              <input name="tour_name" className="input-saas mt-1" required />
            </label>
            <label className="text-sm">
              Capacita
              <input name="capacity" type="number" min={1} max={120} defaultValue={18} className="input-saas mt-1" required />
            </label>
            <label className="text-sm md:col-span-2">
              Stops (una riga per fermata, o separate da virgola)
              <textarea name="stops" rows={3} className="input-saas mt-1 min-h-[96px]" />
            </label>
          </>
        ) : null}
        <label className="text-sm md:col-span-2">
          Note
          <textarea name="notes" rows={3} className="input-saas mt-1 min-h-[96px]" />
        </label>
        <button type="submit" className="btn-primary md:col-span-2">
          Conferma prenotazione
        </button>
      </form>
      <p className="section-subtitle">{message}</p>
    </section>
  );
}
