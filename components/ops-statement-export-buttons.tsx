"use client";

import { useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

interface OpsStatementExportButtonsProps {
  agencies: string[];
  today: string;
}

function firstDayOfMonth(dateIso: string) {
  const [year, month] = dateIso.split("-");
  return year && month ? `${year}-${month}-01` : dateIso;
}

async function downloadStatementExport(dateFrom: string, dateTo: string, billingParty: string) {
  if (!hasSupabaseEnv || !supabase) {
    throw new Error("Esportazione disponibile solo con Supabase configurato.");
  }

  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error("Sessione non valida. Effettua nuovamente il login.");
  }

  const params = new URLSearchParams({
    dateFrom,
    dateTo,
    exportPreset: "statement_agency",
    billingParty
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
  const filename = match?.[1] ?? `estratto_conto_${billingParty}_${dateFrom}_${dateTo}.xlsx`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function OpsStatementExportButtons({ agencies, today }: OpsStatementExportButtonsProps) {
  const [loadingAgency, setLoadingAgency] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const dateFrom = useMemo(() => firstDayOfMonth(today), [today]);

  const handleExport = async (agency: string) => {
    setLoadingAgency(agency);
    setMessage(null);
    try {
      await downloadStatementExport(dateFrom, today, agency);
      setMessage(`Estratto conto scaricato: ${agency}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Errore export estratto conto.");
    } finally {
      setLoadingAgency(null);
    }
  };

  if (agencies.length === 0) return null;

  return (
    <div className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-sm font-semibold text-text">Export estratti conto</p>
        <p className="text-xs text-muted">Periodo {dateFrom} {"->"} {today}. Excel separato per ogni agenzia abilitata.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {agencies.map((agency) => (
          <button
            key={agency}
            type="button"
            onClick={() => void handleExport(agency)}
            disabled={loadingAgency !== null}
            className="btn-secondary disabled:opacity-50"
          >
            {loadingAgency === agency ? `Esportazione ${agency}...` : agency}
          </button>
        ))}
      </div>
      {message ? <p className="text-xs text-muted">{message}</p> : null}
    </div>
  );
}
