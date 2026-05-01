"use client";

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/lib/supabase/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type FleetTicket = {
  id: string;
  voucher_number: string;
  travel_date: string;
  vehicle_id: string;
  vehicle_type: string;
  plate: string;
  length_meters: number;
  route: string;
  ticket_mode: "round_trip" | "single";
  outbound_time: string | null;
  return_time: string | null;
  price_cents: number;
  price_id: string | null;
  status: "active" | "used" | "expired" | "cancelled";
  outbound_used: boolean;
  return_used: boolean;
  notes: string | null;
  created_at: string;
};

type FleetPrice = {
  id: string;
  vehicle_type: string;
  meters_from: number;
  meters_to: number;
  route: string;
  price_ar_cents: number;
  price_single_cents: number;
  valid_from: string;
  notes: string | null;
};

type Vehicle = {
  id: string;
  label: string;
  plate: string;
  vehicle_type: string;
  length_meters: number;
};

type DayReport = {
  date: string;
  count: number;
  round_trip: number;
  single: number;
  total_cents: number;
  by_route: Record<string, { count: number; total_cents: number }>;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUTE_LABELS: Record<string, string> = {
  pozzuoli_ischia: "Pozzuoli → Ischia",
  pozzuoli_casamicciola: "Pozzuoli → Casamicciola",
  napoli_ischia: "Napoli → Ischia",
  napoli_casamicciola: "Napoli → Casamicciola",
};

const VEHICLE_TYPE_LABELS: Record<string, string> = {
  taxi: "Taxi",
  bus: "Bus",
  camion: "Camion",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function getMondayOfWeek(iso: string): string {
  const d = new Date(iso);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function formatEur(cents: number) {
  return (cents / 100).toFixed(2) + " €";
}

function formatDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// ─── Toast ────────────────────────────────────────────────────────────────────

type Toast = { id: number; msg: string; ok: boolean };
let toastSeq = 0;

function ToastArea({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onDismiss(t.id)}
          className={`cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg ${
            t.ok ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active: "bg-blue-100 text-blue-700",
    used: "bg-green-100 text-green-700",
    expired: "bg-slate-100 text-slate-500",
    cancelled: "bg-red-100 text-red-600",
  };
  const labels: Record<string, string> = {
    active: "Attivo",
    used: "Completato",
    expired: "Scaduto",
    cancelled: "Annullato",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${map[status] ?? "bg-slate-100 text-slate-500"}`}>
      {labels[status] ?? status}
    </span>
  );
}

// ─── Ticket Card ──────────────────────────────────────────────────────────────

function TicketCard({
  ticket,
  onAction,
  vehicles,
}: {
  ticket: FleetTicket;
  onAction: (id: string, action: string, extra?: Record<string, unknown>) => void;
  vehicles: Vehicle[];
}) {
  const [showChangeModal, setShowChangeModal] = useState(false);
  const [newVehicleId, setNewVehicleId] = useState("");
  const [changeNotes, setChangeNotes] = useState("");
  const [changing, setChanging] = useState(false);

  const isCompleted = ticket.status === "used";
  const isCancelled = ticket.status === "cancelled";

  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        isCompleted
          ? "border-green-200 bg-green-50"
          : isCancelled
          ? "border-slate-200 bg-slate-50 opacity-60"
          : "border-slate-100 bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <span className="font-mono text-xs text-slate-400">{ticket.voucher_number}</span>
          <div className="mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-800">{ticket.plate}</span>
            <span className="text-xs text-slate-500">{VEHICLE_TYPE_LABELS[ticket.vehicle_type] ?? ticket.vehicle_type}</span>
            <span className="text-xs text-slate-500">{ticket.length_meters} m</span>
          </div>
          <div className="mt-1 text-sm text-slate-700">
            {ROUTE_LABELS[ticket.route] ?? ticket.route}
            {" · "}
            {ticket.ticket_mode === "round_trip" ? "A/R" : "Singola"}
          </div>
          <div className="mt-0.5 text-xs text-slate-500">
            {ticket.outbound_time && <span>Andata: {ticket.outbound_time}</span>}
            {ticket.ticket_mode === "round_trip" && ticket.return_time && (
              <span className="ml-2">Ritorno: {ticket.return_time}</span>
            )}
          </div>
          {ticket.notes && <div className="mt-1 text-xs text-slate-400 italic">{ticket.notes}</div>}
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={ticket.status} />
          <span className="text-sm font-bold text-slate-800">{formatEur(ticket.price_cents)}</span>
        </div>
      </div>

      {!isCancelled && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            disabled={ticket.outbound_used}
            onClick={() => onAction(ticket.id, "use_outbound")}
            className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
              ticket.outbound_used
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-blue-600 text-white hover:bg-blue-700"
            }`}
          >
            {ticket.outbound_used ? "Andata ✓" : "Marca andata"}
          </button>

          {ticket.ticket_mode === "round_trip" && (
            <button
              disabled={ticket.return_used}
              onClick={() => onAction(ticket.id, "use_return")}
              className={`rounded-xl px-3 py-1.5 text-xs font-semibold ${
                ticket.return_used
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              }`}
            >
              {ticket.return_used ? "Ritorno ✓" : "Marca ritorno"}
            </button>
          )}

          {ticket.status === "active" && (
            <>
              <button
                onClick={() => setShowChangeModal(true)}
                className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-amber-100 text-amber-700 hover:bg-amber-200"
              >
                Cambio targa
              </button>
              <button
                onClick={() => {
                  if (confirm("Annullare il biglietto?")) onAction(ticket.id, "cancel");
                }}
                className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-red-100 text-red-600 hover:bg-red-200"
              >
                Annulla
              </button>
            </>
          )}
        </div>
      )}

      {/* Cambio targa modal */}
      {showChangeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="mb-4 text-base font-semibold text-slate-800">Cambio targa</h3>
            <div className="mb-3">
              <label className="mb-1 block text-xs font-medium text-slate-600">Nuovo veicolo</label>
              <select
                value={newVehicleId}
                onChange={(e) => setNewVehicleId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">Seleziona veicolo…</option>
                {vehicles
                  .filter((v) => v.id !== ticket.vehicle_id)
                  .map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.plate} ({v.length_meters} m)
                    </option>
                  ))}
              </select>
            </div>
            <div className="mb-4">
              <label className="mb-1 block text-xs font-medium text-slate-600">Note</label>
              <textarea
                value={changeNotes}
                onChange={(e) => setChangeNotes(e.target.value)}
                rows={2}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowChangeModal(false)}
                className="rounded-xl px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
              >
                Annulla
              </button>
              <button
                disabled={!newVehicleId || changing}
                onClick={async () => {
                  setChanging(true);
                  await onAction(ticket.id, "plate_change", { new_vehicle_id: newVehicleId, notes: changeNotes });
                  setChanging(false);
                  setShowChangeModal(false);
                  setNewVehicleId("");
                  setChangeNotes("");
                }}
                className="rounded-xl px-4 py-2 text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {changing ? "Salvataggio…" : "Conferma cambio"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: Biglietti ───────────────────────────────────────────────────────────

function TabBiglietti({
  token,
  showToast,
}: {
  token: string | null;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const [date, setDate] = useState(todayIso());
  const [tickets, setTickets] = useState<FleetTicket[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [fVehicleId, setFVehicleId] = useState("");
  const [fRoute, setFRoute] = useState("");
  const [fMode, setFMode] = useState<"round_trip" | "single">("round_trip");
  const [fDate, setFDate] = useState(todayIso());
  const [fOutbound, setFOutbound] = useState("");
  const [fReturn, setFReturn] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fPrice, setFPrice] = useState<number | null>(null);
  const [fPriceLoading, setFPriceLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadTickets = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/medmar-fleet/tickets?date=${date}`, { headers });
      const data = await res.json();
      if (data.ok) setTickets(data.tickets);
    } finally {
      setLoading(false);
    }
  }, [token, date]);

  const loadVehicles = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/ops/vehicles", { headers });
    const data = await res.json();
    if (data.ok) {
      setVehicles(
        (data.vehicles as Vehicle[]).filter(
          (v) => v.vehicle_type && v.length_meters != null
        )
      );
    }
  }, [token]);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  useEffect(() => {
    loadVehicles();
  }, [loadVehicles]);

  // Auto-fetch price when vehicle+route selected
  useEffect(() => {
    if (!fVehicleId || !fRoute || !token) {
      setFPrice(null);
      return;
    }
    setFPriceLoading(true);
    fetch("/api/medmar-fleet/prices", { headers })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) return;
        const vehicle = vehicles.find((v) => v.id === fVehicleId);
        if (!vehicle) return;
        const match = (data.prices as FleetPrice[]).find(
          (p) =>
            p.vehicle_type === vehicle.vehicle_type &&
            p.route === fRoute &&
            p.meters_from <= vehicle.length_meters &&
            p.meters_to > vehicle.length_meters
        );
        if (match) {
          setFPrice(fMode === "round_trip" ? match.price_ar_cents : match.price_single_cents);
        } else {
          setFPrice(null);
        }
      })
      .finally(() => setFPriceLoading(false));
  }, [fVehicleId, fRoute, fMode, vehicles, token]);

  async function handleAction(id: string, action: string, extra?: Record<string, unknown>) {
    if (!token) return;
    const res = await fetch(`/api/medmar-fleet/tickets/${id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json();
    if (data.ok) {
      showToast(
        action === "plate_change"
          ? `Cambio targa eseguito${data.credit_cents > 0 ? ` — Credito: ${formatEur(data.credit_cents)}` : ""}`
          : "Operazione completata",
        true
      );
      loadTickets();
    } else {
      showToast(data.error ?? "Errore operazione", false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        vehicle_id: fVehicleId,
        route: fRoute,
        travel_date: fDate,
        ticket_mode: fMode,
        outbound_time: fOutbound || null,
        notes: fNotes || null,
      };
      if (fMode === "round_trip") body.return_time = fReturn || null;

      const res = await fetch("/api/medmar-fleet/tickets", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Biglietto ${data.ticket.voucher_number} emesso`, true);
        setShowForm(false);
        setFVehicleId("");
        setFRoute("");
        setFMode("round_trip");
        setFDate(todayIso());
        setFOutbound("");
        setFReturn("");
        setFNotes("");
        setFPrice(null);
        if (fDate === date) loadTickets();
      } else {
        showToast(data.error ?? "Errore emissione", false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {/* Date nav */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => setDate(addDays(date, -1))}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ‹
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
        />
        <button
          onClick={() => setDate(addDays(date, 1))}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ›
        </button>
        <button
          onClick={() => setDate(todayIso())}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
        >
          Oggi
        </button>
        <div className="ml-auto">
          <button
            onClick={() => setShowForm(true)}
            className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            + Nuova Emissione
          </button>
        </div>
      </div>

      {/* Ticket list */}
      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400">Caricamento…</div>
      ) : tickets.length === 0 ? (
        <div className="rounded-2xl bg-white border border-slate-100 p-8 text-center text-sm text-slate-400">
          Nessun biglietto per {formatDate(date)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} onAction={handleAction} vehicles={vehicles} />
          ))}
        </div>
      )}

      {/* Side panel form */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex">
          <div className="flex-1 bg-black/30" onClick={() => setShowForm(false)} />
          <div className="w-full max-w-md overflow-y-auto bg-white shadow-2xl p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-800">Nuova Emissione</h2>
              <button
                onClick={() => setShowForm(false)}
                className="text-slate-400 hover:text-slate-600 text-xl leading-none"
              >
                ×
              </button>
            </div>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              {/* Veicolo */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Veicolo</label>
                <select
                  required
                  value={fVehicleId}
                  onChange={(e) => setFVehicleId(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                >
                  <option value="">Seleziona veicolo…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.plate} ({VEHICLE_TYPE_LABELS[v.vehicle_type] ?? v.vehicle_type}, {v.length_meters} m)
                    </option>
                  ))}
                </select>
              </div>

              {/* Rotta */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Rotta</label>
                <select
                  required
                  value={fRoute}
                  onChange={(e) => setFRoute(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                >
                  <option value="">Seleziona rotta…</option>
                  {Object.entries(ROUTE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>

              {/* Modalità */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Modalità</label>
                <select
                  value={fMode}
                  onChange={(e) => setFMode(e.target.value as "round_trip" | "single")}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                >
                  <option value="round_trip">A/R</option>
                  <option value="single">Singola</option>
                </select>
              </div>

              {/* Data viaggio */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Data viaggio</label>
                <input
                  type="date"
                  required
                  value={fDate}
                  onChange={(e) => setFDate(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>

              {/* Ora andata */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Ora andata</label>
                <input
                  type="time"
                  value={fOutbound}
                  onChange={(e) => setFOutbound(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>

              {/* Ora ritorno (solo A/R) */}
              {fMode === "round_trip" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Ora ritorno</label>
                  <input
                    type="time"
                    value={fReturn}
                    onChange={(e) => setFReturn(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                  />
                </div>
              )}

              {/* Prezzo calcolato */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Prezzo calcolato</label>
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                  {fPriceLoading
                    ? "Calcolo…"
                    : fPrice !== null
                    ? formatEur(fPrice)
                    : "—  (seleziona veicolo e rotta)"}
                </div>
              </div>

              {/* Note */}
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Note</label>
                <textarea
                  value={fNotes}
                  onChange={(e) => setFNotes(e.target.value)}
                  rows={2}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? "Emissione…" : "Emetti Biglietto"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tab: Prezzario ───────────────────────────────────────────────────────────

function TabPrezzario({
  token,
  role,
  showToast,
}: {
  token: string | null;
  role: string | null;
  showToast: (msg: string, ok: boolean) => void;
}) {
  const [prices, setPrices] = useState<FleetPrice[]>([]);
  const [loading, setLoading] = useState(false);

  // Form
  const [fType, setFType] = useState("taxi");
  const [fMetersFrom, setFMetersFrom] = useState("");
  const [fMetersTo, setFMetersTo] = useState("");
  const [fRoute, setFRoute] = useState("");
  const [fAr, setFAr] = useState("");
  const [fSingle, setFSingle] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadPrices = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch("/api/medmar-fleet/prices", { headers });
      const data = await res.json();
      if (data.ok) setPrices(data.prices);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadPrices();
  }, [loadPrices]);

  const canEdit = role === "admin" || role === "supervisor";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/medmar-fleet/prices", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          vehicle_type: fType,
          meters_from: parseFloat(fMetersFrom),
          meters_to: parseFloat(fMetersTo),
          route: fRoute,
          price_ar_cents: Math.round(parseFloat(fAr) * 100),
          price_single_cents: Math.round(parseFloat(fSingle) * 100),
          notes: fNotes || null,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast("Prezzo salvato", true);
        setFType("taxi");
        setFMetersFrom("");
        setFMetersTo("");
        setFRoute("");
        setFAr("");
        setFSingle("");
        setFNotes("");
        loadPrices();
      } else {
        showToast(data.error ?? "Errore salvataggio", false);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      {/* Instructions */}
      <div className="mb-4 rounded-xl bg-blue-50 border border-blue-100 px-4 py-3 text-xs text-blue-700">
        Ogni nuovo prezzo sostituisce automaticamente quello precedente per la stessa combinazione tipo/rotta/metri.
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-white shadow-sm border border-slate-100 overflow-hidden mb-6">
        {loading ? (
          <div className="py-8 text-center text-sm text-slate-400">Caricamento…</div>
        ) : prices.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-400">Nessun prezzario configurato</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Tipo</th>
                  <th className="px-4 py-2.5 font-medium">Da (m)</th>
                  <th className="px-4 py-2.5 font-medium">A (m)</th>
                  <th className="px-4 py-2.5 font-medium">Rotta</th>
                  <th className="px-4 py-2.5 font-medium">Prezzo A/R</th>
                  <th className="px-4 py-2.5 font-medium">Prezzo Singola</th>
                  <th className="px-4 py-2.5 font-medium">Valido dal</th>
                  <th className="px-4 py-2.5 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((p) => (
                  <tr key={p.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5">{VEHICLE_TYPE_LABELS[p.vehicle_type] ?? p.vehicle_type}</td>
                    <td className="px-4 py-2.5">{p.meters_from}</td>
                    <td className="px-4 py-2.5">{p.meters_to}</td>
                    <td className="px-4 py-2.5">{ROUTE_LABELS[p.route] ?? p.route}</td>
                    <td className="px-4 py-2.5 font-semibold">{formatEur(p.price_ar_cents)}</td>
                    <td className="px-4 py-2.5 font-semibold">{formatEur(p.price_single_cents)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{formatDate(p.valid_from)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-400">{p.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add form */}
      {canEdit && (
        <div className="rounded-2xl bg-white shadow-sm border border-slate-100 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700">+ Nuovo prezzo</h3>
          <form onSubmit={handleSubmit} className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Tipo veicolo</label>
              <select
                value={fType}
                onChange={(e) => setFType(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="taxi">Taxi</option>
                <option value="bus">Bus</option>
                <option value="camion">Camion</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Da (m)</label>
              <input
                type="number"
                step="0.01"
                required
                value={fMetersFrom}
                onChange={(e) => setFMetersFrom(e.target.value)}
                placeholder="es. 0"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">A (m)</label>
              <input
                type="number"
                step="0.01"
                required
                value={fMetersTo}
                onChange={(e) => setFMetersTo(e.target.value)}
                placeholder="es. 6"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Rotta</label>
              <select
                required
                value={fRoute}
                onChange={(e) => setFRoute(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              >
                <option value="">Seleziona…</option>
                {Object.entries(ROUTE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Prezzo A/R (€)</label>
              <input
                type="number"
                step="0.01"
                required
                value={fAr}
                onChange={(e) => setFAr(e.target.value)}
                placeholder="es. 45.00"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">Prezzo Singola (€)</label>
              <input
                type="number"
                step="0.01"
                required
                value={fSingle}
                onChange={(e) => setFSingle(e.target.value)}
                placeholder="es. 30.00"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div className="col-span-2 sm:col-span-1">
              <label className="mb-1 block text-xs font-medium text-slate-500">Note</label>
              <input
                type="text"
                value={fNotes}
                onChange={(e) => setFNotes(e.target.value)}
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={submitting}
                className="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? "Salvataggio…" : "Salva prezzo"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ─── Tab: Report ──────────────────────────────────────────────────────────────

function TabReport({ token }: { token: string | null }) {
  const [weekStart, setWeekStart] = useState(getMondayOfWeek(todayIso()));
  const [reportData, setReportData] = useState<{
    days: DayReport[];
    route_totals: Record<string, { count: number; total_cents: number }>;
    grand_total_cents: number;
    grand_count: number;
    total_round_trip: number;
    total_single: number;
    week_end: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};

  const loadReport = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/medmar-fleet/report?week_start=${weekStart}`, { headers });
      const data = await res.json();
      if (data.ok) setReportData(data);
    } finally {
      setLoading(false);
    }
  }, [token, weekStart]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));

  return (
    <div>
      {/* Week nav */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={prevWeek}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ‹ Settimana prec.
        </button>
        <span className="text-sm font-medium text-slate-700">
          {formatDate(weekStart)} — {reportData ? formatDate(reportData.week_end) : "…"}
        </span>
        <button
          onClick={nextWeek}
          className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Settimana succ. ›
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-sm text-slate-400">Caricamento…</div>
      ) : reportData ? (
        <>
          {/* Summary cards */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-2xl bg-white border border-slate-100 p-4 shadow-sm">
              <div className="text-xs text-slate-500 mb-1">Totale biglietti</div>
              <div className="text-2xl font-bold text-slate-800">{reportData.grand_count}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 p-4 shadow-sm">
              <div className="text-xs text-slate-500 mb-1">Totale incassato</div>
              <div className="text-2xl font-bold text-green-700">{formatEur(reportData.grand_total_cents)}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 p-4 shadow-sm">
              <div className="text-xs text-slate-500 mb-1">A/R</div>
              <div className="text-2xl font-bold text-indigo-700">{reportData.total_round_trip}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 p-4 shadow-sm">
              <div className="text-xs text-slate-500 mb-1">Singole</div>
              <div className="text-2xl font-bold text-slate-700">{reportData.total_single}</div>
            </div>
          </div>

          {/* By route */}
          {Object.keys(reportData.route_totals).length > 0 && (
            <div className="mb-4 rounded-2xl bg-white border border-slate-100 p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">Suddivisione per rotta</h3>
              <div className="flex flex-col gap-2">
                {Object.entries(reportData.route_totals).map(([route, t]) => (
                  <div key={route} className="flex justify-between text-sm">
                    <span className="text-slate-600">{ROUTE_LABELS[route] ?? route}</span>
                    <span>
                      <span className="font-semibold">{t.count}</span>{" "}
                      <span className="text-slate-400 text-xs">biglietti</span>{" "}
                      <span className="ml-2 font-bold text-green-700">{formatEur(t.total_cents)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Daily table */}
          <div className="rounded-2xl bg-white border border-slate-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-4 py-2.5 font-medium">Data</th>
                  <th className="px-4 py-2.5 font-medium">N° biglietti</th>
                  <th className="px-4 py-2.5 font-medium">A/R</th>
                  <th className="px-4 py-2.5 font-medium">Singole</th>
                  <th className="px-4 py-2.5 font-medium">Totale</th>
                </tr>
              </thead>
              <tbody>
                {reportData.days.map((day) => (
                  <tr key={day.date} className="border-b border-slate-50 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-2.5 font-medium">{formatDate(day.date)}</td>
                    <td className="px-4 py-2.5">{day.count || "—"}</td>
                    <td className="px-4 py-2.5">{day.round_trip || "—"}</td>
                    <td className="px-4 py-2.5">{day.single || "—"}</td>
                    <td className="px-4 py-2.5 font-semibold text-green-700">
                      {day.total_cents > 0 ? formatEur(day.total_cents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="py-8 text-center text-sm text-slate-400">Nessun dato disponibile</div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function MedmarFleetPage() {
  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<"biglietti" | "prezzario" | "report">("biglietti");
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, []);

  // Get role from memberships
  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session) return;
      const { data: mems } = await supabase!
        .from("memberships")
        .select("role")
        .eq("user_id", data.session.user.id)
        .limit(1);
      if (mems && mems.length > 0) setRole(mems[0].role);
    });
  }, []);

  function showToast(msg: string, ok: boolean) {
    const id = ++toastSeq;
    setToasts((prev) => [...prev, { id, msg, ok }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }

  const tabs: Array<{ key: "biglietti" | "prezzario" | "report"; label: string; adminOnly?: boolean }> = [
    { key: "biglietti", label: "Biglietti" },
    { key: "prezzario", label: "Prezzario", adminOnly: true },
    { key: "report", label: "Report" },
  ];

  const visibleTabs = tabs.filter((t) => {
    if (!t.adminOnly) return true;
    return role === "admin" || role === "supervisor";
  });

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <div className="mx-auto w-full max-w-5xl px-4 py-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-xl font-bold text-slate-800">Medmar Flotta Veicoli</h1>
          <p className="mt-1 text-sm text-slate-500">Gestione biglietti traghetto per veicoli</p>
        </div>

        {/* Tabs */}
        <div className="mb-6 flex gap-2">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "bg-blue-600 text-white"
                  : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        {tab === "biglietti" && (
          <TabBiglietti token={token} showToast={showToast} />
        )}
        {tab === "prezzario" && (
          <TabPrezzario token={token} role={role} showToast={showToast} />
        )}
        {tab === "report" && (
          <TabReport token={token} />
        )}
      </div>

      {/* Toasts */}
      <ToastArea toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </div>
  );
}
