"use client";

import { FormEvent, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui";
import { hasSupabaseEnv, supabase, getToken} from "@/lib/supabase/client";

type TenantProfile = {
  id: string;
  name: string;
  legal_name: string | null;
  address: string | null;
  vat_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  website_url: string | null;
};

type BankSettings = {
  iban: string;
  swift_code: string;
  bank_account_holder: string;
  payment_instructions: string;
};

const EMPTY: TenantProfile = {
  id: "", name: "", legal_name: "", address: "",
  vat_number: "", contact_email: "", contact_phone: "", website_url: "",
};

const EMPTY_BANK: BankSettings = {
  iban: "", swift_code: "", bank_account_holder: "", payment_instructions: "",
};



export default function TenantSettingsPage() {
  const [form, setForm]       = useState<TenantProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const [bank, setBank]       = useState<BankSettings>(EMPTY_BANK);
  const [savingBank, setSavingBank] = useState(false);
  const [bankMsg, setBankMsg] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    if (!hasSupabaseEnv) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const [profileRes, bankRes] = await Promise.all([
        fetch("/api/admin/tenant-settings",       { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/ops/tenant-quote-settings",   { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (profileRes.ok) {
        const data = (await profileRes.json()) as TenantProfile;
        setForm({
          ...data,
          legal_name:    data.legal_name    ?? "",
          address:       data.address       ?? "",
          vat_number:    data.vat_number    ?? "",
          contact_email: data.contact_email ?? "",
          contact_phone: data.contact_phone ?? "",
          website_url:   data.website_url   ?? "",
        });
      }
      if (bankRes.ok) {
        const bd = (await bankRes.json()) as { iban?: string | null; swift_code?: string | null; bank_account_holder?: string | null; payment_instructions?: string | null };
        setBank({
          iban:                 bd.iban                 ?? "",
          swift_code:           bd.swift_code           ?? "",
          bank_account_holder:  bd.bank_account_holder  ?? "",
          payment_instructions: bd.payment_instructions ?? "",
        });
      }
      setLoading(false);
    })();
  }, []);

  const set = (field: keyof TenantProfile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const setB = (field: keyof BankSettings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setBank((f) => ({ ...f, [field]: e.target.value }));

  const handleBankSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingBank(true);
    setBankMsg(null);
    try {
      const token = await getToken();
      if (!token) { setBankMsg({ text: "Sessione non valida.", ok: false }); return; }
      const res = await fetch("/api/ops/tenant-quote-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          iban:                 bank.iban                 || null,
          swift_code:           bank.swift_code           || null,
          bank_account_holder:  bank.bank_account_holder  || null,
          payment_instructions: bank.payment_instructions || null,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      setBankMsg(res.ok ? { text: "Dati bancari salvati.", ok: true } : { text: body.error ?? "Errore salvataggio.", ok: false });
    } catch {
      setBankMsg({ text: "Errore di rete.", ok: false });
    } finally {
      setSavingBank(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const token = await getToken();
      if (!token) { setMessage({ text: "Sessione non valida.", ok: false }); return; }
      const res = await fetch("/api/admin/tenant-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name:          form.name,
          legal_name:    form.legal_name    || null,
          address:       form.address       || null,
          vat_number:    form.vat_number    || null,
          contact_email: form.contact_email || null,
          contact_phone: form.contact_phone || null,
          website_url:   form.website_url   || null,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      setMessage(res.ok ? { text: "Dati salvati con successo.", ok: true } : { text: body.error ?? "Errore salvataggio.", ok: false });
    } catch {
      setMessage({ text: "Errore di rete.", ok: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page-section max-w-2xl">
      <PageHeader
        title="Profilo azienda"
        subtitle="Dati che appaiono su PDF, email e documenti inviati ai clienti."
        breadcrumbs={[{ label: "Impostazioni", href: "/settings" }, { label: "Profilo azienda" }]}
      />

      {loading ? (
        <div className="card p-6 text-sm text-slate-500">Caricamento...</div>
      ) : (
        <>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">

          {/* Nome operativo */}
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">Identità</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                Nome operativo <span className="text-rose-500">*</span>
                <input
                  type="text" required
                  className="input-saas mt-1 w-full"
                  value={form.name}
                  onChange={set("name")}
                  placeholder="Ischia Transfer Service"
                />
                <p className="mt-1 text-xs text-slate-400">Usato nell&apos;intestazione email e dashboard.</p>
              </label>
              <label className="text-sm">
                Ragione sociale
                <input
                  type="text"
                  className="input-saas mt-1 w-full"
                  value={form.legal_name ?? ""}
                  onChange={set("legal_name")}
                  placeholder="Ischia Transfer Service S.r.l."
                />
                <p className="mt-1 text-xs text-slate-400">Nome legale completo nei documenti.</p>
              </label>
            </div>
          </div>

          {/* Dati fiscali */}
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">Dati fiscali</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                P.IVA
                <input
                  type="text"
                  className="input-saas mt-1 w-full"
                  value={form.vat_number ?? ""}
                  onChange={set("vat_number")}
                  placeholder="IT 05931311210"
                />
              </label>
              <label className="text-sm">
                Indirizzo sede legale
                <input
                  type="text"
                  className="input-saas mt-1 w-full"
                  value={form.address ?? ""}
                  onChange={set("address")}
                  placeholder="Via Cilento 14/C, 80077 Ischia (NA)"
                />
              </label>
            </div>
          </div>

          {/* Contatti */}
          <div className="card p-5 space-y-4">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">Contatti</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                Email di contatto
                <input
                  type="email"
                  className="input-saas mt-1 w-full"
                  value={form.contact_email ?? ""}
                  onChange={set("contact_email")}
                  placeholder="info@ischiatransferservice.it"
                />
                <p className="mt-1 text-xs text-slate-400">Mostrata nel footer delle email.</p>
              </label>
              <label className="text-sm">
                Telefono
                <input
                  type="tel"
                  className="input-saas mt-1 w-full"
                  value={form.contact_phone ?? ""}
                  onChange={set("contact_phone")}
                  placeholder="+39 081 000 0000"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                Sito web
                <input
                  type="url"
                  className="input-saas mt-1 w-full"
                  value={form.website_url ?? ""}
                  onChange={set("website_url")}
                  placeholder="https://ischiatransferservice.it"
                />
              </label>
            </div>
          </div>

          {message && (
            <p className={`rounded-xl px-4 py-2 text-sm font-medium ${message.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
              {message.ok ? "✓" : "✗"} {message.text}
            </p>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="btn-primary px-6 py-2 disabled:opacity-50">
              {saving ? "Salvataggio…" : "Salva modifiche"}
            </button>
          </div>
        </form>

        {/* ── Dati bancari per i preventivi ─────────────────────────────── */}
        <form onSubmit={(e) => void handleBankSubmit(e)} className="space-y-4 mt-4">
          <div className="card p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">Dati bancari per preventivi</h2>
              <p className="text-xs text-slate-400 mt-0.5">Pre-compilati automaticamente in ogni nuovo preventivo. Sempre modificabili sul singolo preventivo.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm sm:col-span-2">
                IBAN
                <input
                  type="text"
                  className="input-saas mt-1 w-full font-mono"
                  value={bank.iban}
                  onChange={setB("iban")}
                  placeholder="IT60 X054 2811 1010 0000 0123 456"
                />
              </label>
              <label className="text-sm">
                SWIFT / BIC
                <input
                  type="text"
                  className="input-saas mt-1 w-full font-mono uppercase"
                  value={bank.swift_code}
                  onChange={setB("swift_code")}
                  placeholder="BCITITMM"
                />
              </label>
              <label className="text-sm">
                Intestatario conto
                <input
                  type="text"
                  className="input-saas mt-1 w-full"
                  value={bank.bank_account_holder}
                  onChange={setB("bank_account_holder")}
                  placeholder="ISCHIA TRANSFER SERVICE SRL"
                />
              </label>
              <label className="text-sm sm:col-span-2">
                Istruzioni pagamento aggiuntive
                <textarea
                  className="input-saas mt-1 w-full resize-none"
                  rows={2}
                  value={bank.payment_instructions}
                  onChange={setB("payment_instructions")}
                  placeholder="Es: Indicare cognome e numero preventivo nella causale."
                />
              </label>
            </div>
          </div>

          {bankMsg && (
            <p className={`rounded-xl px-4 py-2 text-sm font-medium ${bankMsg.ok ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
              {bankMsg.ok ? "✓" : "✗"} {bankMsg.text}
            </p>
          )}

          <div className="flex justify-end">
            <button type="submit" disabled={savingBank} className="btn-primary px-6 py-2 disabled:opacity-50">
              {savingBank ? "Salvataggio…" : "Salva dati bancari"}
            </button>
          </div>
        </form>
        </>
      )}
    </section>
  );
}
