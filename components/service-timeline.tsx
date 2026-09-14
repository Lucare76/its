"use client";

import { useCallback, useEffect, useState } from "react";

type TimelineActorType = "human" | "system" | "import" | "provider" | "agency";

type TimelineActor = {
  type: TimelineActorType;
  name: string | null;
  email?: string | null;
  userId?: string | null;
};

type TimelineChange = { field: string; label: string; from: unknown; to: unknown };

type TimelineEvent = {
  id: string;
  timestamp: string;
  eventType: string;
  source: string;
  actor: TimelineActor;
  title: string;
  description?: string | null;
  changes?: TimelineChange[];
  reason?: string | null;
  severity?: "info" | "warning" | "error";
  originalSource: string;
};

const ACTOR_ICON: Record<TimelineActorType, string> = {
  human: "\u{1F464}",
  system: "\u{2699}\u{FE0F}",
  import: "\u{1F4E5}",
  provider: "\u{1F4AC}",
  agency: "\u{1F3E2}",
};

function formatTimestamp(iso: string): string {
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "sì" : "no";
  return String(value);
}

function severityClass(severity: TimelineEvent["severity"]): string {
  if (severity === "warning") return "border-amber-200 bg-amber-50/60";
  if (severity === "error") return "border-red-200 bg-red-50/60";
  return "border-slate-200 bg-white";
}

// Nessun JSON grezzo in UI (Fase 8): la sezione "prima → dopo" mostra solo
// changes[] già normalizzato dal server (label leggibile + valori scalari),
// mai old_data/new_data/metadata direttamente.
function TimelineChangesList({ changes }: { changes: TimelineChange[] | undefined }) {
  if (!changes || changes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {changes.map((c) => (
        <li key={c.field} className="text-xs text-slate-600">
          <span className="font-medium">{c.label}</span>: {formatValue(c.from)} → {formatValue(c.to)}
        </li>
      ))}
    </ul>
  );
}

export function ServiceTimeline({ serviceId, accessToken }: { serviceId: string; accessToken: string | null }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (after: string | null, append: boolean) => {
      if (!accessToken) {
        setError("Sessione non disponibile.");
        setLoading(false);
        return;
      }
      const url = `/api/ops/services/${serviceId}/timeline${after ? `?cursor=${encodeURIComponent(after)}` : ""}`;
      let res: Response;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
      } catch {
        setError("Errore di rete durante il caricamento della cronologia.");
        if (append) setLoadingMore(false);
        else setLoading(false);
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { ok: true; events: TimelineEvent[]; next_cursor: string | null }
        | { ok: false; error?: string }
        | null;
      if (!res.ok || !body?.ok) {
        setError((body && "error" in body && body.error) || "Errore nel caricamento della cronologia.");
      } else {
        setEvents((prev) => (append ? [...prev, ...body.events] : body.events));
        setCursor(body.next_cursor);
        setError(null);
      }
      if (append) setLoadingMore(false);
      else setLoading(false);
    },
    [accessToken, serviceId]
  );

  useEffect(() => {
    setLoading(true);
    setEvents([]);
    setCursor(null);
    void loadPage(null, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- si ricarica solo al cambio di servizio/token, non a ogni cambio di loadPage
  }, [serviceId, accessToken]);

  const loadMore = () => {
    if (!cursor) return;
    setLoadingMore(true);
    void loadPage(cursor, true);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
      <div>
        <p className="text-sm font-semibold text-slate-900">Cronologia</p>
        <p className="mt-1 text-xs text-slate-500">Storico completo di ciò che è successo su questo servizio.</p>
      </div>
      {loading ? (
        <p className="mt-3 text-sm text-slate-500">Caricamento cronologia...</p>
      ) : error ? (
        <p className="mt-3 text-sm text-muted">{error}</p>
      ) : events.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nessun evento registrato.</p>
      ) : (
        <>
          <div className="mt-3 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {events.map((event) => (
              <div key={event.id} className={`flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:justify-between ${severityClass(event.severity)}`}>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-800">
                    <span aria-hidden="true">{ACTOR_ICON[event.actor.type] ?? ACTOR_ICON.system}</span> {event.title}
                  </p>
                  {event.reason ? <p className="mt-0.5 text-xs italic text-slate-500">Motivo: {event.reason}</p> : null}
                  {event.description ? <p className="mt-0.5 text-xs text-slate-500">{event.description}</p> : null}
                  <TimelineChangesList changes={event.changes} />
                  <p className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">{event.source}</p>
                </div>
                <p className="text-xs font-semibold text-slate-500 whitespace-nowrap">{formatTimestamp(event.timestamp)}</p>
              </div>
            ))}
          </div>
          {cursor ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loadingMore ? "Caricamento..." : "Carica altri"}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
