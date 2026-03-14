"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { Hotel, ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";

const vessels = ["Nave Medmar", "Aliscafo Caremar", "NLG Jet"];

export default function NewServicePage() {
  const [query, setQuery] = useState("");
  const [serviceType, setServiceType] = useState<ServiceType>("transfer");
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
        is_draft: false
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
        <label className="text-sm">
          Nave
          <select name="vessel" className="input-saas mt-1">
            {vessels.map((vessel) => (
              <option key={vessel} value={vessel}>
                {vessel}
              </option>
            ))}
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
            <label className="text-sm">
              Meeting point
              <input name="meeting_point" className="input-saas mt-1" required />
            </label>
            <label className="text-sm md:col-span-2">
              Stops (una riga per fermata, o separate da virgola)
              <textarea name="stops" rows={3} className="input-saas mt-1 min-h-[96px]" />
            </label>
            <label className="text-sm md:col-span-2">
              Targa bus (opzionale)
              <input name="bus_plate" className="input-saas mt-1" />
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
