"use client";

import { useCallback, useEffect, useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Vehicle = { id: string; label: string; plate: string | null; consumption_min_l_per_100km: number | null; consumption_max_l_per_100km: number | null };
type Estimate = { id: string; fuel_date: string; distance_km: number; liters_per_100km: number; anomaly: boolean };

export default function ConsumptionPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  const [min, setMin] = useState(""); const [max, setMax] = useState("");
  const [message, setMessage] = useState("");
  const fetchData = useCallback(async (id?: string) => {
    const token = await getToken(); if (!token) return;
    const response = await fetch(`/api/ops/vehicle-consumption${id ? `?vehicle_id=${encodeURIComponent(id)}` : ""}`,
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) return setMessage(data.error ?? "Dati non disponibili.");
    if (!id) setVehicles(data.vehicles);
    else { setSelected(data.vehicle); setEstimates(data.estimates);
      setMin(String(data.vehicle.consumption_min_l_per_100km ?? "")); setMax(String(data.vehicle.consumption_max_l_per_100km ?? "")); }
  }, []);
  useEffect(() => { void Promise.resolve().then(() => fetchData()); }, [fetchData]);
  useEffect(() => { if (selectedId) void Promise.resolve().then(() => fetchData(selectedId)); }, [fetchData, selectedId]);
  async function save() {
    const token = await getToken(); if (!token) return;
    const response = await fetch("/api/ops/vehicle-consumption", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ vehicle_id: selectedId, min: min ? Number(min.replace(",", ".")) : null,
        max: max ? Number(max.replace(",", ".")) : null }) });
    const data = await response.json(); setMessage(response.ok ? "Intervallo aggiornato." : data.error ?? "Salvataggio fallito.");
    if (response.ok) void fetchData(selectedId);
  }
  return <main className="mx-auto max-w-5xl space-y-5 p-5">
    <a href="/fleet-ops/fuel" className="text-sm text-blue-700 underline">← Rifornimenti</a>
    <h1 className="text-2xl font-bold">Intervalli di consumo per mezzo</h1>
    <p className="text-sm text-slate-600">Stima da due rifornimenti consecutivi con chilometraggio. È indicativa: un pieno parziale può alterarla.</p>
    <select className="input-saas" value={selectedId} onChange={e => setSelectedId(e.target.value)}><option value="">Seleziona mezzo</option>
      {vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.label} {vehicle.plate}</option>)}
    </select>
    {selected && <section className="rounded-xl border bg-white p-4 space-y-3">
      <h2 className="font-semibold">{selected.label} · {selected.plate}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label>Minimo L/100 km<input type="number" step="0.01" min="0" className="input-saas block" value={min} onChange={e => setMin(e.target.value)} /></label>
        <label>Massimo L/100 km<input type="number" step="0.01" min="0" className="input-saas block" value={max} onChange={e => setMax(e.target.value)} /></label>
        <button className="btn-primary" onClick={() => void save()}>Salva intervallo</button>
      </div>
    </section>}
    {message && <p role="status" className="text-sm text-amber-800">{message}</p>}
    {selected && <section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Stime dai rifornimenti</h2>
      {estimates.map(row => <p key={row.id} className={`mt-2 text-sm ${row.anomaly ? "font-semibold text-rose-700" : "text-slate-700"}`}>
        {row.fuel_date} · {row.distance_km} km · {row.liters_per_100km.toFixed(2)} L/100 km {row.anomaly ? "· fuori intervallo" : ""}
      </p>)}
      {!estimates.length && <p className="mt-2 text-sm text-slate-500">Servono almeno due rifornimenti approvati con km e litri.</p>}
    </section>}
  </main>;
}
