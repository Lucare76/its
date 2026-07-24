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

function actionSummary(suggestion: Suggestion) {
  const payload = suggestion.action_payload;
  if (payload.action === "move_pax_between_buses") {
    return {
      title: "Sposta passeggeri tra mezzi",
      details: [
        `Da: ${payload.from_bus_label ?? "mezzo origine non indicato"}`,
        `A: ${payload.to_bus_label ?? "mezzo destinazione non indicato"}`,
        `Passeggeri stimati: ${payload.pax ?? "-"}`
      ],
      warning: "L'azione aggiorna le assegnazioni dei servizi compatibili. Verifica sempre il risultato nel piano operativo."
    };
  }
  if (payload.action === "open_service") {
    return {
      title: "Apri servizio collegato",
      details: [
        `Cliente: ${payload.customer_name ?? "non indicato"}`,
        `Servizio: ${payload.service_id ?? "non indicato"}`
      ],
      warning: "La guida aprira la scheda servizio; nessun dato verra modificato automaticamente."
    };
  }
  if (payload.action === "open_hotel") {
    return {
      title: "Apri anagrafica hotel",
      details: [`Hotel: ${payload.hotel_id ?? "non indicato"}`],
      warning: "La guida aprira la sezione hotel; nessun dato verra modificato automaticamente."
    };
  }
  return {
    title: "Segna suggerimento come risolto",
    details: ["Il suggerimento verra nascosto dalla lista operativa."],
    warning: "Usa questa opzione solo se il controllo e gia stato gestito fuori dal wizard."
  };
}

function actionSteps(suggestion: Suggestion) {
  const payload = suggestion.action_payload;
  if (payload.action === "move_pax_between_buses") {
    return [
      "Controlla origine, destinazione e numero passeggeri.",
      "Conferma l'azione solo se il piano operativo e coerente.",
      "Dopo l'esecuzione verifica i servizi spostati e la capienza dei mezzi."
    ];
  }
  if (payload.action === "open_service") {
    return [
      "Apri la scheda servizio indicata.",
      "Completa o correggi i dati mancanti.",
      "Torna ai suggerimenti e aggiorna la lista."
    ];
  }
  if (payload.action === "open_hotel") {
    return [
      "Apri la sezione hotel.",
      "Controlla geocodifica, indirizzo e dati anagrafici.",
      "Aggiorna i suggerimenti dopo la correzione."
    ];
  }
  return [
    "Verifica che il problema sia stato risolto.",
    "Conferma per archiviare il suggerimento.",
    "Aggiorna la lista suggerimenti."
  ];
}

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
  const [guidedSuggestion, setGuidedSuggestion] = useState<Suggestion | null>(null);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3>(1);

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
    setWizardStep(3);
    await load();

    if (suggestion.action_payload.action === "open_service") {
      const sid = suggestion.action_payload.service_id;
      router.push(sid ? `/services/${sid}/edit` : "/ricerca");
    }
    if (suggestion.action_payload.action === "open_hotel") router.push("/hotels");
  };

  const openWizard = (suggestion: Suggestion) => {
    setGuidedSuggestion(suggestion);
    setWizardStep(1);
    setMessage(null);
  };

  const closeWizard = () => {
    if (executingId) return;
    setGuidedSuggestion(null);
    setWizardStep(1);
  };

  const guidedAction = guidedSuggestion ? actionSummary(guidedSuggestion) : null;
  const guidedSteps = guidedSuggestion ? actionSteps(guidedSuggestion) : [];

  return (
    <section className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>
      {guidedSuggestion && guidedAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Risoluzione guidata</p>
                  <h3 className="mt-1 text-base font-bold text-slate-900">{guidedSuggestion.title}</h3>
                  <p className="mt-1 text-sm text-slate-600">{guidedAction.title}</p>
                </div>
                <button
                  type="button"
                  onClick={closeWizard}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Chiudi
                </button>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-xs font-semibold">
                {[
                  [1, "Analisi"],
                  [2, "Conferma"],
                  [3, "Esito"],
                ].map(([step, label]) => (
                  <div key={step} className={`rounded-full px-3 py-2 text-center ${wizardStep === step ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"}`}>
                    {label}
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4 px-5 py-4">
              {wizardStep === 1 ? (
                <>
                  <div className={`rounded-lg border ${priorityStyle[guidedSuggestion.priority].border} ${priorityStyle[guidedSuggestion.priority].bg} p-3`}>
                    <p className="text-sm font-semibold text-slate-900">Problema rilevato</p>
                    <p className="mt-1 text-sm leading-5 text-slate-700">{guidedSuggestion.description}</p>
                  </div>
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Dati azione</p>
                      <div className="mt-2 space-y-1 text-sm text-slate-700">
                        {guidedAction.details.map((detail) => <p key={detail}>{detail}</p>)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      {guidedAction.warning}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-white p-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Passi consigliati</p>
                    <ol className="mt-2 space-y-2 text-sm text-slate-700">
                      {guidedSteps.map((step, index) => (
                        <li key={step} className="flex gap-2">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white">{index + 1}</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </>
              ) : null}

              {wizardStep === 2 ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                  <p className="text-sm font-bold text-slate-900">Conferma operativa</p>
                  <p className="mt-2 text-sm text-slate-600">
                    Stai per eseguire: <strong>{guidedSuggestion.action_label}</strong>.
                    {guidedSuggestion.action_payload.action === "move_pax_between_buses"
                      ? " Questa azione puo modificare assegnazioni esistenti."
                      : " Questa azione non modifica dati operativi automaticamente."}
                  </p>
                  <div className="mt-3 rounded-md bg-white p-3 text-sm text-slate-700">
                    {guidedAction.details.map((detail) => <p key={detail}>{detail}</p>)}
                  </div>
                </div>
              ) : null}

              {wizardStep === 3 ? (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
                  <p className="text-sm font-bold text-emerald-900">Flusso completato</p>
                  <p className="mt-2 text-sm text-emerald-800">{message ?? "Suggerimento gestito. Aggiorna la lista per verificare lo stato operativo."}</p>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 border-t border-slate-100 px-5 py-4 sm:flex-row sm:justify-between">
              <button
                type="button"
                onClick={() => wizardStep === 1 ? closeWizard() : setWizardStep(1)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
              >
                {wizardStep === 1 ? "Annulla" : "Indietro"}
              </button>
              <div className="flex gap-2">
                {wizardStep === 1 ? (
                  <button type="button" onClick={() => setWizardStep(2)} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
                    Continua
                  </button>
                ) : null}
                {wizardStep === 2 ? (
                  <button
                    type="button"
                    onClick={() => void execute(guidedSuggestion)}
                    disabled={executingId === guidedSuggestion.id}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {executingId === guidedSuggestion.id ? "Esecuzione..." : `Conferma: ${guidedSuggestion.action_label}`}
                  </button>
                ) : null}
                {wizardStep === 3 ? (
                  <button type="button" onClick={closeWizard} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">
                    Chiudi guida
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-slate-900">Suggerimenti</h2>
          <p className="mt-0.5 text-xs text-slate-500">Controlli automatici su bus, hotel e dati cliente con risoluzione guidata.</p>
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
                  onClick={() => openWizard(suggestion)}
                  disabled={executingId === suggestion.id}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {executingId === suggestion.id ? "Esecuzione..." : "Guida"}
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
