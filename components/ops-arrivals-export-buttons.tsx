"use client";

import { useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

interface OpsArrivalsExportButtonsProps {
  targetDate: string;
}

type ExportPreset = "arrivals_bus_line" | "arrivals_other_services" | "departures_bus_line" | "departures_other_services";

async function downloadOperationalExport(targetDate: string, exportPreset: ExportPreset) {
  if (!hasSupabaseEnv || !supabase) {
    throw new Error("Esportazione disponibile solo con Supabase configurato.");
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error("Sessione non valida. Effettua nuovamente il login.");
  }

  const params = new URLSearchParams({
    dateFrom: targetDate,
    dateTo: targetDate,
    exportPreset
  });

  const response = await fetch(`/api/exports/services.xlsx?${params.toString()}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${data.session.access_token}`
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Esportazione fallita.");
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition");
  const match = disposition?.match(/filename=\"?([^"]+)\"?/i);
  const fallback =
    exportPreset === "arrivals_bus_line"
      ? `arrivi_linea_bus_${targetDate}.xlsx`
      : exportPreset === "arrivals_other_services"
        ? `arrivi_altri_servizi_${targetDate}.xlsx`
        : exportPreset === "departures_bus_line"
          ? `partenze_linea_bus_${targetDate}.xlsx`
          : `partenze_altri_servizi_${targetDate}.xlsx`;
  const filename = match?.[1] ?? fallback;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function OpsArrivalsExportButtons({ targetDate }: OpsArrivalsExportButtonsProps) {
  const [loadingKey, setLoadingKey] = useState<null | ExportPreset>(null);
  const [message, setMessage] = useState<string | null>(null);

  const handleClick = async (exportPreset: ExportPreset) => {
    setLoadingKey(exportPreset);
    setMessage(null);
    try {
      await downloadOperationalExport(targetDate, exportPreset);
      setMessage(
        exportPreset === "arrivals_bus_line"
          ? "Excel arrivi linea bus scaricato."
          : exportPreset === "arrivals_other_services"
            ? "Excel arrivi altri servizi scaricato."
            : exportPreset === "departures_bus_line"
              ? "Excel partenze linea bus scaricato."
              : "Excel partenze altri servizi scaricato."
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore export.");
    } finally {
      setLoadingKey(null);
    }
  };

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-text">Export operativi giornata</p>
        <p className="text-xs text-muted">Data target {targetDate}. Excel separati per linea bus e altri servizi, su arrivi e partenze.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleClick("arrivals_bus_line")}
          disabled={loadingKey !== null}
          className="btn-secondary disabled:opacity-50"
        >
          {loadingKey === "arrivals_bus_line" ? "Esportazione..." : "Arrivi linea bus"}
        </button>
        <button
          type="button"
          onClick={() => void handleClick("arrivals_other_services")}
          disabled={loadingKey !== null}
          className="btn-primary disabled:opacity-50"
        >
          {loadingKey === "arrivals_other_services" ? "Esportazione..." : "Arrivi altri servizi"}
        </button>
        <button
          type="button"
          onClick={() => void handleClick("departures_bus_line")}
          disabled={loadingKey !== null}
          className="btn-secondary disabled:opacity-50"
        >
          {loadingKey === "departures_bus_line" ? "Esportazione..." : "Partenze linea bus"}
        </button>
        <button
          type="button"
          onClick={() => void handleClick("departures_other_services")}
          disabled={loadingKey !== null}
          className="btn-primary disabled:opacity-50"
        >
          {loadingKey === "departures_other_services" ? "Esportazione..." : "Partenze altri servizi"}
        </button>
      </div>
      {message ? <p className="text-xs text-muted">{message}</p> : null}
    </div>
  );
}
