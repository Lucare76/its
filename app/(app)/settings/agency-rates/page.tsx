"use client";

import { useEffect, useState, useCallback } from "react";
import { DateInput } from "@/components/ui";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------
type Agency    = { id: string; name: string };
type BusLine   = { code: string; name: string };
type CustomKind = { id: string; kind_key: string; label: string };
type Rate = {
  id: string;
  agency_id: string | null;
  booking_service_kind: string;
  line_code: string | null;
  price_cents: number;
  cost_cents: number | null;
  valid_from: string;
  valid_to: string | null;
  notes: string;
};

// ---------------------------------------------------------------------------
// Costanti
// ---------------------------------------------------------------------------
const TRANSFER_KINDS = [
  { key: "transfer_port_hotel",              label: "Transfer Porto / Hotel" },
  { key: "transfer_airport_hotel",           label: "Transfer Aeroporto / Hotel" },
  { key: "transfer_airport_hotel_exclusive", label: "Transfer Aeroporto Esclusivo" },
  { key: "transfer_train_hotel",             label: "Transfer Stazione / Hotel" },
  { key: "transfer_train_hotel_exclusive",   label: "Transfer Stazione Esclusivo" },
];

const FORMULA_KINDS = [
  { key: "formula_snav",   label: "Formula SNAV" },
  { key: "formula_medmar_napoli", label: "Formula MEDMAR Napoli" },
  { key: "formula_medmar_pozzuoli", label: "Formula MEDMAR Pozzuoli" },
];

const EXCURSION_PRELOADED: { key: string; label: string; defaultCostCents: number }[] = [
  { key: "excursion_giro_isola_motonave",  label: "Giro Isola Motonave",           defaultCostCents: 1500 },
  { key: "excursion_giro_isola_minibus",   label: "Giro Isola Minibus",            defaultCostCents: 1000 },
  { key: "excursion_capri_solo",           label: "Capri Solo Motonave",           defaultCostCents: 5000 },
  { key: "excursion_capri_guida",          label: "Capri con Guida",               defaultCostCents: 7900 },
  { key: "excursion_capri_giro_mare",      label: "Capri con Giro Isola via Mare", defaultCostCents: 7500 },
  { key: "excursion_castello_aragonese",   label: "Castello Aragonese",            defaultCostCents: 3000 },
  { key: "excursion_procida_solo",         label: "Procida Solo Motonave",         defaultCostCents: 1500 },
  { key: "excursion_procida_guida",        label: "Procida con Guida",             defaultCostCents: 3000 },
  { key: "excursion_amalfi_positano",      label: "Amalfi & Positano",             defaultCostCents: 5500 },
  { key: "excursion_sorrento",             label: "Sorrento",                      defaultCostCents: 5500 },
  { key: "excursion_mortella",             label: "La Mortella",                   defaultCostCents: 2500 },
  { key: "excursion_nitrodi",              label: "Nitrodi",                       defaultCostCents: 2200 },
  { key: "excursion_cooking_class",        label: "Cooking Class Dolci Campani",   defaultCostCents: 5300 },
  { key: "excursion_crateri",              label: "Escursione Crateri",            defaultCostCents: 2000 },
  { key: "excursion_napoli",               label: "Passeggiata a Napoli",          defaultCostCents: 4500 },
  { key: "excursion_pompei",               label: "Pompei",                        defaultCostCents: 5000 },
  { key: "excursion_caserta",              label: "Caserta",                       defaultCostCents: 5000 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function centsToEur(cents: number | null | undefined) {
  if (cents == null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}
function eurToCents(val: string): number | null {
  const n = parseFloat(val.replace(",", "."));
  return isNaN(n) || n < 0 ? null : Math.round(n * 100);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Trova il prezzo attivo per una data specifica (default = oggi)
function activeRate(rates: Rate[], agencyId: string | null, kindKey: string, lineCode?: string | null, onDate = today()) {
  return rates
    .filter((r) =>
      r.agency_id === agencyId &&
      r.booking_service_kind === kindKey &&
      (lineCode !== undefined ? r.line_code === lineCode : true) &&
      r.valid_from <= onDate &&
      (r.valid_to == null || r.valid_to >= onDate)
    )
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Componente riga prezzo
// ---------------------------------------------------------------------------
type PriceRowProps = {
  label: string;
  kindKey: string;
  lineCode?: string | null;
  agencyIds: Array<string | null>; // una o più agenzie selezionate
  rates: Rate[];
  token: string;
  isAdmin: boolean;
  preloadedCostCents?: number;
  onSaved: () => void;
};

function PriceRow({ label, kindKey, lineCode = null, agencyIds, rates, token, isAdmin, preloadedCostCents, onSaved }: PriceRowProps) {
  // Per la visualizzazione usiamo la prima agenzia selezionata
  const primaryId = agencyIds[0] ?? null;
  const current = activeRate(rates, primaryId, kindKey, lineCode);
  const [priceStr, setPriceStr] = useState(centsToEur(current?.price_cents));
  const [costStr, setCostStr] = useState(centsToEur(current?.cost_cents ?? preloadedCostCents));
  const [validFrom, setValidFrom] = useState(today());
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const c = activeRate(rates, primaryId, kindKey, lineCode);
    setPriceStr(centsToEur(c?.price_cents));
    setCostStr(centsToEur(c?.cost_cents ?? preloadedCostCents));
  }, [rates, primaryId, kindKey, lineCode, preloadedCostCents]);

  const save = async () => {
    const priceCents = eurToCents(priceStr);
    if (priceCents === null && priceStr.trim() !== "") return;
    if (priceCents === null) return;
    setSaving(true);
    // Salva su tutte le agenzie selezionate
    await Promise.all(agencyIds.map((aid) =>
      fetch("/api/agency/rates", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          agency_id: aid,
          booking_service_kind: kindKey,
          line_code: lineCode,
          price_cents: priceCents,
          cost_cents: isAdmin ? (eurToCents(costStr) ?? null) : undefined,
          valid_from: validFrom,
        }),
      })
    ));
    setSaving(false);
    onSaved();
  };

  const history = rates
    .filter((r) => r.agency_id === primaryId && r.booking_service_kind === kindKey && (lineCode !== undefined ? r.line_code === lineCode : true))
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from));

  return (
    <div className="border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-50">
        <span className="min-w-0 flex-1 text-sm font-medium text-slate-800">{label}</span>

        {/* Prezzo agenzia */}
        <label className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2 py-1.5">
          <span className="text-xs text-slate-400">€</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0,00"
            className="w-20 bg-transparent text-right text-sm outline-none"
            value={priceStr}
            onChange={(e) => setPriceStr(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
          />
        </label>

        {/* Costo operatore — solo admin */}
        {isAdmin ? (
          <label className="flex items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 px-2 py-1.5">
            <span className="text-xs text-slate-400">costo €</span>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              className="w-20 bg-transparent text-right text-sm outline-none"
              value={costStr}
              onChange={(e) => setCostStr(e.target.value)}
              onBlur={() => void save()}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            />
          </label>
        ) : null}

        {/* Data validità */}
        <DateInput
          className="rounded-xl border border-slate-200 px-2 py-1.5 text-xs text-slate-600"
          value={validFrom}
          onChange={(iso) => setValidFrom(iso)}
          title="Valido dal"
        />

        {/* Stato */}
        {saving ? (
          <span className="text-xs text-slate-400 w-16">{agencyIds.length > 1 ? `salvo ${agencyIds.length}...` : "..."}</span>
        ) : current ? (
          <span className="text-xs font-semibold text-emerald-600">✓</span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        )}

        {/* Storico */}
        {history.length > 1 ? (
          <button
            type="button"
            className="text-xs text-sky-600 underline"
            onClick={() => setShowHistory((v) => !v)}
          >
            {showHistory ? "Chiudi" : `Storico (${history.length})`}
          </button>
        ) : null}
      </div>

      {/* Storico prezzi */}
      {showHistory ? (
        <div className="mx-4 mb-3 rounded-xl border border-slate-100 bg-slate-50 text-xs">
          <div className="grid grid-cols-4 gap-2 border-b border-slate-200 px-3 py-2 font-semibold text-slate-500">
            <span>Dal</span><span>Al</span><span>Prezzo</span>{isAdmin ? <span>Costo</span> : <span />}
          </div>
          {history.map((h) => (
            <div key={h.id} className="grid grid-cols-4 gap-2 px-3 py-2 text-slate-600">
              <span>{h.valid_from}</span>
              <span>{h.valid_to ?? "aperto"}</span>
              <span>€ {centsToEur(h.price_cents)}</span>
              {isAdmin ? <span>{h.cost_cents != null ? `€ ${centsToEur(h.cost_cents)}` : "—"}</span> : <span />}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Componente sezione collassabile
// ---------------------------------------------------------------------------
function Section({ title, badge, children }: { title: string; badge?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-800">{title}</span>
          {badge ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{badge}</span> : null}
        </div>
        <span className="text-slate-400 text-sm">{open ? "▲" : "▼"}</span>
      </button>
      {open ? <div>{children}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagina principale
// ---------------------------------------------------------------------------
export default function AgencyRatesPage() {
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [token, setToken]           = useState<string | null>(null);
  const [isAdmin, setIsAdmin]       = useState(false);
  const [agencies, setAgencies]     = useState<Agency[]>([]);
  const [busLines, setBusLines]     = useState<BusLine[]>([]);
  const [customKinds, setCustomKinds] = useState<CustomKind[]>([]);
  const [rates, setRates]           = useState<Rate[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string | null>>(new Set([null])); // null = default
  const [multiMode, setMultiMode] = useState(false);

  // Nuova voce custom
  const [newKindKey, setNewKindKey] = useState("");
  const [newKindLabel, setNewKindLabel] = useState("");
  const [creatingKind, setCreatingKind] = useState(false);
  const [kindMsg, setKindMsg] = useState<string | null>(null);

  const load = useCallback(async (tk: string) => {
    const res = await fetch("/api/agency/rates", { headers: { Authorization: `Bearer ${tk}` } });
    const body = await res.json().catch(() => null) as {
      rates?: Rate[]; agencies?: Agency[]; busLines?: BusLine[]; customKinds?: CustomKind[];
    } | null;
    if (!res.ok || !body) { setError("Errore caricamento listini."); return; }
    setAgencies(body.agencies ?? []);
    setBusLines(body.busLines ?? []);
    setCustomKinds(body.customKinds ?? []);
    setRates(body.rates ?? []);
  }, []);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase) { setError("Supabase non configurato."); setLoading(false); return; }
      if (!["admin", "operator"].includes(session.role ?? "")) { setError("Accesso non autorizzato."); setLoading(false); return; }
      const { data: sd } = await supabase.auth.getSession();
      const tk = sd.session?.access_token ?? null;
      if (!tk) { setError("Sessione non valida."); setLoading(false); return; }
      setToken(tk);
      setIsAdmin(session.role === "admin");
      await load(tk);
      setLoading(false);
    };
    void boot();
    return () => { active = false; };
  }, [load]);

  const createCustomKind = async () => {
    if (!token || !newKindKey.trim() || !newKindLabel.trim()) return;
    const key = newKindKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
    setCreatingKind(true);
    const res = await fetch("/api/agency/rates", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ create_kind: true, kind_key: key, label: newKindLabel.trim() }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
    if (body?.ok) {
      setNewKindKey(""); setNewKindLabel("");
      setKindMsg("Voce aggiunta.");
      await load(token);
    } else {
      setKindMsg(body?.error ?? "Errore creazione voce.");
    }
    setCreatingKind(false);
  };

  if (loading) return <div className="p-6 text-sm text-slate-500">Caricamento...</div>;
  if (error)   return <div className="p-6 text-sm text-rose-600">{error}</div>;
  if (!token)  return null;

  // Array di agency_id selezionati (null = default)
  const selectedIdsArray = Array.from(selectedIds);
  const selectionLabel = selectedIdsArray.length === 0
    ? "Nessuna selezione"
    : selectedIdsArray.length === 1
      ? (selectedIdsArray[0] == null ? "Default (tutte)" : (agencies.find((a) => a.id === selectedIdsArray[0])?.name ?? "Agenzia"))
      : `${selectedIdsArray.length} agenzie selezionate`;

  const rowProps = (kindKey: string, lineCode?: string | null) => ({
    kindKey, lineCode: lineCode ?? null,
    agencyIds: selectedIdsArray,
    rates, token, isAdmin,
    onSaved: () => void load(token),
  });

  const toggleAgency = (id: string | null) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <section className="mx-auto max-w-4xl space-y-4 p-4">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Listini agenzie</h1>
        <p className="mt-1 text-sm text-slate-500">Prezzi per tipo servizio, per agenzia. I prezzi hanno storico con data di validità.</p>
      </div>

      {/* Selettore agenzia */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-xs font-semibold text-slate-500">Seleziona agenzia/e</span>
            {selectedIdsArray.length > 1 ? (
              <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">
                {selectedIdsArray.length} selezionate — i prezzi verranno salvati per tutte
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="text-xs text-slate-500 underline"
            onClick={() => {
              if (selectedIds.size === agencies.length + 1) {
                setSelectedIds(new Set([null]));
              } else {
                setSelectedIds(new Set([null, ...agencies.map((a) => a.id as string | null)]));
              }
            }}
          >
            {selectedIds.size === agencies.length + 1 ? "Deseleziona tutto" : "Seleziona tutte"}
          </button>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-slate-50 transition-colors"
            style={{ borderColor: selectedIds.has(null) ? "#3b82f6" : undefined, background: selectedIds.has(null) ? "#eff6ff" : undefined }}>
            <input type="checkbox" checked={selectedIds.has(null)} onChange={() => toggleAgency(null)} className="accent-blue-600" />
            <span className="font-medium text-slate-700">Default (tutte)</span>
          </label>
          {agencies.map((a) => (
            <label key={a.id}
              className="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm hover:bg-slate-50 transition-colors"
              style={{ borderColor: selectedIds.has(a.id) ? "#3b82f6" : undefined, background: selectedIds.has(a.id) ? "#eff6ff" : undefined }}>
              <input type="checkbox" checked={selectedIds.has(a.id)} onChange={() => toggleAgency(a.id)} className="accent-blue-600" />
              <span className="truncate text-slate-700">{a.name}</span>
            </label>
          ))}
        </div>
        {selectedIdsArray.length > 0 ? (
          <p className="text-xs text-slate-400">
            Stai modificando: <span className="font-medium text-slate-600">{selectionLabel}</span>
          </p>
        ) : (
          <p className="text-xs text-rose-500">Seleziona almeno un&apos;agenzia.</p>
        )}
      </div>

      {/* Header colonne */}
      {isAdmin ? (
        <div className="flex items-center gap-3 px-4 text-xs font-semibold text-slate-400">
          <span className="flex-1">Voce</span>
          <span className="w-28 text-right">Prezzo agenzia</span>
          <span className="w-32 text-right">Costo operatore</span>
          <span className="w-28 text-right">Valido dal</span>
          <span className="w-8" />
        </div>
      ) : null}

      {/* TRANSFER */}
      <Section title="Transfer" badge={`${TRANSFER_KINDS.length} voci`}>
        {TRANSFER_KINDS.map((k) => (
          <PriceRow key={k.key} label={k.label} {...rowProps(k.key)} />
        ))}
      </Section>

      {/* FORMULA SNAV / MEDMAR */}
      <Section title="Formula SNAV / MEDMAR" badge="2 voci">
        {FORMULA_KINDS.map((k) => (
          <PriceRow key={k.key} label={k.label} {...rowProps(k.key)} />
        ))}
      </Section>

      {/* BUS DA CITTÀ */}
      <Section title="Bus da città" badge={`${busLines.length} linee`}>
        <div className="border-b border-slate-100 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          Prezzi per linea. Quando arriva una prenotazione con la città di partenza, il sistema trova automaticamente la linea corrispondente e applica questo prezzo.
        </div>
        {busLines.map((line) => (
          <PriceRow
            key={line.code}
            label={line.name}
            {...rowProps("bus_city_hotel", line.code)}
          />
        ))}
      </Section>

      {/* ESCURSIONI */}
      <Section title="Escursioni" badge={`${EXCURSION_PRELOADED.length} voci`}>
        <div className="border-b border-slate-100 bg-sky-50 px-4 py-2 text-xs text-sky-700">
          Il <strong>prezzo agenzia</strong> è quello che paga l&apos;agenzia a Ischia Transfer (dal programma escursioni 2026) — uguale per tutte, pre-caricato.
          {isAdmin ? <> Il <strong>costo operatore</strong> è quello che ti costa il servizio — inseriscilo tu.</> : null}
        </div>
        {EXCURSION_PRELOADED.map((exc) => (
          <PriceRow
            key={exc.key}
            label={exc.label}
            preloadedCostCents={exc.defaultCostCents}
            {...rowProps(exc.key)}
          />
        ))}
      </Section>

      {/* VOCI CUSTOM */}
      {customKinds.length > 0 ? (
        <Section title="Servizi aggiuntivi" badge={`${customKinds.length} voci`}>
          {customKinds.map((k) => (
            <PriceRow key={k.kind_key} label={k.label} {...rowProps(k.kind_key)} />
          ))}
        </Section>
      ) : null}

      {/* AGGIUNGI VOCE CUSTOM */}
      <div className="card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700">Aggiungi voce personalizzata</h2>
        <p className="text-xs text-slate-500">Una nuova voce viene aggiunta per tutte le agenzie. Il codice interno viene generato automaticamente.</p>
        <div className="flex flex-wrap gap-2">
          <input
            placeholder="Nome voce (es. Noleggio pulmino privato)"
            className="input-saas flex-1 min-w-48"
            value={newKindLabel}
            onChange={(e) => {
              setNewKindLabel(e.target.value);
              setNewKindKey(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
            }}
          />
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            disabled={creatingKind || !newKindLabel.trim()}
            onClick={() => void createCustomKind()}
          >
            {creatingKind ? "Aggiunta..." : "Aggiungi voce"}
          </button>
        </div>
        {newKindKey ? <p className="text-xs text-slate-400">Codice interno: <code>{newKindKey}</code></p> : null}
        {kindMsg ? <p className="text-xs font-medium text-slate-600">{kindMsg}</p> : null}
      </div>

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
        <strong>Storico prezzi:</strong> ogni modifica crea una nuova versione con data di inizio. Le prenotazioni già inserite usano sempre il prezzo attivo al momento della loro creazione — non vengono mai aggiornate retroattivamente.
      </div>
    </section>
  );
}
