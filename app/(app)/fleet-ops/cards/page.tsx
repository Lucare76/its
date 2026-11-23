"use client";

import { useCallback, useEffect, useState } from "react";
import { getToken } from "@/lib/supabase/client";

type Card = { id: string; label: string; last_four: string | null; supplier: string | null; assigned_driver_id: string | null };
type Driver = { id: string; full_name: string };
type Assignment = { id: string; card_id: string; driver_id: string; assigned_at: string; returned_at: string | null };

export default function FuelCardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [label, setLabel] = useState("");
  const [lastFour, setLastFour] = useState("");
  const [supplier, setSupplier] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const token = await getToken(); if (!token) return;
    const response = await fetch("/api/ops/fuel-cards", { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) return setMessage(result.error ?? "Impossibile leggere le carte.");
    setCards(result.cards); setDrivers(result.drivers); setAssignments(result.assignments);
  }, []);
  useEffect(() => { void Promise.resolve().then(refresh); }, [refresh]);
  async function save(payload: Record<string, unknown>) {
    const token = await getToken(); if (!token) return;
    setBusy(true);
    const response = await fetch("/api/ops/fuel-cards", { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const result = await response.json(); setBusy(false);
    setMessage(response.ok ? "Carta aggiornata." : result.error ?? "Operazione non riuscita.");
    if (response.ok) { setLabel(""); setLastFour(""); setSupplier(""); await refresh(); }
  }
  return <main className="mx-auto max-w-5xl space-y-5 p-5">
    <a href="/fleet-ops/fuel" className="text-sm text-blue-700 underline">← Rifornimenti</a>
    <h1 className="text-2xl font-bold">Carte carburante e autisti</h1>
    <p className="text-sm text-slate-600">La carta è affidata a un autista; la targa abituale non determina il mezzo rifornito. Il mezzo effettivo va indicato nel rifornimento.</p>
    <section className="rounded-xl border bg-white p-4 space-y-3">
      <h2 className="font-semibold">Registra una carta</h2>
      <div className="flex flex-wrap gap-2">
        <input className="input-saas" placeholder="Nome carta" value={label} onChange={e => setLabel(e.target.value)} />
        <input className="input-saas" placeholder="Ultime 4 cifre (facoltative)" maxLength={4} value={lastFour} onChange={e => setLastFour(e.target.value.replace(/\D/g, ""))} />
        <input className="input-saas" placeholder="Emittente (facoltativo)" value={supplier} onChange={e => setSupplier(e.target.value)} />
        <button disabled={busy || !label.trim()} className="btn-primary" onClick={() => void save({ action: "create", label: label.trim(), last_four: lastFour || null, supplier: supplier.trim() || null })}>Aggiungi</button>
      </div>
      <p className="text-xs text-slate-500">Non inserire il PIN o il numero completo della carta.</p>
    </section>
    {message && <p role="status" className="text-sm text-amber-800">{message}</p>}
    <section className="rounded-xl border bg-white p-4 space-y-3">
      {cards.map(card => <div key={card.id} className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
        <div><strong>{card.label}</strong> {card.last_four && <span>•••• {card.last_four}</span>} <span className="text-slate-500">{card.supplier}</span></div>
        <label className="text-sm">In consegna a <select disabled={busy} className="input-saas ml-2" value={card.assigned_driver_id ?? ""}
          onChange={e => void save({ action: "assign", card_id: card.id, driver_id: e.target.value || null })}>
          <option value="">Nessuno</option>{drivers.map(driver => <option key={driver.id} value={driver.id}>{driver.full_name}</option>)}
        </select></label>
      </div>)}
      {!cards.length && <p className="text-sm text-slate-500">Nessuna carta registrata.</p>}
    </section>
    {assignments.length > 0 && <section className="rounded-xl border bg-white p-4"><h2 className="font-semibold">Storico consegne</h2>
      {assignments.map(entry => <p key={entry.id} className="mt-2 text-sm">{cards.find(c => c.id === entry.card_id)?.label ?? "Carta"} · {drivers.find(d => d.id === entry.driver_id)?.full_name ?? "Autista"} · {new Date(entry.assigned_at).toLocaleDateString("it-IT")} {entry.returned_at ? "(restituita)" : "(in uso)"}</p>)}
    </section>}
  </main>;
}
