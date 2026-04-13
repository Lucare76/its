"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";

type AgencyProfile = {
  id: string;
  name?: string | null;
  legal_name?: string | null;
  billing_name?: string | null;
  contact_email?: string | null;
  booking_email?: string | null;
  phone?: string | null;
  vat_number?: string | null;
  pec_email?: string | null;
  sdi_code?: string | null;
  notes?: string | null;
  setup_required?: boolean;
};

type PendingChange = {
  id: string;
  status: "pending" | "rejected";
  changes: Record<string, unknown>;
  rejection_note: string | null;
  acknowledged_at: string | null;
  created_at: string;
};

type FormState = {
  name: string;
  legal_name: string;
  billing_name: string;
  contact_email: string;
  booking_email: string;
  phone: string;
  vat_number: string;
  pec_email: string;
  sdi_code: string;
  notes: string;
};

const emptyForm: FormState = {
  name: "",
  legal_name: "",
  billing_name: "",
  contact_email: "",
  booking_email: "",
  phone: "",
  vat_number: "",
  pec_email: "",
  sdi_code: "",
  notes: ""
};

const FIELD_LABELS: Record<string, string> = {
  name: "Nome agenzia",
  legal_name: "Ragione sociale",
  billing_name: "Intestazione fattura",
  contact_email: "Email contatto",
  booking_email: "Email prenotazioni",
  phone: "Telefono",
  vat_number: "Partita IVA",
  pec_email: "PEC",
  sdi_code: "Codice SDI",
  notes: "Note"
};

export default function AgencyProfileSetupPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const [message, setMessage] = useState("Carichiamo la tua anagrafica agenzia.");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [isFirstSetup, setIsFirstSetup] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setLoading(false);
        setMessage("Supabase non configurato.");
        return;
      }

      const session = await supabase.auth.getSession();
      if (!active) return;
      const token = session.data.session?.access_token;
      if (!token) {
        setLoading(false);
        setMessage("Sessione non valida. Rifai login.");
        return;
      }

      const response = await fetch("/api/agency/profile", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const body = (await response.json().catch(() => null)) as {
        agency?: AgencyProfile;
        pending_change?: PendingChange | null;
        error?: string;
      } | null;
      if (!active) return;
      if (!response.ok || !body?.agency) {
        setLoading(false);
        setMessage(body?.error ?? "Errore caricamento anagrafica agenzia.");
        return;
      }

      const agency = body.agency;
      setIsFirstSetup(agency.setup_required ?? false);
      setPendingChange(body.pending_change ?? null);
      setForm({
        name: agency.name ?? "",
        legal_name: agency.legal_name ?? agency.name ?? "",
        billing_name: agency.billing_name ?? agency.legal_name ?? agency.name ?? "",
        contact_email: agency.contact_email ?? "",
        booking_email: agency.booking_email ?? agency.contact_email ?? "",
        phone: agency.phone ?? "",
        vat_number: agency.vat_number ?? "",
        pec_email: agency.pec_email ?? "",
        sdi_code: agency.sdi_code ?? "",
        notes: agency.notes ?? ""
      });
      setLoading(false);
      setMessage(
        agency.setup_required
          ? "Completa ora la scheda agenzia per attivare l'area operativa."
          : "Profilo agenzia gia completo. Puoi comunque aggiornarlo."
      );
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasSupabaseEnv || !supabase || saving) return;

    setSaving(true);
    setMessage(isFirstSetup ? "Salvataggio anagrafica agenzia..." : "Invio richiesta di modifica...");

    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) {
      setSaving(false);
      setMessage("Sessione non valida. Rifai login.");
      return;
    }

    const response = await fetch("/api/agency/profile", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(form)
    });
    const body = (await response.json().catch(() => null)) as {
      first_setup?: boolean;
      pending_approval?: boolean;
      error?: string;
    } | null;

    if (!response.ok) {
      setSaving(false);
      setMessage(body?.error ?? "Salvataggio profilo non riuscito.");
      return;
    }

    setSaving(false);

    if (body?.first_setup) {
      setMessage("Profilo agenzia completato. Ti portiamo nell'area operativa.");
      router.replace("/agency");
      router.refresh();
      return;
    }

    if (body?.pending_approval) {
      setMessage("Modifica inviata. L'operatore la verificherà a breve.");
      setPendingChange({
        id: "",
        status: "pending",
        changes: form as unknown as Record<string, unknown>,
        rejection_note: null,
        acknowledged_at: null,
        created_at: new Date().toISOString()
      });
      return;
    }
  };

  const handleAcknowledge = async () => {
    if (!hasSupabaseEnv || !supabase || !pendingChange?.id || acknowledging) return;
    setAcknowledging(true);

    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    if (!token) { setAcknowledging(false); return; }

    await fetch("/api/ops/agency-profile-changes", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "acknowledge", change_id: pendingChange.id })
    });

    setAcknowledging(false);
    setPendingChange(null);
    setMessage("Presa visione registrata. Puoi inviare una nuova modifica.");
  };

  // Blocca il form se c'è una modifica pending non ancora risolta
  const isBlocked = !isFirstSetup && pendingChange?.status === "pending";
  // Mostra il banner rifiuto se c'è un rifiuto non ancora acknowledged
  const isRejected = !isFirstSetup && pendingChange?.status === "rejected" && !pendingChange.acknowledged_at;

  return (
    <section className="page-section">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="card p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            {isFirstSetup ? "Primo accesso agenzia" : "Profilo agenzia"}
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-text">
            {isFirstSetup ? "Completa la tua anagrafica" : "Modifica profilo"}
          </h1>
          {isFirstSetup ? (
            <p className="mt-2 text-sm text-muted">
              Prima di usare l&apos;area agenzia chiediamo i dati minimi amministrativi e operativi. Ti basta compilarli una sola volta.
            </p>
          ) : null}
          <p className="mt-3 text-sm text-slate-600">{message}</p>
        </header>

        {/* Banner: modifica in attesa di approvazione */}
        {isBlocked ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Modifica in attesa di approvazione</p>
            <p className="mt-1 text-xs text-amber-700">
              Hai inviato una richiesta di modifica il {pendingChange?.created_at ? new Date(pendingChange.created_at).toLocaleDateString("it-IT") : "—"}.
              L&apos;operatore la verificherà a breve. Non puoi inviare un&apos;altra modifica fino all&apos;esito.
            </p>
            <div className="mt-3 grid gap-1">
              {Object.entries(pendingChange?.changes ?? {}).map(([key, value]) => (
                <p key={key} className="text-xs text-amber-800">
                  <span className="font-semibold">{FIELD_LABELS[key] ?? key}:</span> {String(value ?? "—")}
                </p>
              ))}
            </div>
          </div>
        ) : null}

        {/* Banner: modifica rifiutata — presa visione */}
        {isRejected ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-3">
            <p className="text-sm font-semibold text-rose-900">Modifica rifiutata dall&apos;operatore</p>
            {pendingChange?.rejection_note ? (
              <p className="text-sm text-rose-800">
                <span className="font-semibold">Motivazione:</span> {pendingChange.rejection_note}
              </p>
            ) : null}
            <p className="text-xs text-rose-700">
              Clicca &quot;Presa visione&quot; per confermare di aver letto la motivazione. Potrai poi inviare una nuova modifica.
            </p>
            <button
              type="button"
              onClick={() => void handleAcknowledge()}
              disabled={acknowledging || !pendingChange?.id}
              className="rounded-xl bg-rose-700 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-800 disabled:opacity-60"
            >
              {acknowledging ? "Registrazione..." : "Presa visione"}
            </button>
          </div>
        ) : null}

        <form onSubmit={(e) => void handleSubmit(e)} className="card grid gap-4 p-5 md:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Nome agenzia</span>
            <input
              className="input-saas"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Agenzia Ischia Travel"
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Ragione sociale</span>
            <input
              className="input-saas"
              value={form.legal_name}
              onChange={(event) => setForm((prev) => ({ ...prev, legal_name: event.target.value }))}
              placeholder="Ischia Travel S.r.l."
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Intestazione fatturazione</span>
            <input
              className="input-saas"
              value={form.billing_name}
              onChange={(event) => setForm((prev) => ({ ...prev, billing_name: event.target.value }))}
              placeholder="Ischia Travel S.r.l."
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Telefono</span>
            <input
              className="input-saas"
              value={form.phone}
              onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
              placeholder="+39 081 ..."
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Email contatto</span>
            <input
              type="email"
              className="input-saas"
              value={form.contact_email}
              onChange={(event) => setForm((prev) => ({ ...prev, contact_email: event.target.value }))}
              placeholder="info@agenzia.it"
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Email prenotazioni</span>
            <input
              type="email"
              className="input-saas"
              value={form.booking_email}
              onChange={(event) => setForm((prev) => ({ ...prev, booking_email: event.target.value }))}
              placeholder="booking@agenzia.it"
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Partita IVA</span>
            <input
              className="input-saas"
              value={form.vat_number}
              onChange={(event) => setForm((prev) => ({ ...prev, vat_number: event.target.value }))}
              placeholder="IT12345678901"
              required
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">PEC</span>
            <input
              type="email"
              className="input-saas"
              value={form.pec_email}
              onChange={(event) => setForm((prev) => ({ ...prev, pec_email: event.target.value }))}
              placeholder="pec@pec.it"
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Codice SDI</span>
            <input
              className="input-saas"
              value={form.sdi_code}
              onChange={(event) => setForm((prev) => ({ ...prev, sdi_code: event.target.value }))}
              placeholder="XXXXXXX"
              disabled={loading || saving || isBlocked}
            />
          </label>

          <label className="grid gap-1 md:col-span-2">
            <span className="text-sm font-medium text-text">Note</span>
            <textarea
              className="input-saas min-h-28"
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="Preferenze operative, orari, riferimenti amministrativi..."
              disabled={loading || saving || isBlocked}
            />
          </label>

          <div className="md:col-span-2">
            {isBlocked ? (
              <p className="text-xs text-amber-700">Il form è bloccato in attesa di approvazione operatore.</p>
            ) : (
              <button type="submit" className="btn-primary" disabled={loading || saving}>
                {saving
                  ? (isFirstSetup ? "Salvataggio..." : "Invio richiesta...")
                  : (isFirstSetup ? "Attiva area agenzia" : "Invia richiesta di modifica")}
              </button>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}
