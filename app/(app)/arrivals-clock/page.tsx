"use client";

import { useEffect, useState } from "react";
import { PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type ArrivalWindow = {
  time: string;
  totalPax: number;
  snavPax: number;
  medmarPax: number;
  otherPax: number;
};

type WhatsAppCandidate = {
  id: string;
  customer_name: string;
  date: string;
  time: string;
  minutes_to_arrival: number;
  has_phone: boolean;
};

async function token() {
  if (!hasSupabaseEnv || !supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function loadArrivalsClockData(
  date: string,
  apply: (payload: { windows: ArrivalWindow[]; candidates: WhatsAppCandidate[]; message?: string }) => void
) {
  const accessToken = await token();
  if (!accessToken) {
    apply({ windows: [], candidates: [], message: "Sessione non valida." });
    return;
  }

  const [windowsResponse, waResponse] = await Promise.all([
    fetch(`/api/ops/arrival-windows?date=${date}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch(`/api/ops/whatsapp-arrivals?date=${date}`, { headers: { Authorization: `Bearer ${accessToken}` } })
  ]);
  const windowsBody = (await windowsResponse.json().catch(() => null)) as { ok?: boolean; windows?: ArrivalWindow[] } | null;
  const waBody = (await waResponse.json().catch(() => null)) as { ok?: boolean; candidates?: WhatsAppCandidate[] } | null;

  apply({
    windows: windowsResponse.ok && windowsBody?.ok ? (windowsBody.windows ?? []) : [],
    candidates: waResponse.ok && waBody?.ok ? (waBody.candidates ?? []) : []
  });
}

export default function ArrivalsClockPage() {
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().slice(0, 10));
  const [windows, setWindows] = useState<ArrivalWindow[]>([]);
  const [candidates, setCandidates] = useState<WhatsAppCandidate[]>([]);
  const [message, setMessage] = useState("Arrivi a orario e preview WhatsApp clienti in arrivo.");

  useEffect(() => {
    let active = true;
    void loadArrivalsClockData(selectedDate, ({ windows: nextWindows, candidates: nextCandidates, message: nextMessage }) => {
      if (!active) return;
      setWindows(nextWindows);
      setCandidates(nextCandidates);
      if (nextMessage) setMessage(nextMessage);
    });
    return () => {
      active = false;
    };
  }, [selectedDate]);

  const refresh = async () => {
    await loadArrivalsClockData(selectedDate, ({ windows: nextWindows, candidates: nextCandidates, message: nextMessage }) => {
      setWindows(nextWindows);
      setCandidates(nextCandidates);
      if (nextMessage) setMessage(nextMessage);
    });
  };

  return (
    <section className="page-section">
      <PageHeader
        title="Arrivi a Orario"
        subtitle="SNAV, MEDMAR e altri vettori con preview invio WhatsApp arrivi."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "Arrivi Orario" }]}
        actions={
          <div className="flex items-end gap-2">
            <label className="text-sm">
              Data
              <input className="input-saas mt-1" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} />
            </label>
            <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => void refresh()}>
              Aggiorna
            </button>
          </div>
        }
      />

      <p className="text-sm text-muted">{message}</p>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionCard title="Finestre arrivo" subtitle="Quante persone arrivano a un determinato orario">
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">Ora</th>
                  <th className="px-3 py-2">Totale</th>
                  <th className="px-3 py-2">SNAV</th>
                  <th className="px-3 py-2">MEDMAR</th>
                  <th className="px-3 py-2">Altri</th>
                </tr>
              </thead>
              <tbody>
                {windows.map((item) => (
                  <tr key={item.time} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium">{item.time}</td>
                    <td className="px-3 py-2">{item.totalPax}</td>
                    <td className="px-3 py-2">{item.snavPax}</td>
                    <td className="px-3 py-2">{item.medmarPax}</td>
                    <td className="px-3 py-2">{item.otherPax}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>

        <SectionCard title="WhatsApp arrivi" subtitle="Preview clienti in arrivo con trigger operativo">
          <div className="space-y-2">
            {candidates.map((candidate) => (
              <article key={candidate.id} className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm">
                <p className="font-semibold">{candidate.customer_name}</p>
                <p className="text-muted">{candidate.date} {candidate.time} | minuti all&apos;arrivo {candidate.minutes_to_arrival}</p>
                <p className="text-muted">{candidate.has_phone ? "Telefono disponibile" : "Telefono mancante"}</p>
              </article>
            ))}
            {candidates.length === 0 ? <p className="text-sm text-muted">Nessun cliente pronto per preview arrivo.</p> : null}
          </div>
        </SectionCard>
      </div>
    </section>
  );
}
