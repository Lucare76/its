"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type BookingRow = {
  id: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  phone: string | null;
  pax: number;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  booking_service_kind: string | null;
  approval_status: string | null;
  status: string | null;
  created_at: string;
  hotels: { name: string } | null;
  agencies: { name: string } | null;
  approval_token: string | null;
};

type CancelLegs = "arrival" | "departure" | "both";

type CancelState = {
  serviceId: string;
  customerName: string;
  legs: CancelLegs;
  penaltyCents: number;
  penaltyNote: string;
};

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function kindLabel(kind: string | null) {
  const map: Record<string, string> = {
    transfer_port_hotel:            "Transfer Porto",
    transfer_airport_hotel:         "Transfer Aeroporto",
    transfer_airport_hotel_exclusive: "Transfer Aeroporto ×",
    transfer_train_hotel:           "Transfer Stazione",
    transfer_train_hotel_exclusive: "Transfer Stazione ×",
    bus_city_hotel:                 "Bus da città",
    excursion:                      "Escursione",
    formula_snav:                   "Formula SNAV",
    formula_medmar_napoli:          "Formula MEDMAR Napoli",
    formula_medmar_pozzuoli:        "Formula MEDMAR Pozzuoli",
  };
  return kind ? (map[kind] ?? kind) : "—";
}

// ---------------------------------------------------------------------------
// CancelPanel — modale inline per cancellazione con penale
// ---------------------------------------------------------------------------
function CancelPanel({
  draft,
  onChangeDraft,
  cancelling,
  cancelMessage,
  onConfirm,
  onClose,
}: {
  draft: CancelState;
  onChangeDraft: (patch: Partial<CancelState>) => void;
  cancelling: boolean;
  cancelMessage: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [penaltyStr, setPenaltyStr] = useState(() =>
    draft.penaltyCents > 0 ? (draft.penaltyCents / 100).toFixed(2) : ""
  );

  return (
    <div className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-rose-900">
          Cancellazione — {draft.customerName}
        </p>
        <button type="button" onClick={onClose} className="text-rose-400 hover:text-rose-700 text-lg leading-none">×</button>
      </div>

      {/* Tratte */}
      <div>
        <p className="text-xs font-semibold text-rose-700 mb-2">Tratta da cancellare</p>
        <div className="flex flex-wrap gap-2">
          {(["arrival", "departure", "both"] as CancelLegs[]).map((leg) => {
            const labels: Record<CancelLegs, string> = {
              arrival: "Solo andata",
              departure: "Solo ritorno",
              both: "Andata + Ritorno",
            };
            return (
              <button
                key={leg}
                type="button"
                onClick={() => onChangeDraft({ legs: leg })}
                className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                  draft.legs === leg
                    ? "border-rose-600 bg-rose-600 text-white"
                    : "border-rose-200 bg-white text-rose-700 hover:bg-rose-100"
                }`}
              >
                {labels[leg]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Penale */}
      <div>
        <label className="text-xs font-semibold text-rose-700">
          Penale (€) — lascia 0 per nessuna penale
        </label>
        <div className="mt-1 flex items-center gap-0 rounded-xl border border-rose-200 bg-white focus-within:border-rose-400 focus-within:ring-2 focus-within:ring-rose-100 transition-all min-h-[42px] overflow-hidden w-40">
          <span className="px-3 text-rose-500 font-semibold text-sm shrink-0 select-none">€</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={penaltyStr}
            onChange={(e) => {
              const raw = e.target.value.replace(",", ".").replace(/[^0-9.]/g, "");
              setPenaltyStr(raw);
              const v = parseFloat(raw);
              onChangeDraft({ penaltyCents: isNaN(v) ? 0 : Math.round(v * 100) });
            }}
            onBlur={() => {
              const v = parseFloat(penaltyStr.replace(",", "."));
              if (!isNaN(v) && v > 0) {
                const rounded = Math.round(v * 2) / 2;
                setPenaltyStr(rounded.toFixed(2));
                onChangeDraft({ penaltyCents: Math.round(rounded * 100) });
              } else {
                setPenaltyStr("");
                onChangeDraft({ penaltyCents: 0 });
              }
            }}
            className="flex-1 bg-transparent outline-none text-sm py-2 pr-3 min-w-0"
          />
        </div>
        {draft.legs === "both" || draft.penaltyCents > 0 ? (
          <p className="mt-1 text-[11px] text-rose-600">
            {draft.legs === "both"
              ? "L'agenzia riceverà una email di conferma cancellazione."
              : "Verrà inviata email all'agenzia con l'importo della penale."}
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-rose-400">
            Nessuna penale — nessuna email inviata all&apos;agenzia.
          </p>
        )}
      </div>

      {/* Note penale */}
      {draft.penaltyCents > 0 && (
        <div>
          <label className="text-xs font-semibold text-rose-700">
            Note penale (facoltativo)
          </label>
          <textarea
            value={draft.penaltyNote}
            onChange={(e) => onChangeDraft({ penaltyNote: e.target.value })}
            className="input-saas mt-1 min-h-[60px] text-sm w-full"
            placeholder="es. Cancellazione < 48h da policy contrattuale"
          />
        </div>
      )}

      {cancelMessage && (
        <p className={`text-xs font-semibold ${cancelMessage.startsWith("Cancellazione") ? "text-emerald-700" : "text-rose-700"}`}>
          {cancelMessage}
        </p>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          disabled={cancelling}
          className="rounded-xl bg-rose-700 px-5 py-2 text-sm font-bold text-white hover:bg-rose-800 disabled:opacity-60 transition"
        >
          {cancelling ? "Annullamento..." : "Conferma cancellazione"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl border border-rose-200 px-4 py-2 text-sm font-medium text-rose-700 hover:bg-rose-100 transition"
        >
          Annulla
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pagina principale
// ---------------------------------------------------------------------------
export default function AgencyRequestsPage() {
  const [loading, setLoading]   = useState(true);
  const [rows, setRows]         = useState<BookingRow[]>([]);
  const [error, setError]       = useState<string | null>(null);
  const [filter, setFilter]     = useState<"pending" | "all">("pending");
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Stato cancellazione
  const [cancelDraft, setCancelDraft]       = useState<CancelState | null>(null);
  const [cancelling, setCancelling]         = useState(false);
  const [cancelMessage, setCancelMessage]   = useState("");

  // Stato rigenera token
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const session = await getClientSessionContext();
      if (!active) return;
      if (!hasSupabaseEnv || !supabase || !session.tenantId) {
        setError("Configurazione non disponibile.");
        setLoading(false);
        return;
      }
      if (session.role !== "admin" && session.role !== "operator") {
        setError("Accesso non autorizzato.");
        setLoading(false);
        return;
      }

      const { data: sd } = await supabase.auth.getSession();
      const tk = sd.session?.access_token ?? null;
      if (tk) setAccessToken(tk);

      let q = supabase
        .from("services")
        .select("id,customer_name,customer_first_name,customer_last_name,phone,pax,arrival_date,arrival_time,departure_date,departure_time,booking_service_kind,approval_status,status,created_at,hotels(name),agencies(name)")
        .eq("tenant_id", session.tenantId)
        .not("approval_status", "is", null)
        .order("created_at", { ascending: false })
        .limit(200);

      if (filter === "pending") {
        q = q.eq("approval_status", "pending_operator");
      }

      const { data, error: err } = await q;
      if (!active) return;
      if (err) { setError(err.message); setLoading(false); return; }

      // Per ogni servizio, cerca il token di approvazione attivo
      const serviceIds = (data ?? []).map((r) => r.id);
      let tokenMap: Record<string, string> = {};
      if (serviceIds.length > 0) {
        const { data: tokens } = await supabase
          .from("booking_approval_tokens")
          .select("service_id, token")
          .in("service_id", serviceIds)
          .is("used_at", null)
          .order("created_at", { ascending: false });
        for (const t of tokens ?? []) {
          if (t.service_id && t.token && !tokenMap[t.service_id]) {
            tokenMap[t.service_id] = t.token;
          }
        }
      }

      setRows(
        (data ?? []).map((r) => ({
          ...r,
          hotels: Array.isArray(r.hotels) ? r.hotels[0] ?? null : r.hotels,
          agencies: Array.isArray(r.agencies) ? r.agencies[0] ?? null : r.agencies,
          approval_token: tokenMap[r.id] ?? null,
        })) as BookingRow[]
      );
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [filter]);

  const pending   = rows.filter((r) => r.approval_status === "pending_operator");
  const confirmed = rows.filter((r) => r.approval_status === "confirmed");
  const rejected  = rows.filter((r) => r.approval_status === "rejected");

  const openCancel = (row: BookingRow) => {
    setCancelMessage("");
    setCancelDraft({
      serviceId:    row.id,
      customerName: row.customer_first_name && row.customer_last_name
        ? `${row.customer_first_name} ${row.customer_last_name}`
        : row.customer_name,
      legs:         "both",
      penaltyCents: 0,
      penaltyNote:  "",
    });
  };

  const doCancel = async () => {
    if (!cancelDraft || !accessToken) return;
    setCancelling(true);
    setCancelMessage("");
    const res = await fetch("/api/agency/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({
        service_id:    cancelDraft.serviceId,
        cancel_legs:   cancelDraft.legs,
        penalty_cents: cancelDraft.penaltyCents,
        penalty_note:  cancelDraft.penaltyNote || undefined,
      }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; already_cancelled?: boolean; email_sent?: boolean; error?: string } | null;
    setCancelling(false);
    if (!res.ok) {
      setCancelMessage(body?.error ?? "Errore durante la cancellazione.");
      return;
    }
    const emailMsg = body?.email_sent ? " Email inviata all'agenzia." : "";
    setCancelMessage(`Cancellazione confermata.${emailMsg}`);
    // Aggiorna lo stato nella lista
    setRows((prev) =>
      prev.map((r) => r.id === cancelDraft.serviceId ? { ...r, status: "cancelled" } : r)
    );
    // Chiudi dopo 2 secondi
    setTimeout(() => { setCancelDraft(null); setCancelMessage(""); }, 2200);
  };

  const doRegenerateToken = async (serviceId: string) => {
    if (!accessToken) return;
    setRegeneratingId(serviceId);
    const res = await fetch("/api/ops/regenerate-approval-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ service_id: serviceId }),
    });
    const body = await res.json().catch(() => null) as { ok?: boolean; token?: string; error?: string } | null;
    setRegeneratingId(null);
    if (!res.ok || !body?.token) return;
    setRows((prev) =>
      prev.map((r) => r.id === serviceId ? { ...r, approval_token: body.token! } : r)
    );
  };

  return (
    <section className="mx-auto max-w-5xl page-section">
      <div className="section-head">
        <h1 className="section-title">Richieste prenotazioni agenzie</h1>
        <p className="section-subtitle">Elenco prenotazioni inviate dalle agenzie. Approva, rifiuta o cancella con penale.</p>
      </div>

      {/* Filtri + counter */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          type="button"
          onClick={() => setFilter("pending")}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${filter === "pending" ? "bg-rose-600 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        >
          In attesa {pending.length > 0 && filter !== "pending" ? `(${pending.length})` : ""}
        </button>
        <button
          type="button"
          onClick={() => setFilter("all")}
          className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${filter === "all" ? "bg-slate-800 text-white" : "bg-white border border-slate-200 text-slate-600 hover:bg-slate-50"}`}
        >
          Tutte
        </button>
        {filter === "all" && (
          <span className="text-xs text-slate-400">
            {pending.length} in attesa · {confirmed.length} confermate · {rejected.length} rifiutate
          </span>
        )}
      </div>

      {loading && <p className="text-sm text-slate-500">Caricamento...</p>}
      {error && <p className="text-sm text-rose-600">{error}</p>}

      {!loading && !error && rows.length === 0 && (
        <div className="card p-8 text-center text-slate-400 text-sm">
          {filter === "pending" ? "Nessuna prenotazione in attesa di approvazione." : "Nessuna prenotazione trovata."}
        </div>
      )}

      {!loading && rows.length > 0 && (
        <div className="space-y-3">
          {rows.map((row) => {
            const customerName = row.customer_first_name && row.customer_last_name
              ? `${row.customer_first_name} ${row.customer_last_name}`
              : row.customer_name;
            const isPending    = row.approval_status === "pending_operator";
            const isConfirmed  = row.approval_status === "confirmed";
            const isCancelled  = row.status === "cancelled";
            const showCancelPanel = cancelDraft?.serviceId === row.id;

            return (
              <div
                key={row.id}
                className={`card p-4 flex flex-col gap-3 ${isPending ? "border-amber-200 bg-amber-50/40" : ""} ${isCancelled ? "opacity-60" : ""}`}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
                  {/* Status indicator */}
                  <div className="shrink-0 pt-0.5 flex flex-wrap gap-1.5">
                    {isPending && <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 px-2.5 py-1 text-xs font-semibold text-amber-800">Attesa</span>}
                    {isConfirmed && !isCancelled && <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 border border-emerald-300 px-2.5 py-1 text-xs font-semibold text-emerald-800">Confermata</span>}
                    {row.approval_status === "rejected" && <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 border border-rose-300 px-2.5 py-1 text-xs font-semibold text-rose-800">Rifiutata</span>}
                    {isCancelled && <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600">Annullata</span>}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-800">{customerName}</span>
                      {row.phone && <span className="text-xs text-slate-500">{row.phone}</span>}
                      <span className="text-xs text-slate-400">· {row.pax} pax</span>
                    </div>
                    <div className="text-sm text-slate-600">
                      <span className="font-medium">{kindLabel(row.booking_service_kind)}</span>
                      {row.hotels?.name && <span className="text-slate-400"> → {row.hotels.name}</span>}
                    </div>
                    <div className="text-xs text-slate-500">
                      Arrivo: <span className="font-medium">{fmtDate(row.arrival_date)} {row.arrival_time?.slice(0, 5) ?? ""}</span>
                      {" · "}
                      Rientro: <span className="font-medium">{fmtDate(row.departure_date)} {row.departure_time?.slice(0, 5) ?? ""}</span>
                    </div>
                    {row.agencies?.name && (
                      <div className="text-xs text-slate-400">Agenzia: {row.agencies.name}</div>
                    )}
                    <div className="text-xs text-slate-300">Ricevuta il {new Date(row.created_at).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}</div>
                  </div>

                  {/* Azioni */}
                  <div className="shrink-0 flex flex-col gap-2 items-end">
                    {isPending && row.approval_token && (
                      <Link
                        href={`/operator/approve/${row.approval_token}`}
                        className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-bold text-white hover:bg-indigo-700 transition"
                      >
                        Gestisci →
                      </Link>
                    )}
                    {isPending && !row.approval_token && (
                      <button
                        type="button"
                        disabled={regeneratingId === row.id}
                        onClick={() => void doRegenerateToken(row.id)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100 disabled:opacity-60 transition"
                      >
                        {regeneratingId === row.id ? "Invio..." : "↺ Rigenera link"}
                      </button>
                    )}
                    {/* Bottone cancella — visibile solo se non già cancellato */}
                    {!isCancelled && (
                      <button
                        type="button"
                        onClick={() => {
                          if (showCancelPanel) {
                            setCancelDraft(null);
                            setCancelMessage("");
                          } else {
                            openCancel(row);
                          }
                        }}
                        className={`rounded-xl border px-3 py-1.5 text-xs font-semibold transition ${
                          showCancelPanel
                            ? "border-rose-400 bg-rose-100 text-rose-800"
                            : "border-slate-200 bg-white text-slate-600 hover:border-rose-300 hover:text-rose-700"
                        }`}
                      >
                        {showCancelPanel ? "Chiudi" : "Cancella"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Pannello cancellazione inline */}
                {showCancelPanel && cancelDraft && (
                  <CancelPanel
                    draft={cancelDraft}
                    onChangeDraft={(patch) => setCancelDraft((d) => d ? { ...d, ...patch } : d)}
                    cancelling={cancelling}
                    cancelMessage={cancelMessage}
                    onConfirm={() => void doCancel()}
                    onClose={() => { setCancelDraft(null); setCancelMessage(""); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
