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

export default function AgencyProfileSetupPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("Carichiamo la tua anagrafica agenzia.");
  const [form, setForm] = useState<FormState>(emptyForm);

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
      const body = (await response.json().catch(() => null)) as { agency?: AgencyProfile; error?: string } | null;
      if (!active) return;
      if (!response.ok || !body?.agency) {
        setLoading(false);
        setMessage(body?.error ?? "Errore caricamento anagrafica agenzia.");
        return;
      }

      const agency = body.agency;
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
    setMessage("Salvataggio anagrafica agenzia...");

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
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      setSaving(false);
      setMessage(body?.error ?? "Salvataggio profilo non riuscito.");
      return;
    }

    setSaving(false);
    setMessage("Profilo agenzia completato. Ti portiamo nell'area operativa.");
    router.replace("/agency");
    router.refresh();
  };

  return (
    <section className="page-section">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="card p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">Primo accesso agenzia</p>
          <h1 className="mt-2 text-2xl font-semibold text-text">Completa la tua anagrafica</h1>
          <p className="mt-2 text-sm text-muted">
            Prima di usare l&apos;area agenzia chiediamo i dati minimi amministrativi e operativi. Ti basta compilarli una sola volta.
          </p>
          <p className="mt-3 text-sm text-slate-600">{message}</p>
        </header>

        <form onSubmit={handleSubmit} className="card grid gap-4 p-5 md:grid-cols-2">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Nome agenzia</span>
            <input
              className="input-saas"
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="Agenzia Ischia Travel"
              required
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
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
              disabled={loading || saving}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-text">Codice SDI</span>
            <input
              className="input-saas"
              value={form.sdi_code}
              onChange={(event) => setForm((prev) => ({ ...prev, sdi_code: event.target.value }))}
              placeholder="XXXXXXX"
              disabled={loading || saving}
            />
          </label>

          <label className="grid gap-1 md:col-span-2">
            <span className="text-sm font-medium text-text">Note</span>
            <textarea
              className="input-saas min-h-28"
              value={form.notes}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
              placeholder="Preferenze operative, orari, riferimenti amministrativi..."
              disabled={loading || saving}
            />
          </label>

          <div className="md:col-span-2">
            <button type="submit" className="btn-primary" disabled={loading || saving}>
              {saving ? "Salvataggio..." : "Attiva area agenzia"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
