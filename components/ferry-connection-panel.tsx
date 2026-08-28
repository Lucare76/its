"use client";

/**
 * Pannello override/ricalcolo collegamento nave (Mario) — sezione 15 del
 * task Mario. Mostra la proposta calcolata (Napoli/Pozzuoli, buffer
 * confermati, ecc.) confrontata con il collegamento applicato, permette:
 *   - "Applica proposta calcolata" (sostituisce anche un override esistente,
 *     previa conferma esplicita)
 *   - "Rimuovi override" (torna alla proposta calcolata)
 *
 * Non tocca la stampa (piano-giorno-print.ts / PDF): agisce solo su
 * services.ferry_details.connection via /api/ops/services/[id]/ferry-connection.
 * Componente standalone, non ancora montato in nessuna pagina di produzione:
 * integrazione nella scheda servizio è un passo successivo, in attesa di OK.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import type { ConnectionRecord } from "@/lib/travel-connection-resolver";
import type { FerryDetailsConnection } from "@/lib/server/ferry-connection-persistence";

type Props = {
  serviceId: string;
  className?: string;
};

type GetResponse = {
  applicable: boolean;
  reason?: string;
  service?: { id: string; customer_name: string; pax: number; date: string; direction: string };
  current: FerryDetailsConnection | null;
  proposal?: FerryDetailsConnection;
  hasOverride?: boolean;
  hasDiff?: boolean;
};

async function authHeaders(): Promise<Record<string, string>> {
  const session = await supabase?.auth.getSession();
  const token = session?.data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

function recordLabel(record: ConnectionRecord | null | undefined): string {
  if (!record || !record.company) return "—";
  const type = record.ferry_type === "aliscafo" ? "aliscafo" : "traghetto";
  return `${record.company.toUpperCase()} ${type} ${record.departure_time ?? "?"} — ${record.embark_port ?? "?"} → ${record.arrival_port ?? "?"}`;
}

function confidenceBadge(confidence: string | undefined) {
  const styles: Record<string, string> = {
    ALTA: "bg-emerald-50 text-emerald-700 border-emerald-200",
    MEDIA: "bg-amber-50 text-amber-700 border-amber-200",
    BASSA: "bg-orange-50 text-orange-700 border-orange-200",
    NESSUNA: "bg-red-50 text-red-700 border-red-200",
  };
  return styles[confidence ?? ""] ?? "bg-slate-50 text-slate-600 border-slate-200";
}

export function FerryConnectionPanel({ serviceId, className }: Props) {
  const [data, setData] = useState<GetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/ops/services/${serviceId}/ferry-connection`, { headers });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Errore nel calcolo del collegamento.");
      setData(json);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Errore imprevisto.");
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    load();
  }, [load]);

  const runAction = useCallback(
    async (body: Record<string, unknown>, actionKey: string) => {
      setBusy(actionKey);
      setErrorMsg(null);
      try {
        const headers = await authHeaders();
        const res = await fetch(`/api/ops/services/${serviceId}/ferry-connection`, { method: "PATCH", headers, body: JSON.stringify(body) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "Errore durante l'aggiornamento.");
        await load();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : "Errore imprevisto.");
      } finally {
        setBusy(null);
      }
    },
    [serviceId, load]
  );

  if (loading) return <div className={className}>Caricamento collegamento nave…</div>;
  if (errorMsg && !data) return <div className={`text-red-600 ${className ?? ""}`}>Errore: {errorMsg}</div>;
  if (!data?.applicable) return <div className={`text-sm text-slate-500 ${className ?? ""}`}>{data?.reason ?? "Nessun collegamento nave da gestire per questo servizio."}</div>;

  const { current, proposal, hasOverride, hasDiff } = data;

  return (
    <div className={`rounded-lg border border-slate-200 p-4 space-y-4 ${className ?? ""}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Collegamento nave — {data.service?.customer_name}</h3>
        {hasOverride && (
          <span className="text-xs px-2 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200">Override manuale attivo</span>
        )}
      </div>

      {errorMsg && <div className="text-sm text-red-600">{errorMsg}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded border border-slate-200 p-3">
          <div className="text-xs uppercase text-slate-400 mb-1">Applicato ora</div>
          <div className="text-sm font-medium text-slate-800">{recordLabel(current?.applied)}</div>
          <div className="text-xs text-slate-500 mt-1">Pickup: {current?.pickup_time ?? "—"}</div>
          <div className={`inline-block mt-2 text-xs px-2 py-0.5 rounded border ${confidenceBadge(current?.confidence)}`}>
            {current?.confidence ?? "nessun dato salvato"}
          </div>
        </div>
        <div className="rounded border border-slate-200 p-3">
          <div className="text-xs uppercase text-slate-400 mb-1">Proposta ricalcolata ora</div>
          <div className="text-sm font-medium text-slate-800">{recordLabel(proposal?.applied)}</div>
          <div className="text-xs text-slate-500 mt-1">Pickup: {proposal?.pickup_time ?? "—"}</div>
          <div className={`inline-block mt-2 text-xs px-2 py-0.5 rounded border ${confidenceBadge(proposal?.confidence)}`}>
            {proposal?.confidence}
          </div>
        </div>
      </div>

      {proposal?.warnings && proposal.warnings.length > 0 && (
        <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
          {proposal.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {hasDiff && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          La proposta ricalcolata differisce da quanto attualmente applicato
          {hasOverride ? " (override manuale confermato: il ricalcolo NON lo sostituisce senza conferma esplicita)." : "."}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy !== null || !hasDiff}
          onClick={() => runAction({ action: "apply_proposal" }, "apply_proposal")}
          className="text-sm px-3 py-1.5 rounded bg-slate-800 text-white disabled:opacity-40"
        >
          {busy === "apply_proposal" ? "Applico…" : "Applica proposta calcolata"}
        </button>
        {hasOverride && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runAction({ action: "clear_override" }, "clear_override")}
            className="text-sm px-3 py-1.5 rounded border border-slate-300 text-slate-700 disabled:opacity-40"
          >
            {busy === "clear_override" ? "Rimuovo…" : "Rimuovi override, torna alla proposta"}
          </button>
        )}
      </div>

      <p className="text-xs text-slate-400">
        L&apos;override manuale (scelta di una corsa diversa da quella proposta) si conferma dalla corsa scelta in tabella nave — form dedicato non ancora presente in questa vista.
      </p>
    </div>
  );
}
