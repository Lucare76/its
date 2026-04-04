"use client";

import { useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { SERVICE_STATUS_LABELS, SERVICE_TYPE_LABELS } from "@/lib/ui-labels";

type ServiceTypeFilter = "all" | "transfer" | "bus_tour";
type StatusFilter = "new" | "assigned" | "partito" | "arrivato" | "completato" | "problema" | "cancelled" | "needs_review";

const statusOptions: StatusFilter[] = ["new", "assigned", "partito", "arrivato", "completato", "problema", "cancelled", "needs_review"];

interface ExportServicesButtonProps {
  defaultDateFrom: string;
  defaultDateTo: string;
  className?: string;
}

export function ExportServicesButton({ defaultDateFrom, defaultDateTo, className }: ExportServicesButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState(defaultDateFrom);
  const [dateTo, setDateTo] = useState(defaultDateTo);
  const [statusFilters, setStatusFilters] = useState<StatusFilter[]>([]);
  const [serviceType, setServiceType] = useState<ServiceTypeFilter>("all");
  const [ship, setShip] = useState("");
  const [zone, setZone] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const isInvalidDateRange = useMemo(() => {
    if (!dateFrom || !dateTo) return true;
    return dateFrom > dateTo;
  }, [dateFrom, dateTo]);

  const handleExport = async () => {
    if (!hasSupabaseEnv || !supabase) {
      setMessage("Esportazione disponibile solo con Supabase configurato.");
      return;
    }
    if (isInvalidDateRange) {
      setMessage("Intervallo date non valido.");
      return;
    }

    setIsLoading(true);
    setMessage(null);

    try {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session?.access_token) {
        setMessage("Sessione non valida. Effettua nuovamente il login.");
        setIsLoading(false);
        return;
      }

      const params = new URLSearchParams({
        dateFrom,
        dateTo,
        serviceType,
        ship,
        zone,
        search
      });
      for (const status of statusFilters) {
        params.append("status", status);
      }

      const response = await fetch(`/api/exports/services.xlsx?${params.toString()}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${data.session.access_token}`
        }
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setMessage(body?.error ?? "Esportazione fallita.");
        setIsLoading(false);
        return;
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition");
      const match = disposition?.match(/filename=\"?([^"]+)\"?/i);
      const filename = match?.[1] ?? `services-export-${dateFrom}-${dateTo}.xlsx`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      setMessage("Esportazione completata.");
      setIsOpen(false);
    } catch {
      setMessage("Errore durante l'esportazione.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className={className}>
      <button type="button" onClick={() => setIsOpen((prev) => !prev)} className="btn-secondary">
        Esporta
      </button>
      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="card w-full max-w-3xl space-y-4 p-4">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="text-base font-semibold text-text">Esporta Excel (.xlsx)</h3>
              <button type="button" onClick={() => setIsOpen(false)} className="btn-secondary px-3 py-1 text-sm">
                Chiudi
              </button>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-xs text-muted">
                Data da
                <input
                  type="date"
                  className="input-saas mt-1 w-full"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                />
              </label>
              <label className="text-xs text-muted">
                Data a
                <input
                  type="date"
                  className="input-saas mt-1 w-full"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                />
              </label>
              <div className="text-xs text-muted md:col-span-3">
                Stato (multi)
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-xl border border-border bg-surface-2 p-2 md:grid-cols-4">
                  {statusOptions.map((option) => (
                    <label key={option} className="flex items-center gap-2 text-xs text-text">
                      <input
                        type="checkbox"
                        checked={statusFilters.includes(option)}
                        onChange={(event) => {
                          setStatusFilters((prev) =>
                            event.target.checked ? [...prev, option] : prev.filter((item) => item !== option)
                          );
                        }}
                      />
                      {SERVICE_STATUS_LABELS[option]}
                    </label>
                  ))}
                </div>
              </div>
              <label className="text-xs text-muted">
                Tipo servizio
                <select className="input-saas mt-1 w-full" value={serviceType} onChange={(event) => setServiceType(event.target.value as ServiceTypeFilter)}>
                  <option value="all">Tutti</option>
                  <option value="transfer">{SERVICE_TYPE_LABELS.transfer}</option>
                  <option value="bus_tour">{SERVICE_TYPE_LABELS.bus_tour}</option>
                </select>
              </label>
              <label className="text-xs text-muted">
                Nave
                <input
                  className="input-saas mt-1 w-full"
                  value={ship}
                  onChange={(event) => setShip(event.target.value)}
                  placeholder="es. Caremar"
                />
              </label>
              <label className="text-xs text-muted">
                Zona
                <input
                  className="input-saas mt-1 w-full"
                  value={zone}
                  onChange={(event) => setZone(event.target.value)}
                  placeholder="es. Forio"
                />
              </label>
              <label className="text-xs text-muted md:col-span-3">
                Ricerca
                <input
                  className="input-saas mt-1 w-full"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="cliente, nave, note"
                />
              </label>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleExport()}
                disabled={isLoading || isInvalidDateRange}
                className="btn-primary disabled:opacity-50"
              >
                {isLoading ? "Esportazione..." : "Scarica .xlsx"}
              </button>
            </div>
            {message ? <p className="text-xs text-muted">{message}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
