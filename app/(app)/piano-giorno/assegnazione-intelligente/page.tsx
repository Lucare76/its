"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { SectionCard } from "@/components/ui/section-card";
import { SidePanel } from "@/components/ui/side-panel";
import { supabase } from "@/lib/supabase/client";

type PlanItemStatus = "auto_safe" | "review" | "unresolved" | "locked" | "manual";

type PlanItem = {
  id: string;
  service_id: string;
  status: PlanItemStatus;
  proposed_driver_id: string | null;
  proposed_driver_name: string | null;
  proposed_vehicle_label: string | null;
  score: number | null;
  confidence: number | null;
  reason: { summary?: string[] } | null;
  alternatives: Array<{ driver_id: string; driver_name: string; vehicle_id: string | null; vehicle_label: string | null; score: number; reason: string[] }> | null;
  warnings: string[] | null;
  suggested_fix: { description: string } | null;
  locked: boolean;
  confirmed_at: string | null;
};

type Plan = {
  id: string;
  generated_at: string;
  duration_ms: number | null;
  services_count: number;
  auto_safe_count: number;
  review_count: number;
  unresolved_count: number;
  locked_count: number;
  manual_count: number;
  drivers_count: number;
  vehicles_count: number;
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AssegnazioneIntelligentePage() {
  const [date, setDate] = useState(todayIso());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [items, setItems] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<PlanItem | null>(null);
  const [tab, setTab] = useState<"review" | "unresolved">("review");

  const load = useCallback(async (targetDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/ops/piano-giorno/assignment-plan?date=${targetDate}`, { headers });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Errore caricamento piano.");
      setPlan(body.plan);
      setItems(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore caricamento piano.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/piano-giorno/assignment-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ date }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Errore generazione piano.");
      setPlan(body.plan);
      setItems(body.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore generazione piano.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleConfirmAll() {
    setConfirming(true);
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/piano-giorno/assignment-plan/confirm-all", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ date }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Errore conferma massiva.");
      setConfirmStep(false);
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore conferma massiva.");
    } finally {
      setConfirming(false);
    }
  }

  async function handleChooseAlternative(item: PlanItem, driverId: string, vehicleId: string | null) {
    setError(null);
    try {
      const headers = await authHeaders();
      const res = await fetch("/api/ops/piano-giorno/assignment-plan/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ itemId: item.id, driverId, vehicleId }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Errore riassegnazione.");
      setSelectedItem(null);
      await load(date);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Errore riassegnazione.");
    }
  }

  const pendingAutoSafe = items.filter((item) => item.status === "auto_safe" && !item.confirmed_at).length;
  const reviewItems = items.filter((item) => item.status === "review");
  const unresolvedItems = items.filter((item) => item.status === "unresolved");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assegnazione Intelligente"
        subtitle="Il piano proposto per la giornata: Mario lavora solo sulle eccezioni."
        actions={
          <>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              className="input-base w-auto"
            />
            <button type="button" className="btn-primary" disabled={generating} onClick={() => void handleGenerate()}>
              {generating ? "Elaborazione…" : plan ? "RICALCOLA PIANO" : "PREPARA PIANO AUTOMATICO"}
            </button>
          </>
        }
      />

      {error ? <div className="card border-red-300 bg-red-50 p-3 text-sm text-red-700">{error}</div> : null}

      {plan ? (
        <p className="text-xs text-muted">
          Ultima elaborazione: {new Date(plan.generated_at).toLocaleString("it-IT")} · {plan.services_count} servizi ·{" "}
          {plan.drivers_count} autisti · {plan.vehicles_count} mezzi · {plan.duration_ms ?? 0} ms
        </p>
      ) : !loading ? (
        <p className="text-sm text-muted">Nessun piano generato per questa data. Clicca &quot;PREPARA PIANO AUTOMATICO&quot;.</p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Pronti" value={String(plan?.auto_safe_count ?? 0)} hint="Assegnazioni auto_safe, alta confidenza" loading={loading} />
        <StatCard label="Da verificare" value={String(plan?.review_count ?? 0)} hint="Score non dominante o dato da confermare" loading={loading} />
        <StatCard label="Da risolvere" value={String(plan?.unresolved_count ?? 0)} hint="Nessun candidato valido trovato" loading={loading} />
      </div>

      {pendingAutoSafe > 0 ? (
        <SectionCard title="Conferma massiva">
          {!confirmStep ? (
            <button type="button" className="btn-primary" onClick={() => setConfirmStep(true)}>
              CONFERMA TUTTE LE ASSEGNAZIONI SICURE ({pendingAutoSafe})
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-text">Stai per confermare {pendingAutoSafe} assegnazioni.</p>
              <div className="flex gap-2">
                <button type="button" className="btn-primary" disabled={confirming} onClick={() => void handleConfirmAll()}>
                  {confirming ? "Conferma in corso…" : "Conferma"}
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmStep(false)}>
                  Annulla
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      ) : null}

      <SectionCard
        title="Eccezioni"
        actions={
          <div className="flex gap-2">
            <button type="button" className={tab === "review" ? "btn-primary px-3 py-1 text-sm" : "btn-secondary px-3 py-1 text-sm"} onClick={() => setTab("review")}>
              Da verificare ({reviewItems.length})
            </button>
            <button type="button" className={tab === "unresolved" ? "btn-primary px-3 py-1 text-sm" : "btn-secondary px-3 py-1 text-sm"} onClick={() => setTab("unresolved")}>
              Da risolvere ({unresolvedItems.length})
            </button>
          </div>
        }
      >
        <ul className="divide-y divide-border">
          {(tab === "review" ? reviewItems : unresolvedItems).map((item) => (
            <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">Servizio {item.service_id.slice(0, 8)}</p>
                <p className="truncate text-xs text-muted">{(item.reason?.summary ?? []).join(" · ") || "Nessun motivo registrato"}</p>
                {item.suggested_fix?.description ? <p className="mt-1 text-xs text-accent">{item.suggested_fix.description}</p> : null}
              </div>
              <button type="button" className="btn-secondary px-3 py-1 text-sm" onClick={() => setSelectedItem(item)}>
                Dettagli
              </button>
            </li>
          ))}
          {(tab === "review" ? reviewItems : unresolvedItems).length === 0 ? (
            <li className="py-6 text-center text-sm text-muted">Nessuna eccezione in questa categoria.</li>
          ) : null}
        </ul>
      </SectionCard>

      <SidePanel
        open={Boolean(selectedItem)}
        title={selectedItem ? `Servizio ${selectedItem.service_id.slice(0, 8)}` : ""}
        subtitle={selectedItem?.status === "unresolved" ? "Nessuna soluzione automatica trovata" : "Proposta e alternative"}
        onClose={() => setSelectedItem(null)}
      >
        {selectedItem ? (
          <div className="space-y-3 text-sm">
            <div>
              <p className="font-medium text-text">Motivi</p>
              <ul className="mt-1 list-inside list-disc text-muted">
                {(selectedItem.reason?.summary ?? []).map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
            </div>
            {selectedItem.proposed_driver_name ? (
              <div>
                <p className="font-medium text-text">Proposta</p>
                <p className="text-muted">
                  {selectedItem.proposed_driver_name} {selectedItem.proposed_vehicle_label ? `· ${selectedItem.proposed_vehicle_label}` : ""} · Score {selectedItem.score ?? "-"}
                </p>
              </div>
            ) : null}
            {(selectedItem.alternatives ?? []).length > 0 ? (
              <div>
                <p className="font-medium text-text">Alternative</p>
                <ul className="mt-1 space-y-2">
                  {(selectedItem.alternatives ?? []).map((alt) => (
                    <li key={alt.driver_id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                      <div>
                        <p className="text-text">
                          {alt.driver_name} {alt.vehicle_label ? `· ${alt.vehicle_label}` : ""}
                        </p>
                        <p className="text-xs text-muted">Score {alt.score}</p>
                      </div>
                      <button
                        type="button"
                        className="btn-primary px-3 py-1 text-sm"
                        onClick={() => void handleChooseAlternative(selectedItem, alt.driver_id, alt.vehicle_id)}
                      >
                        SCEGLI {alt.driver_name.split(" ")[0]?.toUpperCase()}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selectedItem.suggested_fix?.description ? (
              <div>
                <p className="font-medium text-text">Soluzione proposta</p>
                <p className="text-muted">{selectedItem.suggested_fix.description}</p>
              </div>
            ) : null}
          </div>
        ) : null}
      </SidePanel>
    </div>
  );
}
