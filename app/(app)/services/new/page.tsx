"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { AgencyBookingServiceKind, Hotel, OperationalServiceType, ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";
import { detectFerryPort, ferryTimes } from "@/lib/ferry-schedule";
import { getPickupRule } from "@/lib/departure-pickup-rules";
import { getBusLinePickup, getBusLinePickupByZone } from "@/lib/bus-line-pickup-rules";
import type { BusLine } from "@/lib/bus-line-pickup-rules";

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
  const [direction, setDirection] = useState<"arrival" | "departure">("arrival");
  const [arrivalTime, setArrivalTime] = useState("14:30");
  const [departureTime, setDepartureTime] = useState("");
  const [message, setMessage] = useState("Inserisci i dati e conferma.");
  const [isLoading, setIsLoading] = useState(true);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [actorUserId, setActorUserId] = useState<string | null>(null);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [selectedHotelId, setSelectedHotelId] = useState("");
  const [billingParty, setBillingParty] = useState("");
  const [transportKind, setTransportKind] = useState<"traghetto" | "aliscafo">("traghetto");
  const [busLine, setBusLine] = useState<BusLine>("italia");
  const [timeValue, setTimeValue] = useState("14:30");
  const [arrivalDate, setArrivalDate] = useState(new Date().toISOString().slice(0, 10));

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

      const hotelList = (hotelsRows ?? []) as Hotel[];
      setHotels(hotelList);
      if (hotelList.length > 0) setSelectedHotelId((prev) => prev || hotelList[0].id);
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

  type PickupSuggestion = { pickup: string; boat_co: string; boat_t: string; porto_p: string; porto_a: string; exc?: string; notes?: string };

  const pickupSuggestion = useMemo((): PickupSuggestion | null => {
    if (direction !== "departure") return null;
    const hotel = hotels.find((h) => h.id === selectedHotelId);
    const zona = hotel?.zone?.toLowerCase() ?? "";
    if (!zona) return null;

    if (presetKey === "linea_bus") {
      const res = hotel?.name ? getBusLinePickup(hotel.name, busLine) : null;
      const final = res ?? getBusLinePickupByZone(zona, busLine);
      if (!final) return null;
      return { pickup: final.pickup, boat_co: "MEDMAR", boat_t: final.nave_time, porto_p: final.porto, porto_a: final.porto };
    }

    const tFrom = departureTime?.trim() ?? "";
    if (!tFrom) return null;

    if (presetKey === "formula_snav") {
      return getPickupRule(billingParty, "snav", tFrom, zona);
    }
    if (presetKey === "formula_medmar") {
      return getPickupRule(billingParty, "medmar", tFrom, zona);
    }
    if (presetKey === "transfer_station") {
      return getPickupRule(billingParty, `treno_${transportKind}`, tFrom, zona)
        ?? getPickupRule("", `treno_${transportKind}`, tFrom, zona);
    }
    if (presetKey === "transfer_airport") {
      return getPickupRule(billingParty, `volo_${transportKind}`, tFrom, zona)
        ?? getPickupRule("", `volo_${transportKind}`, tFrom, zona);
    }
    return null;
  }, [direction, presetKey, selectedHotelId, hotels, departureTime, billingParty, transportKind, busLine]);

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
      low_seat_threshold: formData.get("low_seat_threshold") ? Number(formData.get("low_seat_threshold")) : null,
      minimum_passengers: formData.get("minimum_passengers") ? Number(formData.get("minimum_passengers")) : null,
      waitlist_enabled: formData.get("waitlist_enabled") === "on",
      waitlist_count: formData.get("waitlist_count") ? Number(formData.get("waitlist_count")) : 0,
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
          <input name="time" type="time" value={timeValue} onChange={(e) => setTimeValue(e.target.value)} className="input-saas mt-1" required />
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
          <select name="direction" value={direction} onChange={(e) => setDirection(e.target.value as "arrival" | "departure")} className="input-saas mt-1">
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
          <select name="hotel_id" value={selectedHotelId} onChange={(e) => setSelectedHotelId(e.target.value)} className="input-saas mt-1" required>
            {filteredHotels.map((hotel) => (
              <option key={hotel.id} value={hotel.id}>
                {hotel.name} - {hotel.zone}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Agenzia di fatturazione
          <input name="billing_party_name" value={billingParty} onChange={(e) => setBillingParty(e.target.value)} className="input-saas mt-1" placeholder="Privato / nome agenzia" />
        </label>
        <label className="text-sm">
          Meeting point
          <input key={`meeting-${presetKey}`} name="meeting_point" defaultValue={selectedPreset.meetingPoint} className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Data andata operativa
          <input name="arrival_date" type="date" value={arrivalDate} onChange={(e) => setArrivalDate(e.target.value)} className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Ora andata operativa
          {(presetKey === "formula_snav" || presetKey === "formula_medmar") ? (
            <select name="arrival_time" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="input-saas mt-1">
              <option value="">— Seleziona orario —</option>
              {ferryTimes(presetKey as "formula_snav" | "formula_medmar", "arrival").map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <input name="arrival_time" type="time" value={arrivalTime} onChange={(e) => setArrivalTime(e.target.value)} className="input-saas mt-1" />
          )}
        </label>
        <label className="text-sm">
          Data ritorno
          <input name="departure_date" type="date" min={arrivalDate} className="input-saas mt-1" />
        </label>
        <label className="text-sm">
          Ora ritorno
          {(presetKey === "formula_snav" || presetKey === "formula_medmar") ? (
            <select name="departure_time" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} className="input-saas mt-1">
              <option value="">— Seleziona orario —</option>
              {ferryTimes(presetKey as "formula_snav" | "formula_medmar", "departure").map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <input name="departure_time" type="time" value={departureTime} onChange={(e) => setDepartureTime(e.target.value)} className="input-saas mt-1" />
          )}
        </label>
        {/* Porto automatico SNAV/MEDMAR */}
        {(presetKey === "formula_snav" || presetKey === "formula_medmar") && (() => {
          const porto = detectFerryPort(
            presetKey as "formula_snav" | "formula_medmar",
            direction,
            direction === "arrival" ? arrivalTime : departureTime,
          );
          return (
            <div className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm md:col-span-2">
              <span className="font-semibold text-blue-800">Porto rilevato: </span>
              {porto
                ? <span className="font-bold text-blue-900">{porto}</span>
                : <span className="text-blue-600 italic">seleziona orario per rilevare il porto</span>}
              {presetKey === "formula_snav" && (
                <span className="ml-2 text-xs text-blue-500">(SNAV: sempre Casamicciola)</span>
              )}
            </div>
          );
        })()}
        {/* Selettore tipo imbarco per stazione/aeroporto in uscita */}
        {direction === "departure" && (presetKey === "transfer_station" || presetKey === "transfer_airport") && (
          <label className="text-sm md:col-span-2">
            Tipo imbarco (per calcolo pickup)
            <select value={transportKind} onChange={(e) => setTransportKind(e.target.value as "traghetto" | "aliscafo")} className="input-saas mt-1">
              <option value="traghetto">Traghetto (MEDMAR)</option>
              <option value="aliscafo">Aliscafo (Caremar/NLG)</option>
            </select>
          </label>
        )}

        {/* Selettore linea bus in uscita */}
        {direction === "departure" && presetKey === "linea_bus" && (
          <label className="text-sm md:col-span-2">
            Linea bus (per calcolo pickup)
            <select value={busLine} onChange={(e) => setBusLine(e.target.value as BusLine)} className="input-saas mt-1">
              <option value="italia">Linea Italia — Porto Casamicciola 06:20</option>
              <option value="centro">Linea Centro — Porto Ischia 11:10</option>
              <option value="adriatica">Linea Adriatica — Porto Ischia 11:10</option>
            </select>
          </label>
        )}

        {/* Banner calcolo orario prelevamento */}
        {direction === "departure" && pickupSuggestion && (
          <div className="flex flex-col gap-1.5 rounded-xl border border-teal-200 bg-teal-50 px-3 py-2.5 md:col-span-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <span className="text-xs font-semibold text-teal-800">Orario prelevamento suggerito: </span>
                <span className="text-sm font-bold text-teal-900">{pickupSuggestion.pickup}</span>
                <span className="ml-2 text-xs text-teal-600">
                  {pickupSuggestion.boat_co} {pickupSuggestion.boat_t} · {pickupSuggestion.porto_p}
                  {pickupSuggestion.porto_a && pickupSuggestion.porto_a !== pickupSuggestion.porto_p
                    ? ` → ${pickupSuggestion.porto_a}` : ""}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setTimeValue(pickupSuggestion.pickup)}
                className="shrink-0 rounded-lg border border-teal-300 bg-white px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 transition"
              >
                Usa questo orario
              </button>
            </div>
            {pickupSuggestion.exc && (
              <p className="text-xs text-teal-600 italic">Stagionalità: {pickupSuggestion.exc}</p>
            )}
            {pickupSuggestion.notes && (
              <p className="text-xs text-teal-600">Note punti carico: {pickupSuggestion.notes}</p>
            )}
          </div>
        )}

        {/* Campo riferimento mezzo: visibile solo per volo/treno/bus */}
        {(presetKey === "transfer_airport" || presetKey === "transfer_station" || presetKey === "linea_bus") && (
          <label className="text-sm">
            {presetKey === "transfer_airport" ? "Numero volo" : presetKey === "transfer_station" ? "Numero treno" : "Linea / mezzo bus"}
            <input
              name="transport_code"
              className="input-saas mt-1"
              placeholder={presetKey === "transfer_airport" ? "es. FR1234" : presetKey === "transfer_station" ? "es. ICN 1234" : "es. FlixBus 123"}
              required
            />
          </label>
        )}
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
        {serviceType === "bus_tour" || selectedPreset.key === "linea_bus" ? (
          <>
            <label className="text-sm md:col-span-2">
              {selectedPreset.key === "linea_bus" ? "Nome linea / lotto bus" : "Nome tour"}
              <input name="tour_name" className="input-saas mt-1" required />
            </label>
            <label className="text-sm">
              Capacita
              <input name="capacity" type="number" min={1} max={120} defaultValue={18} className="input-saas mt-1" required />
            </label>
            <label className="text-sm">
              Soglia pochi posti
              <input name="low_seat_threshold" type="number" min={0} max={120} defaultValue={4} className="input-saas mt-1" />
            </label>
            <label className="text-sm">
              Minimo passeggeri
              <input name="minimum_passengers" type="number" min={1} max={120} defaultValue={10} className="input-saas mt-1" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input name="waitlist_enabled" type="checkbox" defaultChecked />
              Abilita waiting list
            </label>
            <label className="text-sm">
              Pax in waiting list
              <input name="waitlist_count" type="number" min={0} max={500} defaultValue={0} className="input-saas mt-1" />
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
