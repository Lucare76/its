"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import type { Suggestion, SuggestionPriority } from "@/lib/operations-suggestions";

type Props = {
  refreshIntervalMs?: number;
  maxItems?: number;
  className?: string;
};

const priorityOrder: Record<SuggestionPriority, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

const priorityStyle: Record<SuggestionPriority, { label: string; dot: string; border: string; bg: string }> = {
  critical: { label: "Critico", dot: "bg-red-500", border: "border-red-200", bg: "bg-red-50" },
  high: { label: "Alta", dot: "bg-amber-500", border: "border-amber-200", bg: "bg-amber-50" },
  medium: { label: "Media", dot: "bg-sky-500", border: "border-sky-200", bg: "bg-sky-50" },
  low: { label: "Bassa", dot: "bg-slate-400", border: "border-slate-200", bg: "bg-slate-50" }
};

async function getAccessToken() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export function OperationsSuggestions({ refreshIntervalMs = 30_000, maxItems = 6, className = "" }: Props) {
  const router = useRouter();
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [executingId, setExecutingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const activeSuggestions = useMemo(
    () =>
      suggestions
        .filter((suggestion) => !suggestion.resolved)
        .sort((a, b) => priorityOrder[b.priority] - priorityOrder[a.priority])
        .slice(0, maxItems),
    [maxItems, suggestions]
  );

  const load = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      setLoading(false);
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch("/api/ops/suggestions", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store"
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; suggestions?: Suggestion[]; error?: string } | null;
    if (!response.ok || !body?.ok) {
      setMessage(body?.error ?? "Suggerimenti non disponibili.");
      setLoading(false);
      return;
    }

    setSuggestions(body.suggestions ?? []);
    setMessage(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    const run = async () => {
      if (!active) return;
      await load();
    };

    void run();
    const interval = window.setInterval(() => void run(), refreshIntervalMs);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [load, refreshIntervalMs]);

  const execute = async (suggestion: Suggestion) => {
    const token = await getAccessToken();
    if (!token) {
      setMessage("Sessione non valida.");
      return;
    }

    setExecutingId(suggestion.id);
    const response = await fetch("/api/ops/suggestions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        suggestion_id: suggestion.id,
        suggestion_type: suggestion.type,
        action_payload: suggestion.action_payload
      })
    });

    const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; moved_pax?: number; moved_services?: number } | null;
    setExecutingId(null);
    if (!response.ok || !body?.ok) {
      setMessage(body?.error ?? "Azione non completata.");
      return;
    }

    const moved = body.moved_pax ? ` Spostati ${body.moved_pax} pax su ${body.moved_services ?? 0} servizi.` : "";
    setMessage(`Suggerimento risolto.${moved}`);
    await load();

    if (suggestion.action_payload.action === "open_service") {
      const name = suggestion.action_payload.customer_name;
      router.push(name ? `/ricerca?q=${encodeURIComponent(name)}` : "/ricerca");
    }
    if (suggestion.action_payload.action === "open_hotel") router.push("/hotels");
  };

  return (
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Suggerimenti</h2>
          <p className="mt-0.5 text-xs text-slate-500">Controlli automatici su bus, hotel e dati cliente. La parte AI riscrive solo il testo.</p>
        </div>
        <button type="button" onClick={() => void load()} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          Aggiorna
        </button>
      </div>

      <div className="space-y-3 px-5 py-4">
        {loading ? <p className="text-sm text-slate-500">Analisi operativa in corso...</p> : null}
        {!loading && activeSuggestions.length === 0 ? <p className="text-sm text-slate-500">Nessun suggerimento operativo aperto.</p> : null}

        {activeSuggestions.map((suggestion) => {
          const style = priorityStyle[suggestion.priority];
          return (
            <article key={suggestion.id} className={`rounded-lg border ${style.border} ${style.bg} p-3`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${style.dot}`} />
                    <p className="text-sm font-bold text-slate-900">{suggestion.title}</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">{style.label}</span>
                  </div>
                  <p className="mt-2 text-sm leading-5 text-slate-700">{suggestion.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void execute(suggestion)}
                  disabled={executingId === suggestion.id}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {executingId === suggestion.id ? "Esecuzione..." : suggestion.action_label}
                </button>
              </div>
            </article>
          );
        })}

        {message ? <p className="text-xs font-medium text-slate-500">{message}</p> : null}
      </div>
    </section>
  );
}
