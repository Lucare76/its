"use client";

import { use, useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import Link from "next/link";

/* ─── Tipi ───────────────────────────────────────────────────────────────── */

type Maintenance = {
  id: string;
  maintenance_date: string;
  description: string;
  cost?: number | null;
  km_at_service?: number | null;
  provider?: string | null;
  notes?: string | null;
};

type Fuel = {
  id: string;
  fuel_date: string;
  liters?: number | null;
  cost?: number | null;
  km_at_fuel?: number | null;
  fuel_type?: string | null;
  station?: string | null;
};

type KmLog = {
  id: string;
  driver_name: string;
  start_km: number;
  end_km: number | null;
  start_at: string;
  end_at: string | null;
  notes: string | null;
};

type SparePart = {
  id: string;
  order_date: string;
  part_name: string;
  quantity: number;
  cost?: number | null;
  supplier?: string | null;
  status: string;
  installed_at?: string | null;
};

/* ─── Helpers ────────────────────────────────────────────────────────────── */

async function getToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/* ─── Pagina ─────────────────────────────────────────────────────────────── */

export default function VehicleRecordsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: vehicleId } = use(params);

  const [vehicleLabel, setVehicleLabel] = useState<string>("");
  const [tab, setTab]     = useState<"maintenance" | "fuel" | "spare_parts" | "km_logs">("maintenance");
  const [records, setRecords]   = useState<(Maintenance | Fuel | SparePart)[]>([]);
  const [loading, setLoading]   = useState(false);
  const [saving,  setSaving]    = useState(false);
  const [toast,   setToast]     = useState<{ text: string; ok: boolean } | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form fields (shared + per-type)
  const [fDate,     setFDate]     = useState("");
  const [fDesc,     setFDesc]     = useState("");
  const [fCost,     setFCost]     = useState("");
  const [fKm,       setFKm]       = useState("");
  const [fProvider, setFProvider] = useState("");
  const [fNotes,    setFNotes]    = useState("");
  // fuel specific
  const [fLiters,    setFLiters]    = useState("");
  const [fFuelType,  setFFuelType]  = useState("diesel");
  const [fStation,   setFStation]   = useState("");
  // spare parts specific
  const [fPartName,    setFPartName]    = useState("");
  const [fQty,         setFQty]         = useState("1");
  const [fSupplier,    setFSupplier]    = useState("");
  const [fStatus,      setFStatus]      = useState("ordered");
  const [fInstalledAt, setFInstalledAt] = useState("");

  const showMsg = (text: string, ok: boolean) => {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    if (tab === "km_logs") {
      // Km logs vengono dall'API pubblica del veicolo tramite qr_token
      const token = await getToken();
      if (!token) { setLoading(false); return; }
      // Recupera qr_token del veicolo
      const vRes = await fetch("/api/ops/vehicles", { headers: { Authorization: `Bearer ${token}` } });
      const vData = await vRes.json();
      const v = (vData.vehicles ?? []).find((x: { id: string; qr_token?: string }) => x.id === vehicleId);
      if (!v?.qr_token) { setRecords([]); setLoading(false); return; }
      const logsRes = await fetch(`/api/vehicle/${v.qr_token}`);
      const logsData = await logsRes.json();
      const all: KmLog[] = [
        ...(logsData.openLog ? [{ ...logsData.openLog, end_km: null, end_at: null, notes: null }] : []),
        ...(logsData.kmLogs ?? []),
      ];
      setRecords(all as unknown as (Maintenance | Fuel | SparePart)[]);
      setLoading(false);
      return;
    }
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch(`/api/ops/vehicle-records?vehicle_id=${vehicleId}&type=${tab}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setRecords(data.records ?? []);
    setLoading(false);
  }, [vehicleId, tab]);

  // Carica nome veicolo
  useEffect(() => {
    getToken().then((token) => {
      if (!token) return;
      fetch("/api/ops/vehicles", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((d) => {
          const v = (d.vehicles ?? []).find((x: { id: string; label: string }) => x.id === vehicleId);
          if (v) setVehicleLabel(v.label);
        });
    });
  }, [vehicleId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  function resetForm() {
    setFDate(""); setFDesc(""); setFCost(""); setFKm(""); setFProvider(""); setFNotes("");
    setFLiters(""); setFFuelType("diesel"); setFStation("");
    setFPartName(""); setFQty("1"); setFSupplier(""); setFStatus("ordered"); setFInstalledAt("");
    setShowForm(false);
  }

  async function handleAdd() {
    const token = await getToken();
    if (!token) return;
    setSaving(true);

    let data: Record<string, unknown> = {};
    if (tab === "maintenance") {
      data = {
        maintenance_date: fDate,
        description: fDesc,
        cost:        fCost   ? Number(fCost)   : null,
        km_at_service: fKm   ? Number(fKm)     : null,
        provider:    fProvider || null,
        notes:       fNotes   || null,
      };
    } else if (tab === "fuel") {
      data = {
        fuel_date:  fDate,
        liters:     fLiters  ? Number(fLiters)  : null,
        cost:       fCost    ? Number(fCost)    : null,
        km_at_fuel: fKm      ? Number(fKm)      : null,
        fuel_type:  fFuelType || null,
        station:    fStation  || null,
      };
    } else {
      data = {
        order_date:   fDate,
        part_name:    fPartName,
        quantity:     Number(fQty) || 1,
        cost:         fCost        ? Number(fCost)  : null,
        supplier:     fSupplier    || null,
        status:       fStatus,
        installed_at: fInstalledAt || null,
      };
    }

    const res = await fetch("/api/ops/vehicle-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "insert", type: tab, vehicle_id: vehicleId, data }),
    });
    const json = await res.json();
    setSaving(false);
    if (json.ok) { showMsg("Aggiunto.", true); resetForm(); void load(); }
    else showMsg(json.error ?? "Errore.", false);
  }

  async function handleDelete(id: string) {
    if (!confirm("Eliminare questo record?")) return;
    const token = await getToken();
    if (!token) return;
    await fetch("/api/ops/vehicle-records", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "delete", type: tab, id }),
    });
    setRecords((prev) => prev.filter((r) => r.id !== id));
    showMsg("Eliminato.", true);
  }

  const TABS = [
    { key: "maintenance", label: "🔧 Manutenzioni" },
    { key: "fuel",        label: "⛽ Rifornimenti" },
    { key: "spare_parts", label: "🔩 Ricambi" },
    { key: "km_logs",     label: "🛣 Km turni" },
  ] as const;

  return (
    <section className="page-section">
      {/* Header */}
      <div className="mb-6">
        <Link href="/fleet-ops" className="text-xs text-slate-400 hover:text-slate-600 mb-2 inline-block">
          ← Torna alla flotta
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">{vehicleLabel || "Scheda veicolo"}</h1>
        <p className="text-sm text-slate-500">Gestisci manutenzioni, rifornimenti e ricambi del mezzo</p>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${toast.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          {toast.text}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 mb-5 border-b border-slate-200 pb-0">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); setShowForm(false); }}
            className={`px-4 py-2 text-sm font-semibold rounded-t-lg border-b-2 transition-colors ${
              tab === t.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Add form */}
      {showForm ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 mb-5">
          <h3 className="text-sm font-bold text-slate-700 mb-4">
            {tab === "maintenance" ? "Nuova manutenzione" : tab === "fuel" ? "Nuovo rifornimento" : "Nuovo ricambio"}
          </h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">

            {tab === "maintenance" && (
              <>
                <label className="text-xs font-semibold text-slate-500 col-span-2 sm:col-span-1">
                  Data *
                  <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className="input-saas mt-1 w-full" />
                </label>
                <label className="text-xs font-semibold text-slate-500 col-span-2">
                  Descrizione *
                  <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. Cambio olio motore" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Costo (€)
                  <input type="number" value={fCost} onChange={(e) => setFCost(e.target.value)} className="input-saas mt-1 w-full" placeholder="0.00" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Km alla revisione
                  <input type="number" value={fKm} onChange={(e) => setFKm(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. 123400" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Officina/Fornitore
                  <input value={fProvider} onChange={(e) => setFProvider(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. Autofficina Rossi" />
                </label>
                <label className="text-xs font-semibold text-slate-500 col-span-2">
                  Note
                  <textarea value={fNotes} onChange={(e) => setFNotes(e.target.value)} rows={2} className="input-saas mt-1 w-full resize-none" />
                </label>
              </>
            )}

            {tab === "fuel" && (
              <>
                <label className="text-xs font-semibold text-slate-500">
                  Data *
                  <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className="input-saas mt-1 w-full" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Carburante
                  <select value={fFuelType} onChange={(e) => setFFuelType(e.target.value)} className="input-saas mt-1 w-full">
                    <option value="diesel">Diesel</option>
                    <option value="benzina">Benzina</option>
                    <option value="gas">Gas</option>
                    <option value="elettrico">Elettrico</option>
                    <option value="ibrido">Ibrido</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Litri
                  <input type="number" value={fLiters} onChange={(e) => setFLiters(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. 60.5" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Costo (€)
                  <input type="number" value={fCost} onChange={(e) => setFCost(e.target.value)} className="input-saas mt-1 w-full" placeholder="0.00" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Km al rifornimento
                  <input type="number" value={fKm} onChange={(e) => setFKm(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. 123400" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Distributore
                  <input value={fStation} onChange={(e) => setFStation(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. Q8 Forio" />
                </label>
              </>
            )}

            {tab === "spare_parts" && (
              <>
                <label className="text-xs font-semibold text-slate-500">
                  Data ordine *
                  <input type="date" value={fDate} onChange={(e) => setFDate(e.target.value)} className="input-saas mt-1 w-full" />
                </label>
                <label className="text-xs font-semibold text-slate-500 col-span-2">
                  Nome pezzo *
                  <input value={fPartName} onChange={(e) => setFPartName(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. Filtro olio Mann W712" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Quantità
                  <input type="number" min="1" value={fQty} onChange={(e) => setFQty(e.target.value)} className="input-saas mt-1 w-full" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Costo (€)
                  <input type="number" value={fCost} onChange={(e) => setFCost(e.target.value)} className="input-saas mt-1 w-full" placeholder="0.00" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Stato
                  <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="input-saas mt-1 w-full">
                    <option value="ordered">Ordinato</option>
                    <option value="received">Ricevuto</option>
                    <option value="installed">Installato</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Fornitore
                  <input value={fSupplier} onChange={(e) => setFSupplier(e.target.value)} className="input-saas mt-1 w-full" placeholder="es. AutoParts" />
                </label>
                <label className="text-xs font-semibold text-slate-500">
                  Data installazione
                  <input type="date" value={fInstalledAt} onChange={(e) => setFInstalledAt(e.target.value)} className="input-saas mt-1 w-full" />
                </label>
              </>
            )}
          </div>

          <div className="flex gap-2 mt-4">
            <button
              type="button"
              disabled={saving || !fDate || (tab === "maintenance" && !fDesc) || (tab === "spare_parts" && !fPartName)}
              onClick={() => void handleAdd()}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
            >
              {saving ? "Salvataggio..." : "Salva"}
            </button>
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-500 hover:bg-slate-50">
              Annulla
            </button>
          </div>
        </div>
      ) : tab !== "km_logs" ? (
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="mb-4 rounded-xl border border-blue-300 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-100"
        >
          + Aggiungi
        </button>
      ) : null}

      {/* Lista record */}
      {loading ? (
        <div className="text-sm text-slate-400 py-8 text-center">Caricamento...</div>
      ) : records.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400 text-sm">
          Nessun record registrato.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
              <tr>
                {tab === "maintenance" && (
                  <>
                    <th className="px-4 py-3 text-left">Data</th>
                    <th className="px-4 py-3 text-left">Descrizione</th>
                    <th className="px-4 py-3 text-left">Officina</th>
                    <th className="px-4 py-3 text-right">Km</th>
                    <th className="px-4 py-3 text-right">Costo</th>
                    <th className="px-4 py-3" />
                  </>
                )}
                {tab === "fuel" && (
                  <>
                    <th className="px-4 py-3 text-left">Data</th>
                    <th className="px-4 py-3 text-left">Tipo</th>
                    <th className="px-4 py-3 text-left">Distributore</th>
                    <th className="px-4 py-3 text-right">Litri</th>
                    <th className="px-4 py-3 text-right">Km</th>
                    <th className="px-4 py-3 text-right">Costo</th>
                    <th className="px-4 py-3" />
                  </>
                )}
                {tab === "spare_parts" && (
                  <>
                    <th className="px-4 py-3 text-left">Data</th>
                    <th className="px-4 py-3 text-left">Pezzo</th>
                    <th className="px-4 py-3 text-left">Stato</th>
                    <th className="px-4 py-3 text-right">Qtà</th>
                    <th className="px-4 py-3 text-right">Costo</th>
                    <th className="px-4 py-3" />
                  </>
                )}
                {tab === "km_logs" && (
                  <>
                    <th className="px-4 py-3 text-left">Data/ora</th>
                    <th className="px-4 py-3 text-left">Autista</th>
                    <th className="px-4 py-3 text-right">Km partenza</th>
                    <th className="px-4 py-3 text-right">Km arrivo</th>
                    <th className="px-4 py-3 text-right">Percorsi</th>
                    <th className="px-4 py-3 text-left">Note</th>
                    <th className="px-4 py-3 text-left">Stato</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tab === "maintenance" && (records as Maintenance[]).map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{new Date(r.maintenance_date).toLocaleDateString("it-IT")}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{r.description}{r.notes ? <span className="text-xs text-slate-400 ml-1">({r.notes})</span> : null}</td>
                  <td className="px-4 py-3 text-slate-500">{r.provider ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-slate-500">{r.km_at_service != null ? r.km_at_service.toLocaleString("it-IT") : "—"}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-700">{r.cost != null ? `€${r.cost.toFixed(2)}` : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => void handleDelete(r.id)} className="text-xs text-slate-300 hover:text-rose-500">✕</button>
                  </td>
                </tr>
              ))}
              {tab === "fuel" && (records as Fuel[]).map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{new Date(r.fuel_date).toLocaleDateString("it-IT")}</td>
                  <td className="px-4 py-3"><span className="capitalize text-amber-700 font-semibold text-xs">{r.fuel_type ?? "—"}</span></td>
                  <td className="px-4 py-3 text-slate-500">{r.station ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-semibold text-slate-700">{r.liters != null ? `${r.liters.toFixed(1)} L` : "—"}</td>
                  <td className="px-4 py-3 text-right text-slate-500">{r.km_at_fuel != null ? r.km_at_fuel.toLocaleString("it-IT") : "—"}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-700">{r.cost != null ? `€${r.cost.toFixed(2)}` : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => void handleDelete(r.id)} className="text-xs text-slate-300 hover:text-rose-500">✕</button>
                  </td>
                </tr>
              ))}
              {tab === "spare_parts" && (records as SparePart[]).map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 text-slate-500 whitespace-nowrap">{new Date(r.order_date).toLocaleDateString("it-IT")}</td>
                  <td className="px-4 py-3 font-medium text-slate-800">{r.part_name}{r.supplier ? <span className="text-xs text-slate-400 ml-1">— {r.supplier}</span> : null}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${r.status === "installed" ? "bg-green-100 text-green-700" : r.status === "received" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"}`}>
                      {r.status === "installed" ? "Installato" : r.status === "received" ? "Ricevuto" : "Ordinato"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">{r.quantity}</td>
                  <td className="px-4 py-3 text-right font-semibold text-emerald-700">{r.cost != null ? `€${r.cost.toFixed(2)}` : "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => void handleDelete(r.id)} className="text-xs text-slate-300 hover:text-rose-500">✕</button>
                  </td>
                </tr>
              ))}
              {tab === "km_logs" && (records as unknown as KmLog[]).map((r) => {
                const km = r.end_km != null ? r.end_km - r.start_km : null;
                const isOpen = r.end_km == null;
                return (
                  <tr key={r.id} className={isOpen ? "bg-blue-50 hover:bg-blue-100" : "hover:bg-slate-50"}>
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap text-xs">
                      {new Date(r.start_at).toLocaleString("it-IT", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-800">{r.driver_name}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{r.start_km.toLocaleString("it-IT")}</td>
                    <td className="px-4 py-3 text-right text-slate-600">{r.end_km != null ? r.end_km.toLocaleString("it-IT") : "—"}</td>
                    <td className="px-4 py-3 text-right font-bold text-emerald-700">{km != null ? `+${km.toLocaleString("it-IT")}` : "—"}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{r.notes ?? "—"}</td>
                    <td className="px-4 py-3">
                      {isOpen ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">In corso</span>
                      ) : (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-green-100 text-green-700">Chiuso</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
