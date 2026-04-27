"use client";

import { useEffect, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type VerifyPayload = {
  ok: boolean;
  state: "valid" | "already_used" | "invalid" | "cancelled";
  message: string;
  bookingId: string | null;
  direction: "outbound" | "return" | null;
  qrCode: {
    service_date: string;
    status: string;
    used_at: string | null;
  } | null;
  booking: {
    customerName: string;
    busLabel: string | null;
    busCityOrigin: string | null;
  } | null;
};

type Props = {
  bookingId: string;
  direction: "outbound" | "return";
  token: string;
};

function stateStyles(state: VerifyPayload["state"]) {
  if (state === "valid") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (state === "already_used") return "border-slate-200 bg-slate-100 text-slate-700";
  if (state === "cancelled") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

function directionLabel(direction: Props["direction"]) {
  return direction === "outbound" ? "ANDATA" : "RITORNO";
}

export function BusQrVerifyCard({ bookingId, direction, token }: Props) {
  const [data, setData] = useState<VerifyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [markingUsed, setMarkingUsed] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      const res = await fetch(`/api/qr/bus/${bookingId}/${direction}/${token}`, { cache: "no-store" });
      const payload = await res.json().catch(() => null) as VerifyPayload | null;
      if (!active) return;
      setData(payload);
      setLoading(false);
    };
    void load();
    return () => { active = false; };
  }, [bookingId, direction, token]);

  const markUsed = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setActionMessage("Login richiesto per segnare il QR come usato.");
      return;
    }
    setMarkingUsed(true);
    setActionMessage(null);
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) {
      setMarkingUsed(false);
      setActionMessage("Apri il gestionale con un account assistenza per confermare la corsa.");
      return;
    }

    const res = await fetch(`/api/qr/bus/${bookingId}/${direction}/${token}/use`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const payload = await res.json().catch(() => null) as VerifyPayload | null;
    setMarkingUsed(false);
    if (!res.ok || !payload) {
      setActionMessage("Marcatura non riuscita.");
      return;
    }
    setData(payload);
    setActionMessage(payload.message);
  };

  return (
    <section className="min-h-screen bg-[radial-gradient(circle_at_top,#eff6ff,transparent_55%),linear-gradient(180deg,#f8fafc_0%,#eef2ff_100%)] px-4 py-8">
      <div className="mx-auto max-w-xl rounded-[28px] border border-white/80 bg-white/95 p-6 shadow-[0_18px_50px_rgba(15,39,68,0.12)] backdrop-blur">
        <div className="mb-5 flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-slate-400">Ischia Transfer Service</p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-900">Verifica QR Bus</h1>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-bold tracking-[0.2em] text-slate-600">
            {directionLabel(direction)}
          </span>
        </div>

        {loading ? (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            Verifica QR in corso...
          </div>
        ) : data ? (
          <div className="space-y-4">
            <div className={`rounded-2xl border px-4 py-4 ${stateStyles(data.state)}`}>
              <p className="text-xs font-bold uppercase tracking-[0.18em]">Esito</p>
              <p className="mt-2 text-2xl font-semibold">
                {data.state === "valid" ? "Valido" : data.state === "already_used" ? "Gia usato" : data.state === "cancelled" ? "Annullato" : "Non valido"}
              </p>
              <p className="mt-2 text-sm">{data.message}</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Cliente</span>
                <strong className="text-right text-slate-900">{data.booking?.customerName ?? "N/D"}</strong>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-slate-400">Data servizio</span>
                <strong className="text-slate-900">{data.qrCode?.service_date ?? "N/D"}</strong>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-slate-400">Linea / bus</span>
                <strong className="text-right text-slate-900">{data.booking?.busCityOrigin ?? data.booking?.busLabel ?? "N/D"}</strong>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-slate-400">Stato QR</span>
                <strong className="text-slate-900">{data.qrCode?.status ?? "N/D"}</strong>
              </div>
              {data.qrCode?.used_at && (
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-slate-400">Usato il</span>
                  <strong className="text-slate-900">{new Date(data.qrCode.used_at).toLocaleString("it-IT")}</strong>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void markUsed()}
              disabled={markingUsed || data.state !== "valid"}
              className="w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {markingUsed ? "Conferma in corso..." : "Segna come usato"}
            </button>

            {actionMessage && <p className="text-center text-sm text-slate-600">{actionMessage}</p>}
          </div>
        ) : (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-8 text-center text-sm text-amber-800">
            Impossibile leggere il QR.
          </div>
        )}
      </div>
    </section>
  );
}
