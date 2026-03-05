"use client";

import { useMemo, useState } from "react";
import { useDemoStore } from "@/lib/use-demo-store";
import type { ServiceType } from "@/lib/types";
import { serviceCreateSchema } from "@/lib/validation";

const vessels = ["Nave Medmar", "Aliscafo Caremar", "NLG Jet"];

export default function NewServicePage() {
  const { state, loading, createService } = useDemoStore();
  const [query, setQuery] = useState("");
  const [serviceType, setServiceType] = useState<ServiceType>("transfer");
  const [message, setMessage] = useState("Inserisci i dati e conferma.");

  const filteredHotels = useMemo(() => {
    if (!query.trim()) return state.hotels.slice(0, 12);
    return state.hotels.filter((hotel) => hotel.name.toLowerCase().includes(query.toLowerCase()));
  }, [query, state.hotels]);

  if (loading) {
    return <div className="card p-4 text-sm text-slate-500">Caricamento form...</div>;
  }

  const submit = (formData: FormData) => {
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
    createService(parsed.data);
    setMessage("Prenotazione creata. Stato iniziale: Da assegnare.");
  };

  return (
    <section className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Nuova Prenotazione</h1>
      <form action={submit} className="card grid gap-3 p-4 md:grid-cols-2">
        <label className="text-sm">
          Data
          <input
            name="date"
            defaultValue="2026-03-02"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            required
          />
        </label>
        <label className="text-sm">
          Ora
          <input
            name="time"
            defaultValue="14:30"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            required
          />
        </label>
        <label className="text-sm">
          Tipo servizio
          <select
            name="service_type"
            value={serviceType}
            onChange={(event) => setServiceType(event.target.value as ServiceType)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="transfer">transfer</option>
            <option value="bus_tour">bus_tour</option>
          </select>
        </label>
        <label className="text-sm">
          Direzione
          <select name="direction" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            <option value="arrival">arrival</option>
            <option value="departure">departure</option>
          </select>
        </label>
        <label className="text-sm">
          Nave
          <select name="vessel" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2">
            {vessels.map((vessel) => (
              <option key={vessel} value={vessel}>
                {vessel}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Cliente
          <input name="customer_name" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required />
        </label>
        <label className="text-sm">
          Telefono
          <input name="phone" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required />
        </label>
        <label className="text-sm">
          Passeggeri
          <input
            name="pax"
            type="number"
            min={1}
            max={16}
            defaultValue={2}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            required
          />
        </label>
        <label className="text-sm">
          Cerca hotel
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Autocomplete hotel"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <label className="text-sm md:col-span-2">
          Hotel
          <select name="hotel_id" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required>
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
              <input name="tour_name" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required />
            </label>
            <label className="text-sm">
              Capacita
              <input
                name="capacity"
                type="number"
                min={1}
                max={120}
                defaultValue={18}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
                required
              />
            </label>
            <label className="text-sm">
              Meeting point
              <input name="meeting_point" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" required />
            </label>
            <label className="text-sm md:col-span-2">
              Stops (una riga per fermata, o separate da virgola)
              <textarea name="stops" rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="text-sm md:col-span-2">
              Targa bus (opzionale)
              <input name="bus_plate" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </>
        ) : null}
        <label className="text-sm md:col-span-2">
          Note
          <textarea name="notes" rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <button type="submit" className="rounded-lg bg-brand-600 px-4 py-2 text-white md:col-span-2">
          Conferma prenotazione
        </button>
      </form>
      <p className="text-sm text-slate-600">{message}</p>
    </section>
  );
}
