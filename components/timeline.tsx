interface TimelineProps {
  events: Array<{
    id: string;
    at: string;
    type: "status" | "assignment" | "communication";
    title: string;
    detail?: string;
    by?: string | null;
  }>;
}

export function Timeline({ events }: TimelineProps) {
  if (events.length === 0) {
    return <div className="rounded-xl border border-dashed border-slate-300 p-3 text-sm text-slate-500">Nessun evento.</div>;
  }

  return (
    <ol className="space-y-2">
      {events.map((event) => (
        <li key={event.id} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{event.title}</p>
            <span className="text-[10px] uppercase tracking-[0.12em] text-slate-500">{event.type}</span>
          </div>
          {event.detail ? <p className="text-xs text-slate-600">{event.detail}</p> : null}
          <p className="text-xs text-slate-500">{new Date(event.at).toLocaleString("it-IT")}</p>
          <p className="text-xs text-slate-500">By: {event.by ?? "system"}</p>
        </li>
      ))}
    </ol>
  );
}
