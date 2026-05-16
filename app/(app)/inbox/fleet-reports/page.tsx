"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import Link from "next/link";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";

type Vehicle = { id: string; label: string; plate: string };

type FleetReport = {
  id: string;
  vehicle_id: string;
  reporter_name: string | null;
  description: string;
  severity: "low" | "medium" | "high" | "blocking";
  photo_urls: string[] | null;
  status: "open" | "acknowledged" | "resolved";
  created_at: string;
  vehicle: Vehicle | null;
};

const SEVERITY_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  low:      { label: "Basso",     bg: "bg-slate-100",  text: "text-slate-700" },
  medium:   { label: "Medio",     bg: "bg-yellow-100", text: "text-yellow-800" },
  high:     { label: "Alto",      bg: "bg-orange-100", text: "text-orange-800" },
  blocking: { label: "Bloccante", bg: "bg-red-100",    text: "text-red-800" },
};

const STATUS_BADGE: Record<string, { label: string; bg: string; text: string }> = {
  open:         { label: "Aperta",        bg: "bg-rose-100",   text: "text-rose-800" },
  acknowledged: { label: "Presa in carico", bg: "bg-blue-100", text: "text-blue-800" },
  resolved:     { label: "Risolta",       bg: "bg-green-100",  text: "text-green-800" },
};

function photoUrl(path: string) {
  if (path.startsWith("http")) return path;
  return `${SUPABASE_URL}/storage/v1/object/public/vehicle-damage-photos/${path}`;
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString("it-IT", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function FleetReportsPage() {
  const [reports, setReports]       = useState<FleetReport[]>([]);
  const [vehicles, setVehicles]     = useState<Vehicle[]>([]);
  const [loading, setLoading]       = useState(true);
  const [statusFilter, setStatusFilter] = useState<"open" | "acknowledged" | "all">("open");
  const [vehicleFilter, setVehicleFilter] = useState("");
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [acting, setActing]         = useState<string | null>(null);
  const [lightbox, setLightbox]     = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const { data: { session } } = await supabase!.auth.getSession();
    const token = session?.access_token;
    if (!token) { setLoading(false); return; }

    const params = new URLSearchParams({ status: statusFilter });
    if (vehicleFilter) params.set("vehicle_id", vehicleFilter);

    const res = await fetch(`/api/admin/fleet-reports?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json();
    setReports(json.reports ?? []);
    setVehicles(json.vehicles ?? []);
    setLoading(false);
  }

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [statusFilter, vehicleFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function doAction(id: string, action: "acknowledge" | "resolve") {
    setActing(id);
    const { data: { session } } = await supabase!.auth.getSession();
    const token = session?.access_token;
    if (!token) { setActing(null); return; }
    await fetch("/api/admin/fleet-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, id }),
    });
    setActing(null);
    void load();
  }

  const openCount = reports.filter((r) => r.status === "open").length;

  return (
    <div className="space-y-4">
      {/* Header strip */}
      <div className="card px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Segnalazioni veicoli</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Danni e anomalie segnalate dagli autisti via QR
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {openCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1 text-sm font-semibold text-rose-700">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
                {openCount} aperte
              </span>
            )}
            <Link
              href="/fleet-ops"
              className="btn-secondary px-3 py-1.5 text-sm"
            >
              ← Flotta e mezzi
            </Link>
          </div>
        </div>

        {/* Filtri */}
        <div className="mt-4 flex flex-wrap gap-3">
          <div className="flex rounded-xl border border-slate-200 bg-slate-50 p-0.5">
            {(["open", "acknowledged", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s as "open" | "acknowledged" | "all")}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  statusFilter === s
                    ? "bg-white shadow-sm text-slate-900"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {s === "open" ? "Aperte" : s === "acknowledged" ? "In carico" : "Tutte"}
              </button>
            ))}
          </div>

          <select
            value={vehicleFilter}
            onChange={(e) => setVehicleFilter(e.target.value)}
            className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700"
          >
            <option value="">Tutti i veicoli</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.label} ({v.plate})</option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void load()}
            className="btn-secondary px-3 py-1.5 text-xs"
            disabled={loading}
          >
            {loading ? "Caricamento…" : "Aggiorna"}
          </button>
        </div>
      </div>

      {/* Lista segnalazioni */}
      {loading ? (
        <div className="card px-5 py-8 text-center text-sm text-slate-400">Caricamento…</div>
      ) : reports.length === 0 ? (
        <div className="card px-5 py-10 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-2xl">✅</div>
          <p className="font-medium text-slate-700">Nessuna segnalazione trovata</p>
          <p className="mt-1 text-sm text-slate-400">
            {statusFilter === "open" ? "Non ci sono segnalazioni aperte al momento." : "Nessun risultato con i filtri selezionati."}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {reports.map((report) => {
            const sev = SEVERITY_BADGE[report.severity] ?? SEVERITY_BADGE.low;
            const sta = STATUS_BADGE[report.status] ?? STATUS_BADGE.open;
            const isExpanded = expanded === report.id;

            return (
              <div
                key={report.id}
                className={`card overflow-hidden transition ${
                  report.status === "open" ? "border-l-4 border-l-rose-400" : ""
                }`}
              >
                {/* Header row */}
                <button
                  type="button"
                  onClick={() => setExpanded(isExpanded ? null : report.id)}
                  className="w-full px-5 py-4 text-left"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 space-y-2">
                      {/* Badge row */}
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${sev.bg} ${sev.text}`}>
                          {sev.label}
                        </span>
                        <span className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-semibold ${sta.bg} ${sta.text}`}>
                          {sta.label}
                        </span>
                        {report.photo_urls?.length ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5" aria-hidden="true"><rect x="1" y="3" width="14" height="10" rx="2"/><circle cx="8" cy="8" r="2.5"/></svg>
                            {report.photo_urls.length} foto
                          </span>
                        ) : null}
                      </div>
                      {/* Descrizione */}
                      <p className="text-sm font-medium leading-relaxed text-slate-900 line-clamp-2">
                        {report.description}
                      </p>
                      {/* Metadata */}
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                        <span className="flex items-center gap-1">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 shrink-0" aria-hidden="true"><rect x="1" y="4" width="14" height="9" rx="1.5"/><path d="M4 4V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v1"/></svg>
                          {report.vehicle?.label ?? "—"}{report.vehicle?.plate ? ` · ${report.vehicle.plate}` : ""}
                        </span>
                        {report.reporter_name && (
                          <span className="flex items-center gap-1">
                            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 shrink-0" aria-hidden="true"><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5"/></svg>
                            {report.reporter_name}
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-3.5 w-3.5 shrink-0" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M8 5v3.5l2 1.5"/></svg>
                          {fmt(report.created_at)}
                        </span>
                      </div>
                    </div>
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform mt-1 ${isExpanded ? "rotate-180" : ""}`}
                      aria-hidden="true"
                    >
                      <path d="M3.5 6l4.5 4 4.5-4" />
                    </svg>
                  </div>
                </button>

                {/* Expanded */}
                {isExpanded && (
                  <div className="border-t border-slate-100 px-5 pb-5 pt-4 space-y-4">
                    {/* Foto */}
                    {report.photo_urls?.length ? (
                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Foto allegate</p>
                        <div className="flex flex-wrap gap-2">
                          {report.photo_urls.map((url, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setLightbox(url)}
                              className="group relative h-24 w-24 overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm transition hover:border-slate-400"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={photoUrl(url)}
                                alt={`Foto ${i + 1}`}
                                className="h-full w-full object-cover transition group-hover:scale-105"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                              <span className="absolute inset-0 flex items-center justify-center bg-black/0 text-white opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100 text-xs font-medium">
                                Apri
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-slate-400 italic">Nessuna foto allegata.</p>
                    )}

                    {/* Azioni */}
                    <div className="flex flex-wrap gap-2">
                      {report.vehicle && (
                        <Link
                          href={`/fleet-ops/vehicle/${report.vehicle_id}`}
                          className="btn-secondary px-3 py-1.5 text-sm"
                        >
                          Apri scheda veicolo →
                        </Link>
                      )}
                      {report.status === "open" && (
                        <button
                          type="button"
                          disabled={acting === report.id}
                          onClick={() => void doAction(report.id, "acknowledge")}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                        >
                          {acting === report.id ? "…" : "Prendi in carico"}
                        </button>
                      )}
                      {report.status !== "resolved" && (
                        <button
                          type="button"
                          disabled={acting === report.id}
                          onClick={() => void doAction(report.id, "resolve")}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-green-200 bg-green-50 px-3 py-1.5 text-sm font-medium text-green-700 transition hover:bg-green-100 disabled:opacity-50"
                        >
                          {acting === report.id ? "…" : "Segna come risolta"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightbox(null)}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={photoUrl(lightbox)}
              alt="Foto segnalazione"
              className="max-h-[85vh] max-w-[85vw] rounded-2xl object-contain shadow-2xl"
            />
            <button
              type="button"
              onClick={() => setLightbox(null)}
              className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 shadow-lg transition hover:bg-slate-100"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
