"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

// ── Tipi ─────────────────────────────────────────────────────────────────────

type PlaceType = "station" | "airport";

type BrunoService = {
  id: string;
  customer_name: string;
  pax: number;
  time: string;
  vessel: string;
  place_type: PlaceType;
  meeting_point: string | null;
  phone: string;
  hotel_name: string | null;
  notes: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getToken() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

function fmtDate(iso: string) {
  return new Date(iso + "T12:00:00").toLocaleDateString("it-IT", {
    weekday: "long", day: "numeric", month: "long",
  });
}

function PlaceBadge({ type, point }: { type: PlaceType; point: string | null }) {
  const label = point?.trim() || (type === "station" ? "Stazione" : "Aeroporto");
  return type === "station"
    ? <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">🚂 {label}</span>
    : <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">✈️ {label}</span>;
}

// ── Card singolo servizio ─────────────────────────────────────────────────────

function ServiceCard({ svc, showTime = true }: { svc: BrunoService; showTime?: boolean }) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      {showTime && (
        <div className="w-12 shrink-0 text-center">
          <span className="font-mono text-lg font-bold text-slate-800">{svc.time.slice(0, 5)}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-bold uppercase text-slate-900">{svc.customer_name}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">{svc.pax} pax</span>
          <PlaceBadge type={svc.place_type} point={svc.meeting_point} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-slate-600">
          {svc.hotel_name && <span>🏨 {svc.hotel_name}</span>}
          {!showTime && <span>⏰ {svc.time.slice(0, 5)}</span>}
          <span>📞 {svc.phone}</span>
          {svc.notes && <span className="text-slate-400">{svc.notes}</span>}
        </div>
      </div>
    </div>
  );
}

// ── Tab Arrivi ────────────────────────────────────────────────────────────────

function TabArrivi({ arrivals }: { arrivals: BrunoService[] }) {
  const sorted = [...arrivals].sort((a, b) => a.time.localeCompare(b.time));

  if (sorted.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
        <p className="text-lg font-semibold">Nessun arrivo da stazione/aeroporto</p>
        <p className="mt-1 text-sm">I servizi con provenienza stazione o aeroporto appariranno qui.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {sorted.length} servizi · Bruno ritira e porta al porto
      </p>
      {sorted.map((svc) => <ServiceCard key={svc.id} svc={svc} showTime />)}
    </div>
  );
}

// ── Tab Partenze ──────────────────────────────────────────────────────────────

function TabPartenze({ departures }: { departures: BrunoService[] }) {
  if (departures.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
        <p className="text-lg font-semibold">Nessuna partenza verso stazione/aeroporto</p>
        <p className="mt-1 text-sm">I servizi con destinazione stazione o aeroporto appariranno qui, raggruppati per traghetto.</p>
      </div>
    );
  }

  // Raggruppa per traghetto (vessel)
  const byVessel = departures.reduce<Record<string, BrunoService[]>>((acc, d) => {
    (acc[d.vessel] ??= []).push(d);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        {departures.length} servizi · Bruno ritira al porto e porta a stazione/aeroporto
      </p>
      {Object.entries(byVessel)
        .sort(([a], [b]) => {
          const ta = departures.find((d) => d.vessel === a)?.time ?? "";
          const tb = departures.find((d) => d.vessel === b)?.time ?? "";
          return ta.localeCompare(tb);
        })
        .map(([vessel, group]) => {
          const totalPax = group.reduce((s, d) => s + d.pax, 0);
          const earliestPickup = [...group].sort((a, b) => a.time.localeCompare(b.time))[0].time;
          return (
            <div key={vessel}>
              <div className="mb-2 flex items-center gap-3 rounded-xl bg-slate-800 px-4 py-2.5">
                <span className="text-lg">⛴</span>
                <div className="min-w-0 flex-1">
                  <span className="font-bold text-white">{vessel}</span>
                  <span className="ml-2 text-sm text-slate-400">pickup a partire dalle {earliestPickup.slice(0, 5)}</span>
                </div>
                <span className="rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-semibold text-slate-200">
                  {totalPax} pax
                </span>
              </div>
              <div className="space-y-2 pl-2">
                {group
                  .sort((a, b) => a.customer_name.localeCompare(b.customer_name))
                  .map((svc) => <ServiceCard key={svc.id} svc={svc} showTime={false} />)}
              </div>
            </div>
          );
        })}
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

type Tab = "arrivi" | "partenze";

export default function ListeBrunoPage() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [arrivals, setArrivals] = useState<BrunoService[]>([]);
  const [departures, setDepartures] = useState<BrunoService[]>([]);
  const [brunoEmail, setBrunoEmail] = useState("");
  const [savedBrunoEmail, setSavedBrunoEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("arrivi");
  const [showSendModal, setShowSendModal] = useState(false);
  const [senderNote, setSenderNote] = useState("");
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async (d: string) => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    setLoading(true);
    const res = await fetch(`/api/ops/liste-bruno?date=${d}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json().catch(() => null);
    if (body?.ok) {
      setArrivals(body.arrivals ?? []);
      setDepartures(body.departures ?? []);
      const email = body.brunoEmail ?? "";
      setBrunoEmail(email);
      setSavedBrunoEmail(email);
    }
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(date); }, [load, date]);

  const post = useCallback(async (action: string, data: Record<string, unknown>) => {
    const token = await getToken();
    if (!token) return null;
    const res = await fetch("/api/ops/liste-bruno", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, date, ...data }),
    });
    return res.json().catch(() => null);
  }, [date]);

  const handleSaveEmail = async () => {
    setSavingEmail(true);
    const body = await post("save_bruno_email", { bruno_email: brunoEmail });
    setSavingEmail(false);
    if (body?.ok) {
      setSavedBrunoEmail(brunoEmail);
      setMessage({ type: "ok", text: "Email di Bruno salvata." });
      setTimeout(() => setMessage(null), 3000);
    } else {
      setMessage({ type: "err", text: body?.error ?? "Errore salvataggio." });
    }
  };

  const handleSend = async () => {
    if (!brunoEmail.trim()) return;
    setSending(true);
    setMessage(null);
    const body = await post("send_email", { bruno_email: brunoEmail, sender_note: senderNote });
    setSending(false);
    if (body?.ok) {
      setShowSendModal(false);
      setSenderNote("");
      setMessage({ type: "ok", text: `Lista inviata a ${brunoEmail}` });
      setTimeout(() => setMessage(null), 5000);
    } else {
      setMessage({ type: "err", text: body?.error ?? "Errore invio." });
    }
  };

  const totalServices = arrivals.length + departures.length;
  const totalPax = [...arrivals, ...departures].reduce((s, svc) => s + svc.pax, 0);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Liste Bruno" subtitle="Arrivi e partenze da stazione / aeroporto" />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
        />

        {/* Riepilogo rapido */}
        {!loading && totalServices > 0 && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700">
              {totalServices} servizi · {totalPax} pax
            </span>
            <span className="text-slate-300">|</span>
            <span className="text-xs">{arrivals.length} arrivi · {departures.length} partenze</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          {/* Email Bruno */}
          <div className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1">
            <span className="text-xs text-slate-500 shrink-0">Bruno:</span>
            <input
              value={brunoEmail}
              onChange={(e) => setBrunoEmail(e.target.value)}
              placeholder="email@esempio.it"
              type="email"
              className="w-44 border-0 bg-transparent text-xs text-slate-700 focus:outline-none"
            />
            {brunoEmail !== savedBrunoEmail && (
              <button
                onClick={() => void handleSaveEmail()}
                disabled={savingEmail}
                className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-white hover:bg-slate-900 disabled:opacity-40">
                {savingEmail ? "..." : "Salva"}
              </button>
            )}
          </div>

          <button
            onClick={() => setShowSendModal(true)}
            disabled={totalServices === 0 || !brunoEmail.trim()}
            className="flex items-center gap-2 rounded-lg bg-pink-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-pink-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={!brunoEmail.trim() ? "Inserisci l'email di Bruno prima" : ""}>
            <span>✉️</span>
            Invia a Bruno
          </button>
        </div>
      </div>

      {/* Feedback */}
      {message && (
        <div className={`mx-6 mt-2 rounded-lg px-4 py-2 text-sm ${message.type === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
          {message.text}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 bg-white px-6">
        {([
          { key: "arrivi", label: "Arrivi", icon: "📥", count: arrivals.length },
          { key: "partenze", label: "Partenze", icon: "📤", count: departures.length },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "border-pink-500 text-pink-700"
                : "border-transparent text-slate-500 hover:text-slate-700"
            }`}>
            <span>{tab.icon}</span>
            {tab.label}
            {tab.count > 0 && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                activeTab === tab.key ? "bg-pink-100 text-pink-700" : "bg-slate-100 text-slate-600"
              }`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Contenuto */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {loading ? (
          <p className="text-sm text-slate-500">Caricamento...</p>
        ) : activeTab === "arrivi" ? (
          <TabArrivi arrivals={arrivals} />
        ) : (
          <TabPartenze departures={departures} />
        )}
      </div>

      {/* Modal invio */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-slate-900">Invia lista a Bruno</h2>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 space-y-1 text-sm">
              <p className="font-medium text-slate-700">{fmtDate(date)}</p>
              <p className="text-slate-500">{arrivals.length} arrivi · {departures.length} partenze · {totalPax} pax totali</p>
              <p className="text-slate-500">Destinatario: <strong>{brunoEmail}</strong></p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">
                Nota per Bruno (opzionale)
              </label>
              <textarea
                value={senderNote}
                onChange={(e) => setSenderNote(e.target.value)}
                placeholder="es. Attenzione: il volo FR 8542 ha 45 min di ritardo"
                rows={3}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowSendModal(false)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50">
                Annulla
              </button>
              <button
                onClick={() => void handleSend()}
                disabled={sending}
                className="flex-1 rounded-lg bg-pink-600 py-2 text-sm font-medium text-white hover:bg-pink-700 disabled:opacity-40">
                {sending ? "Invio in corso..." : "✉️ Invia ora"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
