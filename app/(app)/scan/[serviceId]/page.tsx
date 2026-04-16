"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { QrCode } from "@/components/QrCode";

type ServiceInfo = {
  id: string;
  date: string;
  time: string;
  direction: string;
  customer_name: string;
  phone: string | null;
  pax: number;
  vessel: string | null;
  notes: string | null;
  status: string;
  hotel_name: string | null;
  meeting_point: string | null;
  outbound_time: string | null;
};

type AssignmentInfo = {
  vehicle_label: string;
  driver_name: string | null;
} | null;

async function accessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

const STATUS_LABEL: Record<string, string> = {
  new: "Nuovo",
  assigned: "Assegnato",
  partito: "Partito",
  arrivato: "Arrivato",
  completato: "Completato",
  problema: "Problema",
  cancelled: "Cancellato",
};

const STATUS_COLOR: Record<string, string> = {
  new: "bg-slate-100 text-slate-600 border-slate-200",
  assigned: "bg-blue-50 text-blue-700 border-blue-200",
  partito: "bg-amber-50 text-amber-700 border-amber-200",
  arrivato: "bg-teal-50 text-teal-700 border-teal-200",
  completato: "bg-emerald-50 text-emerald-700 border-emerald-200",
  problema: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-slate-50 text-slate-400 border-slate-200",
};

export default function ScanPage() {
  const { serviceId } = useParams<{ serviceId: string }>();

  const [service, setService] = useState<ServiceInfo | null>(null);
  const [assignment, setAssignment] = useState<AssignmentInfo>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showConfirm, setShowConfirm] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completedAt, setCompletedAt] = useState<string | null>(null);
  const [alreadyCompleted, setAlreadyCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = await accessToken();
      if (!token) { setError("Accesso non autorizzato. Effettua il login."); setLoading(false); return; }
      const res = await fetch(`/api/scan/${serviceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; service?: ServiceInfo; assignment?: AssignmentInfo } | null;
      if (cancelled) return;
      if (!res.ok || !data?.ok) { setError(data?.error ?? "Errore nel caricamento del servizio."); setLoading(false); return; }
      setService(data.service ?? null);
      setAssignment(data.assignment ?? null);
      if (data.service?.status === "completato") setAlreadyCompleted(true);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [serviceId]);

  async function confirmComplete() {
    setCompleting(true);
    const token = await accessToken();
    if (!token) { setCompleting(false); return; }
    const res = await fetch(`/api/scan/${serviceId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "complete" }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; already_completed?: boolean; completed_at?: string; error?: string } | null;
    setCompleting(false);
    setShowConfirm(false);
    if (data?.already_completed) {
      setAlreadyCompleted(true);
    } else if (data?.ok) {
      setCompletedAt(data.completed_at ?? new Date().toISOString());
      if (service) setService({ ...service, status: "completato" });
    } else {
      setError(data?.error ?? "Errore durante la conferma.");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-sm text-slate-400">Caricamento servizio...</p>
      </div>
    );
  }

  if (error && !service) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm w-full rounded-2xl border border-rose-200 bg-rose-50 px-6 py-8 text-center">
          <p className="text-2xl mb-2">⚠️</p>
          <p className="font-semibold text-rose-700">{error}</p>
        </div>
      </div>
    );
  }

  if (!service) return null;

  const dirLabel = service.direction === "arrival" ? "ARRIVO" : "PARTENZA";
  const dirColor = service.direction === "arrival" ? "bg-teal-600" : "bg-blue-600";

  return (
    <div className="min-h-screen bg-slate-50 pb-24">
      {/* Header */}
      <div className={`${dirColor} px-4 py-5 text-white`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-widest opacity-80">{dirLabel} · Porto</p>
            <h1 className="mt-1 text-2xl font-bold leading-tight">{service.customer_name}</h1>
          </div>
          <span className={`rounded-full border px-3 py-1 text-xs font-bold ${STATUS_COLOR[service.status] ?? "bg-slate-100 text-slate-500 border-slate-200"}`}>
            {STATUS_LABEL[service.status] ?? service.status}
          </span>
        </div>
      </div>

      <div className="mx-auto max-w-md px-4 py-5 space-y-4">

        {/* Already completed warning */}
        {(alreadyCompleted && !completedAt) && (
          <div className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-4">
            <p className="font-semibold text-amber-800">⚠ Servizio già marcato come completato</p>
            <p className="mt-1 text-sm text-amber-700">Questo servizio risulta già completato. Stai tentando una doppia scansione.</p>
          </div>
        )}

        {/* Success */}
        {completedAt && (
          <div className="rounded-2xl border border-emerald-300 bg-emerald-50 px-4 py-4">
            <p className="font-semibold text-emerald-800">✓ Servizio completato</p>
            <p className="mt-1 text-sm text-emerald-700">
              Confermato alle {new Date(completedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        )}

        {/* Info card */}
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 space-y-3">
          <Row label="Data" value={new Date(`${service.date}T00:00:00`).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} />
          <Row label="Orario" value={service.time?.slice(0, 5) ?? "—"} />
          {service.vessel && <Row label="Compagnia / Tratta" value={service.vessel} />}
          {service.outbound_time && <Row label="Orario mezzo" value={service.outbound_time} />}
          <Row label="Pax" value={String(service.pax)} />
          {service.phone && (
            <Row
              label="Telefono"
              value={
                <a href={`tel:${service.phone}`} className="text-blue-600 hover:underline font-medium">
                  {service.phone}
                </a>
              }
            />
          )}
          {service.hotel_name && <Row label="Destinazione" value={service.hotel_name} />}
          {service.meeting_point && <Row label="Meeting point" value={service.meeting_point} />}
        </div>

        {/* Assignment */}
        {assignment && (
          <div className="rounded-2xl border border-blue-100 bg-blue-50/50 px-4 py-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wide text-blue-500">Autista assegnato</p>
            <Row label="Autista" value={assignment.driver_name ?? "—"} />
            <Row label="Veicolo" value={assignment.vehicle_label} />
          </div>
        )}

        {/* Notes */}
        {service.notes && (
          <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-1">Note</p>
            <p className="text-sm text-slate-700 whitespace-pre-line">{service.notes}</p>
          </div>
        )}

        {/* QR code — per voucher/stampa */}
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-center print:border-0">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400 mb-3">QR Servizio</p>
          <div className="flex justify-center">
            <QrCode value={typeof window !== "undefined" ? `${window.location.origin}/scan/${serviceId}` : `/scan/${serviceId}`} size={160} />
          </div>
          <p className="mt-2 text-xs text-slate-400 font-mono break-all">{serviceId}</p>
          <button
            type="button"
            onClick={() => window.print()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 print:hidden"
          >
            🖨 Stampa voucher
          </button>
        </div>

        {/* Confirm button */}
        {!completedAt && !alreadyCompleted && service.status !== "completato" && service.status !== "cancelled" && (
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            className="w-full rounded-2xl bg-emerald-600 py-4 text-base font-bold text-white shadow-md hover:bg-emerald-700 active:scale-95 transition"
          >
            CONFERMA SERVIZIO COMPLETATO
          </button>
        )}
      </div>

      {/* Confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 px-4 pb-8">
          <div className="w-full max-w-md rounded-3xl bg-white px-6 py-6 shadow-xl">
            <h2 className="text-lg font-bold text-slate-800 mb-2">Confermi il completamento?</h2>
            <p className="text-sm text-slate-600 mb-6">
              Stai per marcare il servizio di <strong>{service.customer_name}</strong> come completato.
              Questa azione verrà registrata con il tuo nome e orario.
            </p>
            <div className="flex gap-3">
              <button
                type="button"
                disabled={completing}
                onClick={() => void confirmComplete()}
                className="flex-1 rounded-xl bg-emerald-600 py-3 text-sm font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
              >
                {completing ? "Conferma..." : "Sì, conferma"}
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="flex-1 rounded-xl border border-slate-200 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                Annulla
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-xs font-semibold text-slate-400">{label}</span>
      <span className="text-right text-sm font-medium text-slate-800">{value}</span>
    </div>
  );
}
