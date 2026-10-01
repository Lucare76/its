"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "@/lib/supabase/client";
import type { CancelledBookingState, PenaltySummary, ServiceCancellationDetail } from "@/lib/server/cancelled-booking-state";
import type { PenaltyEmailStatus } from "@/lib/server/cancellation-penalty";

/**
 * Azioni sulle prenotazioni cancellate, condivise da ricerca globale (Inbox)
 * e /cancellazioni: stato penale sulla card, "Ripristina prenotazione",
 * "Gestisci/Modifica penale", "Reinvia email". Tutte le regole sono
 * applicate anche lato server; qui solo guida e conferme.
 */

// ─── Formattazione ────────────────────────────────────────────────────────────

function eur(cents: number): string {
  return (cents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" });
}

function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

function dateIt(iso: string | null | undefined): string {
  const m = (iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "—";
}

function penaltyText(p: Pick<PenaltySummary, "penalty_type" | "penalty_amount_cents" | "penalty_percentage">): string {
  if (p.penalty_type === "none") return "Nessuna penale";
  if (p.penalty_type === "percentage" && p.penalty_percentage != null) return `${p.penalty_percentage}% (${eur(p.penalty_amount_cents)})`;
  return eur(p.penalty_amount_cents);
}

function parseEuroToCents(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isFinite(cents) ? cents : null;
}

function isCommunicated(p: Pick<PenaltySummary, "email_status">): boolean {
  return p.email_status === "sent" || p.email_status === "sending";
}

type LegSummary = ServiceCancellationDetail["service"];

function legText(leg: LegSummary): string {
  const isDeparture = leg.direction === "departure";
  return `${isDeparture ? "Ritorno" : "Andata"} ${dateIt(isDeparture ? leg.departure_date ?? leg.date : leg.arrival_date ?? leg.date)}`;
}

function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `pen-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

async function authFetch(url: string, init?: RequestInit) {
  const token = await getToken();
  if (!token) throw new Error("Sessione scaduta.");
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { res, body: body ?? {} };
}

// ─── Hook stato card ──────────────────────────────────────────────────────────

export function useCancelledBookingStates(serviceIds: string[]) {
  const [states, setStates] = useState<Record<string, CancelledBookingState>>({});
  const key = useMemo(() => Array.from(new Set(serviceIds)).sort().join(","), [serviceIds]);

  const reload = useCallback(async () => {
    if (!key) return;
    try {
      const { res, body } = await authFetch(`/api/ops/cancelled-bookings/state?ids=${encodeURIComponent(key)}`);
      if (res.ok) setStates((body.states ?? {}) as Record<string, CancelledBookingState>);
    } catch {
      // Stato accessorio: la card resta utilizzabile anche senza.
    }
  }, [key]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void reload(); }, [reload]);
  return { states: key ? states : {}, reload };
}

// ─── Reinvio email ────────────────────────────────────────────────────────────

export function ResendPenaltyEmailButton({ penaltyId, channel, onDone }: { penaltyId: string; channel: "penalty" | "void"; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const inFlight = useRef(false);

  const resend = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { res, body } = await authFetch(`/api/ops/cancellation-penalties/${penaltyId}/resend-email`, {
        method: "POST",
        body: JSON.stringify({ channel }),
      });
      const email = body.email as { status?: PenaltyEmailStatus; error?: string | null } | undefined;
      if (!res.ok) setError(String(body.error ?? "Reinvio non riuscito."));
      else if (email?.status === "sent") setResult("Email inviata.");
      else setError(email?.error ?? "Email non inviata.");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reinvio non riuscito.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={() => void resend()} disabled={busy} className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-bold text-amber-800 hover:bg-amber-50 disabled:opacity-50">
        {busy ? "Invio..." : "Reinvia email"}
      </button>
      {error ? <span className="text-[11px] text-rose-600">{error}</span> : null}
      {result ? <span className="text-[11px] text-emerald-700">{result}</span> : null}
    </span>
  );
}

// ─── Stato sulla card ─────────────────────────────────────────────────────────

function EmailStatusLine({ status, sentAt, error, penaltyId, channel, onChanged, label }: {
  status: PenaltyEmailStatus | null;
  sentAt: string | null;
  error: string | null;
  penaltyId: string;
  channel: "penalty" | "void";
  onChanged: () => void;
  label: string;
}) {
  if (!status || status === "not_required") return null;
  if (status === "sent") return <p className="text-emerald-700">{label}: inviata {dateTime(sentAt)}</p>;
  if (status === "pending" || status === "sending") return <p className="text-slate-500">{label}: invio in corso…</p>;
  const text = status === "no_recipient"
    ? "Penale registrata – agenzia senza email"
    : status === "skipped"
      ? "Email non inviata (servizio email non configurato)"
      : "Email non inviata";
  return (
    <div className="flex flex-wrap items-center gap-2 font-semibold text-amber-800">
      <span>⚠ {channel === "void" ? `Annullamento penale: ${text.toLowerCase()}` : text}</span>
      <ResendPenaltyEmailButton penaltyId={penaltyId} channel={channel} onDone={onChanged} />
      {error && status === "failed" ? <span className="w-full text-[11px] font-normal text-amber-700">{error}</span> : null}
    </div>
  );
}

export function RestoredBadge({ state }: { state: CancelledBookingState | undefined }) {
  if (!state?.restored) return null;
  return state.restored.needs_reassignment ? (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800" title={`Ripristinata il ${dateTime(state.restored.restored_at)}${state.restored.restored_by ? ` da ${state.restored.restored_by}` : ""}`}>
      Ripristinata – da riassegnare/verificare
    </span>
  ) : (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">Ripristinata il {dateTime(state.restored.restored_at)}</span>
  );
}

export function CancelledBookingStatus({ state, onChanged }: { state: CancelledBookingState | undefined; onChanged: () => void }) {
  const active = state?.active_penalty ?? null;
  const pendingVoid = state?.pending_void_penalty ?? null;
  if (!active && !pendingVoid) return null;
  const emailProblem = active && ["failed", "no_recipient", "skipped"].includes(active.email_status);
  return (
    <div className="mt-2 space-y-1 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
      {active ? (
        <>
          <p className={`font-bold ${emailProblem ? "text-amber-800" : "text-slate-800"}`}>
            {emailProblem ? "⚠ " : ""}Penale: {penaltyText(active)}
            {active.scope === "practice" ? <span className="ml-1 font-normal text-slate-500">(intera pratica A/R)</span> : null}
            {active.email_kind === "rectification" ? <span className="ml-1 font-normal text-slate-500">· rettifica</span> : null}
          </p>
          <EmailStatusLine status={active.email_status} sentAt={active.email_sent_at} error={active.email_last_error} penaltyId={active.id} channel="penalty" onChanged={onChanged} label="Email agenzia" />
        </>
      ) : null}
      {pendingVoid ? (
        <>
          <p className="font-semibold text-slate-600">Penale annullata ({penaltyText(pendingVoid)}) il {dateTime(pendingVoid.voided_at)}</p>
          <EmailStatusLine status={pendingVoid.void_email_status} sentAt={pendingVoid.void_email_sent_at} error={pendingVoid.void_email_last_error} penaltyId={pendingVoid.id} channel="void" onChanged={onChanged} label="Email annullamento" />
        </>
      ) : null}
    </div>
  );
}

// ─── Dettaglio condiviso delle modali ─────────────────────────────────────────

function useCancellationDetail(serviceId: string) {
  const [detail, setDetail] = useState<ServiceCancellationDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const { res, body } = await authFetch(`/api/ops/services/${serviceId}/cancellation-state`);
      if (!res.ok) { setError(String(body.error ?? "Caricamento non riuscito.")); return; }
      setError(null);
      setDetail(body as unknown as ServiceCancellationDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Caricamento non riuscito.");
    }
  }, [serviceId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);
  return { detail, error, reload: load };
}

function Modal({ children, onClose, busy }: { children: React.ReactNode; onClose: () => void; busy?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4" onClick={() => !busy && onClose()}>
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function SummaryTable({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4 px-4 py-2">
          <span className="text-slate-500">{label}</span>
          <span className="text-right font-semibold text-slate-800">{value}</span>
        </div>
      ))}
    </div>
  );
}

function MedmarWarning({ warnings }: { warnings: ServiceCancellationDetail["medmar_warnings"] }) {
  if (!warnings.length) return null;
  return (
    <div className="mt-4 rounded-xl border-2 border-rose-400 bg-rose-50 px-4 py-3 text-sm text-rose-900">
      <p className="font-extrabold">ATTENZIONE – per questa prenotazione risulta già emesso/inviato un biglietto Medmar prima della cancellazione.</p>
      <p className="mt-1">Verificare il biglietto prima di procedere con una nuova emissione. Il ripristino non emette né azzera nulla su Medmar.</p>
      <ul className="mt-2 list-disc pl-5 text-xs">
        {warnings.map((w) => (
          <li key={w.service_id}>
            {w.ticket_sent_at ? `Biglietto inviato il ${dateTime(w.ticket_sent_at)}` : null}
            {w.ticket_sent_at && w.issuing_attempt_status ? " · " : null}
            {w.issuing_attempt_status ? `Emissione Medmar: ${w.issuing_attempt_status}${w.medmar_numero ? ` (n. ${w.medmar_numero})` : ""}` : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Modale ripristino ────────────────────────────────────────────────────────

type RestoreStep = "form" | "penalty" | "keep_confirm" | "done";

export function RestoreBookingDialog({ serviceId, onClose, onRestored }: {
  serviceId: string;
  onClose: () => void;
  onRestored: (restoredIds: string[]) => void;
}) {
  const { detail, error: loadError, reload } = useCancellationDetail(serviceId);
  const [scope, setScope] = useState<"leg" | "practice">("leg");
  const [step, setStep] = useState<RestoreStep>("form");
  const [penaltyChoice, setPenaltyChoice] = useState<"void" | "keep" | "cancel">("void");
  const [voidReason, setVoidReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ids: string[]; voidEmails: Array<{ penalty_id: string; status: PenaltyEmailStatus; error: string | null }>; medmar: ServiceCancellationDetail["medmar_warnings"] } | null>(null);
  const inFlight = useRef(false);

  const service = detail?.service ?? null;
  const linked = detail?.linked_service ?? null;
  const linkedCancelled = linked?.status === "cancelled";
  const targetIds = useMemo(() => {
    if (!service) return [] as string[];
    const ids = service.status === "cancelled" ? [service.id] : [];
    if (scope === "practice" && linked && linkedCancelled) ids.push(linked.id);
    return ids;
  }, [service, linked, linkedCancelled, scope]);
  const activePenalties = useMemo(
    () => (detail?.active_penalties ?? []).filter((p) => targetIds.includes(p.service_id) || (p.linked_service_id && targetIds.includes(p.linked_service_id))),
    [detail, targetIds]
  );
  const realPenalties = activePenalties.filter((p) => p.penalty_type !== "none");
  const medmar = (detail?.medmar_warnings ?? []).filter((w) => targetIds.includes(w.service_id));

  const submit = async (penaltyAction: "none" | "void" | "keep", reason?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { res, body } = await authFetch(`/api/ops/services/${serviceId}/restore`, {
        method: "POST",
        body: JSON.stringify({
          scope,
          penalty_action: penaltyAction,
          void_reason: reason ?? "",
          confirm_keep_penalty: penaltyAction === "keep",
        }),
      });
      if (!res.ok) {
        if (body.code === "active_penalty") {
          await reload();
          setStep("penalty");
        }
        setError(String(body.error ?? "Ripristino non riuscito."));
        return;
      }
      const ids = (body.restored_service_ids as string[] | undefined) ?? [];
      setResult({
        ids,
        voidEmails: (body.void_emails as Array<{ penalty_id: string; status: PenaltyEmailStatus; error: string | null }> | undefined) ?? [],
        medmar: (body.medmar_warnings as ServiceCancellationDetail["medmar_warnings"] | undefined) ?? [],
      });
      setStep("done");
      onRestored(ids);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ripristino non riuscito.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onPrimary = () => {
    if (activePenalties.length === 0) { void submit("none"); return; }
    // Solo "Nessuna penale" registrata: non c'è nulla da comunicare, la
    // decisione viene archiviata come annullata (storico conservato).
    if (realPenalties.length === 0) { void submit("void", "Ripristino prenotazione: decisione 'nessuna penale' non più applicabile"); return; }
    setStep("penalty");
  };

  const cancellation = service ? detail?.cancellation[service.id] ?? null : null;

  return (
    <Modal onClose={onClose} busy={busy}>
      {!detail ? (
        <p className="text-sm text-slate-500">{loadError ?? "Caricamento…"}</p>
      ) : step === "done" && result ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">Prenotazione ripristinata</h2>
          <p className="mt-2 text-sm text-slate-600">
            {result.ids.length > 1 ? "Entrambe le tratte sono" : "La prenotazione è"} di nuovo attiv{result.ids.length > 1 ? "e" : "a"} con stato <strong>da assegnare</strong>.
            Autista, mezzo e allocazioni bus/navette non sono stati ricreati: verificare e riassegnare.
          </p>
          {result.voidEmails.map((e) => (
            <p key={e.penalty_id} className={`mt-2 text-sm ${e.status === "sent" ? "text-emerald-700" : "text-amber-800"}`}>
              {e.status === "sent" ? "Email di annullamento penale inviata all'agenzia." : e.status === "not_required" ? "Penale annullata (nessuna comunicazione necessaria)." : `⚠ Penale annullata, email non inviata${e.error ? `: ${e.error}` : ""}. Puoi reinviarla dalla card.`}
            </p>
          ))}
          <MedmarWarning warnings={result.medmar} />
          <div className="mt-5 flex justify-end"><button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onClose}>Chiudi</button></div>
        </>
      ) : step === "penalty" ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">Penale attiva sulla prenotazione</h2>
          {realPenalties.map((p) => (
            <p key={p.id} className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
              {isCommunicated(p)
                ? `Questa prenotazione ha una penale di ${penaltyText(p)} già comunicata all'agenzia.`
                : `Questa prenotazione ha una penale di ${penaltyText(p)} registrata (non ancora comunicata all'agenzia).`}
              {p.scope === "practice" ? " Riferita all'intera pratica A/R." : ""}
            </p>
          ))}
          <div className="mt-4 space-y-3 text-sm text-slate-700">
            <label className="flex items-start gap-2">
              <input type="radio" name="restore-penalty" className="mt-1" checked={penaltyChoice === "void"} onChange={() => setPenaltyChoice("void")} />
              <span><span className="block font-semibold">Annulla penale e ripristina</span><span className="block text-xs text-slate-500">La penale resta nello storico come annullata{realPenalties.some(isCommunicated) ? "; l'agenzia riceverà una email di annullamento." : "."}</span></span>
            </label>
            {penaltyChoice === "void" ? (
              <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="input-saas min-h-[70px] w-full" placeholder="Motivo annullamento penale (obbligatorio)" />
            ) : null}
            <label className="flex items-start gap-2">
              <input type="radio" name="restore-penalty" className="mt-1" checked={penaltyChoice === "keep"} onChange={() => setPenaltyChoice("keep")} />
              <span><span className="block font-semibold">Ripristina mantenendo la penale</span><span className="block text-xs text-slate-500">Caso amministrativo particolare: richiede una seconda conferma.</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="restore-penalty" className="mt-1" checked={penaltyChoice === "cancel"} onChange={() => setPenaltyChoice("cancel")} />
              <span className="font-semibold">Annulla operazione</span>
            </label>
          </div>
          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setStep("form")} disabled={busy}>Indietro</button>
            <button
              type="button"
              className="btn-primary px-4 py-2 text-sm"
              disabled={busy || (penaltyChoice === "void" && voidReason.trim().length < 3)}
              onClick={() => {
                if (penaltyChoice === "cancel") onClose();
                else if (penaltyChoice === "keep") setStep("keep_confirm");
                else void submit("void", voidReason.trim());
              }}
            >
              {busy ? "Ripristino..." : penaltyChoice === "void" ? "Annulla penale e ripristina" : penaltyChoice === "keep" ? "Continua" : "Chiudi"}
            </button>
          </div>
        </>
      ) : step === "keep_confirm" ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">Confermi di mantenere la penale?</h2>
          <p className="mt-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            La prenotazione tornerà attiva ma la penale di {realPenalties.map(penaltyText).join(" + ")} resterà registrata e valida. Nessuna email verrà inviata all&apos;agenzia.
          </p>
          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setStep("penalty")} disabled={busy}>Indietro</button>
            <button type="button" className="btn-primary bg-amber-600 px-4 py-2 text-sm hover:bg-amber-700" onClick={() => void submit("keep")} disabled={busy}>
              {busy ? "Ripristino..." : "Sì, ripristina mantenendo la penale"}
            </button>
          </div>
        </>
      ) : service ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">Vuoi ripristinare la prenotazione di {(service.customer_name ?? "").toUpperCase()}?</h2>
          <SummaryTable rows={[
            ["Pratica", service.practice_label],
            ["Cliente", (service.customer_name ?? "—").toUpperCase()],
            ["Agenzia", service.agency_name ?? "—"],
            ["Servizio", [legText(service), linked ? legText(linked) : null].filter(Boolean).join(" · ")],
            ["Cancellata", cancellation ? `${dateTime(cancellation.cancelled_at)}${cancellation.operator_name ? ` da ${cancellation.operator_name}` : ""}` : "—"],
            ...(cancellation?.reason ? [["Motivo", `${cancellation.reason}${cancellation.note ? ` (${cancellation.note})` : ""}`] as [string, string]] : []),
          ]} />
          {linked ? (
            <div className="mt-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              <p className="font-semibold">Questa pratica comprende Andata e Ritorno.</p>
              <label className="flex items-start gap-2">
                <input type="radio" name="restore-scope" className="mt-1" checked={scope === "leg"} onChange={() => setScope("leg")} />
                <span><span className="block font-semibold">Ripristina solo questa tratta</span><span className="block text-xs text-slate-500">{legText(service)}</span></span>
              </label>
              <label className={`flex items-start gap-2 ${linkedCancelled ? "" : "opacity-50"}`}>
                <input type="radio" name="restore-scope" className="mt-1" disabled={!linkedCancelled} checked={scope === "practice"} onChange={() => setScope("practice")} />
                <span><span className="block font-semibold">Ripristina entrambe le tratte</span><span className="block text-xs text-slate-500">{linkedCancelled ? `Anche ${legText(linked)}` : `${legText(linked)} è già attiva`}</span></span>
              </label>
            </div>
          ) : null}
          <p className="mt-4 text-xs text-slate-500">
            Non verranno ricreati autista, mezzo, allocazioni bus o navette: la prenotazione tornerà nelle liste operative come da assegnare.
          </p>
          <MedmarWarning warnings={medmar} />
          {service.status !== "cancelled" ? <p className="mt-3 text-sm text-slate-600">Questa tratta è già attiva.</p> : null}
          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onClose} disabled={busy}>Annulla</button>
            <button type="button" className="btn-primary bg-emerald-600 px-4 py-2 text-sm hover:bg-emerald-700" onClick={onPrimary} disabled={busy || targetIds.length === 0}>
              {busy ? "Ripristino..." : "Ripristina prenotazione"}
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

// ─── Modale penale ────────────────────────────────────────────────────────────

type PenaltyStep = "form" | "summary" | "done";

export function PenaltyDialog({ serviceId, onClose, onSaved }: { serviceId: string; onClose: () => void; onSaved: () => void }) {
  const { detail, error: loadError, reload } = useCancellationDetail(serviceId);
  const [scope, setScope] = useState<"leg" | "practice">("leg");
  const [type, setType] = useState<"none" | "fixed">("fixed");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<PenaltyStep>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ penaltyId: string; status: PenaltyEmailStatus; recipient: string | null; sentAt: string | null; error: string | null } | null>(null);
  const idempotencyKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const initialized = useRef(false);

  const service = detail?.service ?? null;
  const linked = detail?.linked_service ?? null;
  const practiceAllowed = Boolean(linked && linked.status === "cancelled" && service?.status === "cancelled");

  // Precompila dalla penale attiva (modifica).
  useEffect(() => {
    if (!detail || initialized.current) return;
    initialized.current = true;
    const current = detail.active_penalties.find((p) => p.service_id === detail.service.id || p.linked_service_id === detail.service.id);
    if (current) {
      setScope(current.scope);
      setType(current.penalty_type === "none" ? "none" : "fixed");
      if (current.penalty_type !== "none") setAmount((current.penalty_amount_cents / 100).toFixed(2).replace(".", ","));
      setNotes(current.penalty_notes ?? "");
    }
  }, [detail]);

  const targetIds = useMemo(() => {
    if (!service) return [] as string[];
    return scope === "practice" && linked ? [service.id, linked.id] : [service.id];
  }, [service, linked, scope]);
  const replaced = useMemo(
    () => (detail?.active_penalties ?? []).filter((p) => targetIds.includes(p.service_id) || (p.linked_service_id && targetIds.includes(p.linked_service_id))),
    [detail, targetIds]
  );
  const communicated = replaced.some(isCommunicated);
  const amountCents = type === "fixed" ? parseEuroToCents(amount) : 0;
  const amountValid = type === "none" || (amountCents !== null && amountCents > 0 && amountCents <= 9_999_900);
  const cancellation = service ? detail?.cancellation[service.id] ?? null : null;
  const emailRequired = type === "fixed" || communicated;

  const goSummary = () => {
    if (!amountValid) { setError("Inserisci un importo penale valido (es. 120,00)."); return; }
    setError(null);
    idempotencyKey.current = newIdempotencyKey();
    setStep("summary");
  };

  const confirm = async () => {
    if (inFlight.current || !idempotencyKey.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { res, body } = await authFetch(`/api/ops/services/${serviceId}/penalty`, {
        method: "POST",
        body: JSON.stringify({
          scope,
          penalty_type: type,
          amount_cents: type === "fixed" ? amountCents : 0,
          notes: notes.trim(),
          idempotency_key: idempotencyKey.current,
          expected_active_ids: replaced.map((p) => p.id),
          confirm_rectification: communicated,
        }),
      });
      if (!res.ok) {
        if (body.code === "stale_state" || body.code === "rectification_confirmation_required") {
          initialized.current = false;
          await reload();
          setStep("form");
        }
        setError(String(body.error ?? "Salvataggio penale non riuscito."));
        return;
      }
      const email = (body.email ?? {}) as { status?: PenaltyEmailStatus; recipient?: string | null; sent_at?: string | null; error?: string | null };
      setResult({
        penaltyId: String(body.penalty_id),
        status: email.status ?? "not_required",
        recipient: email.recipient ?? null,
        sentAt: email.sent_at ?? null,
        error: email.error ?? null,
      });
      setStep("done");
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Salvataggio penale non riuscito.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const penaltySummaryText = type === "none" ? "Nessuna penale" : amountCents ? eur(amountCents) : "—";

  return (
    <Modal onClose={onClose} busy={busy}>
      {!detail || !service ? (
        <p className="text-sm text-slate-500">{loadError ?? "Caricamento…"}</p>
      ) : step === "done" && result ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">Penale registrata</h2>
          <p className="mt-2 text-sm text-slate-700">Penale: <strong>{penaltySummaryText}</strong>{scope === "practice" ? " (intera pratica A/R)" : ""}</p>
          {result.status === "sent" ? (
            <p className="mt-2 text-sm text-emerald-700">Email {communicated ? "di rettifica " : ""}inviata a {result.recipient} il {dateTime(result.sentAt)}.</p>
          ) : result.status === "not_required" ? (
            <p className="mt-2 text-sm text-slate-600">Nessuna comunicazione all&apos;agenzia necessaria.</p>
          ) : result.status === "sending" || result.status === "pending" ? (
            <p className="mt-2 text-sm text-slate-600">Invio email in corso.</p>
          ) : (
            <div className="mt-2 space-y-2 text-sm font-semibold text-amber-800">
              <p>⚠ {result.status === "no_recipient" ? "Penale registrata – agenzia senza email" : "Penale registrata, email non inviata"}{result.error && result.status !== "no_recipient" ? `: ${result.error}` : ""}</p>
              <ResendPenaltyEmailButton penaltyId={result.penaltyId} channel="penalty" onDone={onSaved} />
            </div>
          )}
          <div className="mt-5 flex justify-end"><button type="button" className="btn-primary px-4 py-2 text-sm" onClick={onClose}>Chiudi</button></div>
        </>
      ) : step === "summary" ? (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">{communicated ? "Rettifica penale già comunicata" : "Stai per applicare una penale alla prenotazione"}</h2>
          {communicated ? (
            <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
              Questa penale è già stata comunicata all&apos;agenzia. La modifica genererà una rettifica.
            </p>
          ) : null}
          <SummaryTable rows={[
            ["Cliente", (service.customer_name ?? "—").toUpperCase()],
            ["Agenzia", service.agency_name ?? "—"],
            ["Pratica", service.practice_label],
            ["Riferita a", scope === "practice" ? "Intera pratica (A/R)" : "Questa tratta"],
            ...(communicated ? [["Penale precedente", replaced.map(penaltyText).join(" + ")] as [string, string]] : []),
            ["Penale", type === "none" ? "Nessuna penale" : "Importo fisso"],
            ["Importo", penaltySummaryText],
          ]} />
          <p className="mt-4 text-sm text-slate-600">
            {emailRequired
              ? `Confermando, la penale verrà registrata e verrà inviata una comunicazione email all'agenzia${detail.agency_recipient.email ? ` (${detail.agency_recipient.email})` : ""}.`
              : "Confermando, la scelta verrà registrata. Nessuna email verrà inviata all'agenzia."}
          </p>
          {emailRequired && !detail.agency_recipient.email ? (
            <p className="mt-2 text-sm font-semibold text-amber-800">⚠ Nessuna email agenzia trovata: la penale verrà registrata comunque.</p>
          ) : null}
          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={() => setStep("form")} disabled={busy}>Annulla</button>
            <button type="button" className="btn-primary bg-rose-600 px-4 py-2 text-sm hover:bg-rose-700" onClick={() => void confirm()} disabled={busy}>
              {busy ? "Salvataggio..." : communicated ? "Modifica penale e invia rettifica" : emailRequired ? "Conferma penale e invia email" : "Conferma nessuna penale"}
            </button>
          </div>
        </>
      ) : (
        <>
          <h2 className="text-lg font-extrabold text-slate-950">{replaced.length ? "Modifica penale" : "Gestisci penale"}</h2>
          {communicated ? (
            <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
              Questa penale è già stata comunicata all&apos;agenzia. La modifica genererà una rettifica.
            </p>
          ) : null}
          <SummaryTable rows={[
            ["Cliente", (service.customer_name ?? "—").toUpperCase()],
            ["Agenzia", service.agency_name ?? "—"],
            ["Pratica", service.practice_label],
            ["Data cancellazione", dateTime(cancellation?.cancelled_at)],
            ...(replaced.length ? [["Penale attuale", replaced.map(penaltyText).join(" + ")] as [string, string]] : []),
          ]} />
          {detail.legacy_request_penalties.length ? (
            <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Attenzione: su questa pratica risulta già una penale dal flusso richieste di cancellazione ({detail.legacy_request_penalties.map((r) => eur(r.penalty_cents)).join(", ")}). Evita di registrarla due volte.
            </p>
          ) : null}
          {linked ? (
            <div className="mt-4 space-y-2 text-sm text-slate-700">
              <p className="font-semibold">Penale riferita a:</p>
              <label className="flex items-start gap-2">
                <input type="radio" name="penalty-scope" className="mt-1" checked={scope === "leg"} onChange={() => setScope("leg")} />
                <span><span className="block font-semibold">Questa tratta</span><span className="block text-xs text-slate-500">{legText(service)}</span></span>
              </label>
              <label className={`flex items-start gap-2 ${practiceAllowed ? "" : "opacity-50"}`}>
                <input type="radio" name="penalty-scope" className="mt-1" disabled={!practiceAllowed} checked={scope === "practice"} onChange={() => setScope("practice")} />
                <span>
                  <span className="block font-semibold">Intera pratica (andata e ritorno)</span>
                  <span className="block text-xs text-slate-500">{practiceAllowed ? "Un solo importo per tutta la pratica, non duplicato sulle due tratte." : `${legText(linked)} non è cancellata`}</span>
                </span>
              </label>
            </div>
          ) : null}
          <div className="mt-4 space-y-2 text-sm text-slate-700">
            <label className="flex items-center gap-2">
              <input type="radio" name="penalty-type" checked={type === "none"} onChange={() => setType("none")} />
              <span className="font-semibold">Nessuna penale</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="penalty-type" checked={type === "fixed"} onChange={() => setType("fixed")} />
              <span className="font-semibold">Penale con importo fisso</span>
            </label>
            {type === "fixed" ? (
              <label className="block pl-6 text-sm font-medium text-slate-700">
                Importo penale €
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Es. 120,00" className="input-saas mt-1 w-full" />
              </label>
            ) : null}
          </div>
          <label className="mt-4 block text-sm font-medium text-slate-700">
            Motivo / note penale (facoltativo)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} className="input-saas mt-1 min-h-[70px] w-full" />
          </label>
          {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-secondary px-4 py-2 text-sm" onClick={onClose}>Annulla</button>
            <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={goSummary} disabled={!amountValid}>Continua</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ─── Pulsanti per la card ─────────────────────────────────────────────────────

export function CancelledBookingButtons({ serviceId, state, onRestored, onPenaltyChanged, buttonClassName = "btn-secondary" }: {
  serviceId: string;
  state: CancelledBookingState | undefined;
  onRestored: (restoredIds: string[]) => void;
  onPenaltyChanged: () => void;
  buttonClassName?: string;
}) {
  const [dialog, setDialog] = useState<"restore" | "penalty" | null>(null);
  return (
    <>
      <button type="button" onClick={() => setDialog("restore")} className={`${buttonClassName} text-emerald-700`}>Ripristina prenotazione</button>
      <button type="button" onClick={() => setDialog("penalty")} className={`${buttonClassName} text-indigo-700`}>
        {state?.active_penalty ? "Modifica penale" : "Gestisci penale"}
      </button>
      {dialog === "restore" ? <RestoreBookingDialog serviceId={serviceId} onClose={() => setDialog(null)} onRestored={onRestored} /> : null}
      {dialog === "penalty" ? <PenaltyDialog serviceId={serviceId} onClose={() => setDialog(null)} onSaved={onPenaltyChanged} /> : null}
    </>
  );
}
