"use client";

import { useEffect, useState, useCallback } from "react";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

const SERVICE_KINDS = [
  { value: "transfer_port_hotel",               label: "Transfer Porto" },
  { value: "transfer_airport_hotel",            label: "Transfer Aeroporto" },
  { value: "transfer_airport_hotel_exclusive",  label: "Transfer Aeroporto 🔒" },
  { value: "transfer_train_hotel",              label: "Transfer Stazione" },
  { value: "transfer_train_hotel_exclusive",    label: "Transfer Stazione 🔒" },
  { value: "bus_city_hotel",                    label: "Bus da città" },
  { value: "excursion",                         label: "Escursione" },
  { value: "formula_snav",                      label: "Formula SNAV" },
  { value: "formula_medmar",                    label: "Formula MEDMAR" },
];

type Agency = { id: string; name: string };
type Rate   = { id: string; agency_id: string | null; hotel_id: string | null; booking_service_kind: string; price_cents: number; notes: string };

function centsToEur(cents: number) {
  return (cents / 100).toFixed(2).replace(".", ",");
}
function eurToCents(eur: string) {
  const n = parseFloat(eur.replace(",", "."));
  return isNaN(n) ? null : Math.round(n * 100);
}

export default function AgencyRatesPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<Agency[]>([]);
  const [rates, setRates] = useState<Rate[]>([]);
  const [selectedAgencyId, setSelectedAgencyId] = useState<string | null>(null); // null = default globale
  const [saving, setSaving] = useState<string | null>(null); // kind attualmente in salvataggio
  const [draft, setDraft] = useState<Record<string, string>>({}); // kind → "€ string"
  const [copyFrom, setCopyFrom] = useState<string>("");
  const [copying, setCopying] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  const load = useCallback(async (tk: string) => {
    const res = await fetch("/api/agency/rates", {
      headers: { Authorization: `Bearer ${tk}` }
    });
    const body = await res.json().catch(() => null) as { rates?: Rate[]; agencies?: Agency[] } | null;
    if (!res.ok || !body) { setError("Errore caricamento listini."); return; }
    setAgencies(body.agencies ?? []);
    setRates(body.rates ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); setLoading(false); return; }
      if (session.role !== "admin" && session.role !== "operator") { setError("Accesso non autorizzato."); setLoading(false); return; }
      const { data: sd } = await supabase.auth.getSession();
      const tk = sd.session?.access_token ?? null;
      if (!tk) { setError("Sessione non valida."); setLoading(false); return; }
      setToken(tk);
      await load(tk);
      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [load]);

  // Aggiorna draft quando cambia agenzia selezionata
  useEffect(() => {
    const newDraft: Record<string, string> = {};
    for (const kind of SERVICE_KINDS) {
      const r = rates.find(
        (x) => x.booking_service_kind === kind.value &&
                x.agency_id === (selectedAgencyId ?? null) &&
                x.hotel_id === null
      );
      newDraft[kind.value] = r ? centsToEur(r.price_cents) : "";
    }
    setDraft(newDraft);
  }, [selectedAgencyId, rates]);

  const saveRate = async (kind: string) => {
    if (!token) return;
    const eurStr = draft[kind] ?? "";
    const cents = eurStr.trim() ? eurToCents(eurStr) : null;
    if (eurStr.trim() && cents === null) return; // valore non valido

    setSaving(kind);
    if (cents === null) {
      // Elimina il rate se esiste
      const existing = rates.find(
        (x) => x.booking_service_kind === kind &&
                x.agency_id === (selectedAgencyId ?? null) &&
                x.hotel_id === null
      );
      if (existing) {
        await fetch(`/api/agency/rates/${existing.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` }
        });
        setRates((prev) => prev.filter((x) => x.id !== existing.id));
      }
    } else {
      const res = await fetch("/api/agency/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          agency_id: selectedAgencyId ?? null,
          hotel_id: null,
          booking_service_kind: kind,
          price_cents: cents
        })
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; id?: string } | null;
      if (body?.ok && body.id) {
        const newRate: Rate = {
          id: body.id,
          agency_id: selectedAgencyId ?? null,
          hotel_id: null,
          booking_service_kind: kind,
          price_cents: cents,
          notes: ""
        };
        setRates((prev) => [
          ...prev.filter((x) => !(x.booking_service_kind === kind && x.agency_id === (selectedAgencyId ?? null) && x.hotel_id === null)),
          newRate
        ]);
      }
    }
    setSaving(null);
  };

  const copyListino = async () => {
    if (!token || !copyFrom) return;
    setCopying(true);
    setCopyMsg(null);
    const res = await fetch("/api/agency/rates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        copy_from_agency_id: copyFrom === "__default__" ? null : copyFrom,
        copy_to_agency_id: selectedAgencyId ?? null
      })
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; copied?: number; error?: string } | null;
    if (body?.ok) {
      setCopyMsg(`✅ ${body.copied ?? 0} voci copiate.`);
      await load(token);
    } else {
      setCopyMsg(`❌ ${body?.error ?? "Errore copia."}`);
    }
    setCopying(false);
  };

  if (loading) return <div className="p-6 text-sm text-slate-500">Caricamento...</div>;
  if (error)   return <div className="p-6 text-sm text-rose-600">{error}</div>;

  const selectedAgencyName = selectedAgencyId
    ? (agencies.find((a) => a.id === selectedAgencyId)?.name ?? "Agenzia")
    : "Listino default (tutte le agenzie)";

  return (
    <section className="mx-auto max-w-4xl page-section">
      <div className="section-head">
        <div>
          <h1 className="section-title">Listini agenzie</h1>
          <p className="section-subtitle">Inserisci i prezzi per tipo servizio. L'operatore riceve un avviso se il prezzo dichiarato dall'agenzia non corrisponde.</p>
        </div>
      </div>

      {/* Selettore agenzia */}
      <div className="card p-4 flex flex-wrap items-center gap-4">
        <div className="flex-1 min-w-48">
          <label className="text-xs font-semibold text-slate-500 block mb-1">Agenzia</label>
          <select
            className="input-saas"
            value={selectedAgencyId ?? "__default__"}
            onChange={(e) => setSelectedAgencyId(e.target.value === "__default__" ? null : e.target.value)}
          >
            <option value="__default__">⭐ Default (tutte le agenzie)</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Copia listino da */}
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-xs font-semibold text-slate-500 block mb-1">Copia listino da</label>
            <select
              className="input-saas"
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
            >
              <option value="">— seleziona sorgente —</option>
              <option value="__default__">⭐ Default</option>
              {agencies
                .filter((a) => a.id !== selectedAgencyId)
                .map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
            </select>
          </div>
          <button
            type="button"
            disabled={!copyFrom || copying || copyFrom === (selectedAgencyId ?? "__default__")}
            onClick={() => void copyListino()}
            className="btn-secondary py-2 text-sm disabled:opacity-50"
          >
            {copying ? "Copia..." : "Copia →"}
          </button>
          {copyMsg && <span className="text-xs font-medium text-slate-600">{copyMsg}</span>}
        </div>
      </div>

      {/* Grid prezzi */}
      <div className="card overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3 bg-slate-50">
          <p className="text-sm font-bold text-slate-700">{selectedAgencyName}</p>
          <p className="text-xs text-slate-400 mt-0.5">Clicca su un campo per modificare il prezzo. Invio o Tab per salvare.</p>
        </div>
        <div className="divide-y divide-slate-100">
          {SERVICE_KINDS.map((kind) => {
            const isSaving = saving === kind.value;
            const currentRate = rates.find(
              (x) => x.booking_service_kind === kind.value &&
                      x.agency_id === (selectedAgencyId ?? null) &&
                      x.hotel_id === null
            );
            const hasDefault = !selectedAgencyId && currentRate;
            const defaultRate = selectedAgencyId
              ? rates.find((x) => x.booking_service_kind === kind.value && x.agency_id === null && x.hotel_id === null)
              : null;

            return (
              <div key={kind.value} className="flex items-center gap-4 px-5 py-3 hover:bg-slate-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">{kind.label}</p>
                  {defaultRate && (
                    <p className="text-xs text-slate-400">Default: €{centsToEur(defaultRate.price_cents)}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative w-28">
                    <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">€</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder={defaultRate ? centsToEur(defaultRate.price_cents) : "—"}
                      className="input-saas pl-6 pr-2 text-right text-sm"
                      value={draft[kind.value] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [kind.value]: e.target.value }))}
                      onBlur={() => void saveRate(kind.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.currentTarget.blur(); } }}
                    />
                  </div>
                  {isSaving ? (
                    <span className="text-xs text-slate-400 w-12">salvo...</span>
                  ) : currentRate ? (
                    <span className="text-xs text-emerald-600 w-12 font-semibold">✓ ok</span>
                  ) : (
                    <span className="text-xs text-slate-300 w-12">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        <strong>Come funziona:</strong> Il listino <em>Default</em> vale per tutte le agenzie senza listino specifico. Un listino agenzia ha priorità sul default. Il prezzo dichiarato dall'agenzia in fase di prenotazione viene confrontato con il listino: se c'è un mismatch superiore a €0,50, l'operatore riceve un avviso nella mail.
      </div>
    </section>
  );
}
