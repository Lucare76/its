"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EmptyState, PageHeader, SectionCard } from "@/components/ui";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import { useTenantOperationalData } from "@/lib/supabase/use-tenant-operational-data";
import { STATEMENT_AGENCY_NAMES } from "@/lib/server/statement-agencies";

type AgencyRow = {
  id: string;
  name: string;
  legal_name?: string | null;
  billing_name: string | null;
  booking_email: string | null;
  contact_email: string | null;
  phone: string | null;
  sender_domains: string[] | null;
  default_enabled_booking_kinds: string[] | null;
  default_pricing_notes: string | null;
  notes: string | null;
  active: boolean;
  vat_number?: string | null;
  pec_email?: string | null;
  sdi_code?: string | null;
  parser_key_hint?: string | null;
  invoice_email?: string | null;
  invoice_cadence?: "weekly" | "biweekly" | "monthly" | null;
  invoice_send_day?: number | null;
  invoice_enabled?: boolean | null;
};

type PriceListRow = { id: string; agency_id: string | null; active: boolean };
type PricingRuleRow = { id: string; agency_id: string | null; active: boolean };

const DAY_LABELS = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const CADENCE_LABELS: Record<string, string> = {
  weekly: "Settimanale",
  biweekly: "Bisettimanale",
  monthly: "Mensile",
};

function addDays(dateIso: string, days: number) {
  const date = new Date(`${dateIso}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function invoiceScheduleLabel(agency: AgencyRow) {
  if (!agency.invoice_enabled) return null;
  const cadence = CADENCE_LABELS[agency.invoice_cadence ?? ""] ?? agency.invoice_cadence ?? "N/D";
  const day = typeof agency.invoice_send_day === "number" ? DAY_LABELS[agency.invoice_send_day] : "N/D";
  return `${cadence} · ${day}`;
}

// ── Tipo form modale ──────────────────────────────────────────────────────────

type ModalForm = {
  name: string;
  legal_name: string;
  billing_name: string;
  booking_email: string;
  contact_email: string;
  phone: string;
  vat_number: string;
  pec_email: string;
  sdi_code: string;
  sender_domains: string;
  default_enabled_booking_kinds: string;
  parser_key_hint: string;
  default_pricing_notes: string;
  notes: string;
  invoice_enabled: boolean;
  invoice_email: string;
  invoice_cadence: "weekly" | "biweekly" | "monthly";
  invoice_send_day: number;
};

const EMPTY_FORM: ModalForm = {
  name: "",
  legal_name: "",
  billing_name: "",
  booking_email: "",
  contact_email: "",
  phone: "",
  vat_number: "",
  pec_email: "",
  sdi_code: "",
  sender_domains: "",
  default_enabled_booking_kinds: "",
  parser_key_hint: "",
  default_pricing_notes: "",
  notes: "",
  invoice_enabled: false,
  invoice_email: "",
  invoice_cadence: "weekly",
  invoice_send_day: 1,
};

function agencyToForm(agency: AgencyRow): ModalForm {
  return {
    name: agency.name,
    legal_name: agency.legal_name ?? "",
    billing_name: agency.billing_name ?? "",
    booking_email: agency.booking_email ?? "",
    contact_email: agency.contact_email ?? "",
    phone: agency.phone ?? "",
    vat_number: agency.vat_number ?? "",
    pec_email: agency.pec_email ?? "",
    sdi_code: agency.sdi_code ?? "",
    sender_domains: (agency.sender_domains ?? []).join("\n"),
    default_enabled_booking_kinds: (agency.default_enabled_booking_kinds ?? []).join("\n"),
    parser_key_hint: agency.parser_key_hint ?? "",
    default_pricing_notes: agency.default_pricing_notes ?? "",
    notes: agency.notes ?? "",
    invoice_enabled: agency.invoice_enabled ?? false,
    invoice_email: agency.invoice_email ?? "",
    invoice_cadence: agency.invoice_cadence ?? "weekly",
    invoice_send_day: agency.invoice_send_day ?? 1,
  };
}

// ── Modal Crea / Modifica ─────────────────────────────────────────────────────

function AgencyModal({
  agency,
  onClose,
  onSaved,
  getToken,
}: {
  agency: AgencyRow | null;
  onClose: () => void;
  onSaved: () => void;
  getToken: () => Promise<string | null>;
}) {
  const isEdit = agency !== null;
  const [form, setForm] = useState<ModalForm>(isEdit ? agencyToForm(agency) : EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"info" | "contatti" | "fiscale" | "estratto">("info");

  const set =
    (field: keyof ModalForm) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value =
        e.target.type === "checkbox"
          ? (e.target as HTMLInputElement).checked
          : e.target.type === "number"
          ? Number(e.target.value)
          : e.target.value;
      setForm((f) => ({ ...f, [field]: value }));
    };

  const save = async () => {
    if (!form.name.trim()) {
      setError("Il nome agenzia è obbligatorio.");
      return;
    }
    setError(null);
    setSaving(true);
    const token = await getToken();
    if (!token) {
      setError("Sessione scaduta.");
      setSaving(false);
      return;
    }

    const payload = {
      name: form.name.trim(),
      legal_name: form.legal_name.trim() || null,
      billing_name: form.billing_name.trim() || null,
      booking_email: form.booking_email.trim() || null,
      contact_email: form.contact_email.trim() || null,
      phone: form.phone.trim() || null,
      vat_number: form.vat_number.trim() || null,
      pec_email: form.pec_email.trim() || null,
      sdi_code: form.sdi_code.trim() || null,
      sender_domains: form.sender_domains
        .split(/\n|,/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      default_enabled_booking_kinds: form.default_enabled_booking_kinds
        .split(/\n|,/)
        .map((s) => s.trim())
        .filter(Boolean),
      parser_key_hint: form.parser_key_hint.trim() || null,
      default_pricing_notes: form.default_pricing_notes.trim(),
      notes: form.notes.trim(),
      invoice_enabled: form.invoice_enabled,
      invoice_email: form.invoice_email.trim() || null,
      invoice_cadence: form.invoice_cadence,
      invoice_send_day: form.invoice_send_day,
    };

    if (isEdit) {
      const response = await fetch(`/api/agencies/${agency.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const json = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!json?.ok) {
        setError(json?.error ?? "Errore salvataggio.");
        setSaving(false);
        return;
      }
    } else {
      const response = await fetch("/api/pricing/agencies", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const json = (await response.json().catch(() => null)) as {
        ok?: boolean;
        id?: string;
        error?: string;
      } | null;
      if (!json?.ok) {
        setError(json?.error ?? "Errore creazione.");
        setSaving(false);
        return;
      }
      if (json.id && form.invoice_enabled) {
        await fetch(`/api/agencies/${json.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            invoice_enabled: true,
            invoice_email: form.invoice_email.trim() || null,
            invoice_cadence: form.invoice_cadence,
            invoice_send_day: form.invoice_send_day,
          }),
        });
      }
    }

    setSaving(false);
    onSaved();
    onClose();
  };

  const tabs: Array<{ key: typeof tab; label: string }> = [
    { key: "info", label: "Info base" },
    { key: "contatti", label: "Contatti" },
    { key: "fiscale", label: "Fiscale" },
    { key: "estratto", label: "Estratto conto" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <h2 className="text-base font-semibold text-slate-800">
            {isEdit ? `Modifica — ${agency.name}` : "Nuova agenzia"}
          </h2>
          <button type="button" onClick={onClose} className="text-xl leading-none text-slate-400 hover:text-slate-600">
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-slate-100 px-6 pt-2">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`rounded-t-lg px-3 py-2 text-xs font-semibold transition ${
                tab === t.key
                  ? "border-b-2 border-blue-500 text-blue-700"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {error && (
            <p className="mb-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-600">{error}</p>
          )}

          {tab === "info" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Nome agenzia <span className="text-rose-500">*</span>
                <input
                  className="input-saas mt-1 w-full"
                  value={form.name}
                  onChange={set("name")}
                  placeholder="es. Aleste Viaggi"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Nome legale
                <input
                  className="input-saas mt-1 w-full"
                  value={form.legal_name}
                  onChange={set("legal_name")}
                  placeholder="Ragione sociale"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Nome fatturazione
                <input
                  className="input-saas mt-1 w-full"
                  value={form.billing_name}
                  onChange={set("billing_name")}
                  placeholder="Come appare in fattura"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Domini email mittente (uno per riga)
                <textarea
                  rows={2}
                  className="input-saas mt-1 w-full resize-none"
                  value={form.sender_domains}
                  onChange={set("sender_domains")}
                  placeholder={"alesteviaggi.it\naleste.it"}
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Tipo servizi abilitati (uno per riga)
                <textarea
                  rows={2}
                  className="input-saas mt-1 w-full resize-none"
                  value={form.default_enabled_booking_kinds}
                  onChange={set("default_enabled_booking_kinds")}
                  placeholder={"transfer_port_hotel\nbus_line"}
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Codice parser email
                <input
                  className="input-saas mt-1 w-full font-mono"
                  value={form.parser_key_hint}
                  onChange={set("parser_key_hint")}
                  placeholder="es. aleste"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Note pricing
                <textarea
                  rows={2}
                  className="input-saas mt-1 w-full resize-none"
                  value={form.default_pricing_notes}
                  onChange={set("default_pricing_notes")}
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Note CRM
                <textarea
                  rows={2}
                  className="input-saas mt-1 w-full resize-none"
                  value={form.notes}
                  onChange={set("notes")}
                />
              </label>
            </div>
          )}

          {tab === "contatti" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500">
                Email booking
                <input
                  type="email"
                  className="input-saas mt-1 w-full"
                  value={form.booking_email}
                  onChange={set("booking_email")}
                  placeholder="biglietteria@agenzia.it"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Email contatto
                <input
                  type="email"
                  className="input-saas mt-1 w-full"
                  value={form.contact_email}
                  onChange={set("contact_email")}
                  placeholder="info@agenzia.it"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                Telefono
                <input
                  className="input-saas mt-1 w-full"
                  value={form.phone}
                  onChange={set("phone")}
                  placeholder="081 000 0000"
                />
              </label>
            </div>
          )}

          {tab === "fiscale" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-500">
                Partita IVA
                <input
                  className="input-saas mt-1 w-full font-mono"
                  value={form.vat_number}
                  onChange={set("vat_number")}
                  placeholder="IT00000000000"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500">
                Codice SDI
                <input
                  className="input-saas mt-1 w-full font-mono"
                  value={form.sdi_code}
                  onChange={set("sdi_code")}
                  placeholder="0000000"
                />
              </label>
              <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                PEC
                <input
                  type="email"
                  className="input-saas mt-1 w-full"
                  value={form.pec_email}
                  onChange={set("pec_email")}
                  placeholder="agenzia@pec.it"
                />
              </label>
            </div>
          )}

          {tab === "estratto" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <input
                  id="invoice-enabled"
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  checked={form.invoice_enabled}
                  onChange={(e) => setForm((f) => ({ ...f, invoice_enabled: e.target.checked }))}
                />
                <label htmlFor="invoice-enabled" className="cursor-pointer text-sm font-medium text-slate-700">
                  Abilita invio estratto conto automatico
                </label>
              </div>

              {form.invoice_enabled ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-semibold text-slate-500 sm:col-span-2">
                    Email destinatario
                    <input
                      type="email"
                      className="input-saas mt-1 w-full"
                      value={form.invoice_email}
                      onChange={set("invoice_email")}
                      placeholder="contabilita@agenzia.it"
                    />
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Cadenza invio
                    <select className="input-saas mt-1 w-full" value={form.invoice_cadence} onChange={set("invoice_cadence")}>
                      <option value="weekly">Settimanale (ogni settimana)</option>
                      <option value="biweekly">Bisettimanale (ogni 2 settimane)</option>
                      <option value="monthly">Mensile</option>
                    </select>
                  </label>
                  <label className="text-xs font-semibold text-slate-500">
                    Giorno di invio
                    <select
                      className="input-saas mt-1 w-full"
                      value={form.invoice_send_day}
                      onChange={(e) => setForm((f) => ({ ...f, invoice_send_day: Number(e.target.value) }))}
                    >
                      {DAY_LABELS.map((label, index) => (
                        <option key={index} value={index}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800 sm:col-span-2">
                    Verrà inviato a <strong>{form.invoice_email || "—"}</strong> ogni{" "}
                    <strong>{CADENCE_LABELS[form.invoice_cadence]?.toLowerCase()}</strong> di{" "}
                    <strong>{DAY_LABELS[form.invoice_send_day]}</strong>.
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  Abilita per configurare destinatario e cadenza.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <button type="button" onClick={onClose} className="btn-secondary px-4 py-2 text-sm">
            Annulla
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-50"
          >
            {saving ? "Salvataggio..." : isEdit ? "Salva modifiche" : "Crea agenzia"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Pagina principale ─────────────────────────────────────────────────────────

export default function CrmAgenciesPage() {
  const { data: tenantData } = useTenantOperationalData();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [agencies, setAgencies] = useState<AgencyRow[]>([]);
  const [priceLists, setPriceLists] = useState<PriceListRow[]>([]);
  const [rules, setRules] = useState<PricingRuleRow[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "statement" | "active">("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [modalAgency, setModalAgency] = useState<AgencyRow | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);

  const getToken = useCallback(async () => {
    if (!hasSupabaseEnv || !supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }, []);

  const load = useCallback(async () => {
    const token = await getToken();
    if (!token) {
      setErrorMessage("Sessione non valida.");
      setLoading(false);
      return;
    }
    const response = await fetch("/api/pricing/bootstrap", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = (await response.json().catch(() => null)) as {
      agencies?: AgencyRow[];
      price_lists?: PriceListRow[];
      pricing_rules?: PricingRuleRow[];
      error?: string;
    } | null;
    if (!response.ok) {
      setErrorMessage(body?.error ?? "Errore caricamento CRM.");
      setLoading(false);
      return;
    }
    setAgencies(body?.agencies ?? []);
    setPriceLists(body?.price_lists ?? []);
    setRules(body?.pricing_rules ?? []);
    setLoading(false);
  }, [getToken]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  function showToast(text: string, ok: boolean) {
    setToast({ text, ok });
    setTimeout(() => setToast(null), 3000);
  }

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleDelete = async (agency: AgencyRow) => {
    if (!confirm(`Eliminare l'agenzia "${agency.name}"? Questa operazione non può essere annullata.`)) return;
    const token = await getToken();
    if (!token) return;
    setDeletingId(agency.id);
    const response = await fetch("/api/pricing/agencies", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ agency_id: agency.id }),
    });
    setDeletingId(null);
    if (!response.ok) {
      showToast("Errore eliminazione.", false);
      return;
    }
    showToast(`"${agency.name}" eliminata.`, true);
    void load();
  };

  const activeAgencies = agencies.filter((a) => a.active);
  const today = new Date().toISOString().slice(0, 10);
  const window48h = addDays(today, 2);
  const nextSunday = (() => {
    const date = new Date(`${today}T12:00:00`);
    const delta = date.getDay() === 0 ? 7 : 7 - date.getDay();
    date.setDate(date.getDate() + delta);
    return date.toISOString().slice(0, 10);
  })();

  const now = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);

  const handleToggleActive = async (agency: AgencyRow) => {
    const token = await getToken();
    if (!token) return;
    const response = await fetch(`/api/agencies/${agency.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ active: !agency.active }),
    });
    if (response.ok) {
      showToast(`"${agency.name}" ${agency.active ? "disattivata" : "attivata"}.`, true);
      void load();
    } else {
      showToast("Errore aggiornamento stato.", false);
    }
  };

  const agencyStats = useMemo(
    () =>
      agencies
        .map((agency) => {
          const services = tenantData.services.filter(
            (s) => (s.billing_party_name ?? "").trim() === agency.name
          );
          const serviceMix = services.reduce<Record<string, number>>((acc, s) => {
            const key = s.service_type_code ?? s.booking_service_kind ?? "altri";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {});
          const sorted = [...services].sort((a, b) => b.date.localeCompare(a.date));
          const revenueTotal = services.reduce((sum, s) => sum + ((s as any).source_total_amount_cents ?? 0), 0);
          const thisMonth = services.filter((s) => s.date >= thisMonthStart).length;
          const prevMonth = services.filter((s) => s.date >= prevMonthStart && s.date <= prevMonthEnd).length;
          return {
            agency,
            lists: priceLists.filter((p) => p.agency_id === agency.id && p.active).length,
            rules: rules.filter((r) => r.agency_id === agency.id && r.active).length,
            services: services.length,
            pax: services.reduce((sum, s) => sum + s.pax, 0),
            revenueTotal,
            thisMonth,
            prevMonth,
            latestDate: sorted[0]?.date ?? null,
            next48h: services.filter((s) => s.date >= today && s.date <= window48h).length,
            nextSundayBus: services.filter(
              (s) => s.date === nextSunday && s.service_type_code === "bus_line"
            ).length,
            serviceMix,
            recentServices: sorted.slice(0, 6),
            statementEnabled: STATEMENT_AGENCY_NAMES.includes(agency.name),
          };
        })
        .filter(({ agency, statementEnabled }) => {
          const text =
            `${agency.name} ${agency.billing_name ?? ""} ${agency.booking_email ?? ""}`.toLowerCase();
          return (
            (!search.trim() || text.includes(search.trim().toLowerCase())) &&
            (filter === "all" ||
              (filter === "statement" && statementEnabled) ||
              (filter === "active" && agency.active))
          );
        }),
    [agencies, filter, nextSunday, priceLists, prevMonthEnd, prevMonthStart, rules, search, tenantData.services, thisMonthStart, today, window48h]
  );

  return (
    <section className="page-section">
      <PageHeader
        title="CRM Agenzie"
        subtitle="Contatti, estratto conto, regole operative e statistiche per agenzia."
        breadcrumbs={[{ label: "Operazioni", href: "/dashboard" }, { label: "CRM Agenzie" }]}
        actions={
          <button
            type="button"
            className="btn-primary px-4 py-2 text-sm"
            onClick={() => {
              setModalAgency(null);
              setModalOpen(true);
            }}
          >
            + Nuova agenzia
          </button>
        }
      />

      {/* Toast */}
      {toast ? (
        <div
          className={`fixed bottom-6 right-6 z-50 rounded-xl border px-4 py-3 text-sm font-medium shadow-lg ${
            toast.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {toast.text}
        </div>
      ) : null}

      {errorMessage ? (
        <EmptyState title="CRM non disponibile" description={errorMessage} compact />
      ) : null}

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Agenzie attive", value: activeAgencies.length },
          { label: "Listini attivi", value: priceLists.filter((p) => p.active).length },
          { label: "Regole attive", value: rules.filter((r) => r.active).length },
        ].map((stat) => (
          <div key={stat.label} className="rounded-2xl border border-border bg-white px-5 py-4 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{stat.label}</p>
            <p className="mt-1 text-3xl font-semibold text-slate-800">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filtri */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 shadow-sm">
        <label className="text-xs font-semibold text-slate-500">
          Cerca
          <input
            className="input-saas mt-1 min-w-52"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Nome, fatturazione o email"
          />
        </label>
        <label className="text-xs font-semibold text-slate-500">
          Vista
          <select
            className="input-saas mt-1 min-w-40"
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
          >
            <option value="all">Tutte</option>
            <option value="statement">Solo estratto conto</option>
            <option value="active">Solo attive</option>
          </select>
        </label>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"
            onClick={() => setExpandedIds(new Set(agencyStats.map((s) => s.agency.id)))}
          >
            Espandi tutte
          </button>
          <button
            type="button"
            className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-500 hover:bg-slate-50"
            onClick={() => setExpandedIds(new Set())}
          >
            Comprimi tutte
          </button>
        </div>
      </div>

      {/* Schede agenzie */}
      <SectionCard title="Schede agenzia" loading={loading} loadingLines={4}>
        {agencyStats.length === 0 ? (
          <p className="text-sm text-muted">Nessuna agenzia trovata.</p>
        ) : (
          <div className="space-y-3">
            {agencyStats.map(
              ({
                agency,
                lists,
                rules: agencyRules,
                services,
                pax,
                revenueTotal,
                thisMonth,
                prevMonth,
                latestDate,
                next48h,
                nextSundayBus,
                serviceMix,
                recentServices,
              }) => {
                const trendDiff = thisMonth - prevMonth;
                const trendLabel = trendDiff > 0 ? `+${trendDiff}` : trendDiff < 0 ? `${trendDiff}` : "=";
                const trendColor = trendDiff > 0 ? "text-emerald-600" : trendDiff < 0 ? "text-rose-500" : "text-slate-400";
                const expanded = expandedIds.has(agency.id);
                const schedule = invoiceScheduleLabel(agency);

                return (
                  <article
                    key={agency.id}
                    className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
                  >
                    {/* Header sempre visibile */}
                    <div
                      className="flex cursor-pointer select-none items-center gap-3 px-5 py-4 transition hover:bg-slate-50/60"
                      onClick={() => toggleExpand(agency.id)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-semibold text-slate-800">{agency.name}</h3>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                              agency.active
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {agency.active ? "attiva" : "inattiva"}
                          </span>
                          {schedule ? (
                            <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                              {schedule}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-xs text-slate-400">
                          {agency.billing_name ?? "Fatturazione non impostata"}
                          {agency.booking_email ? ` · ${agency.booking_email}` : ""}
                        </p>
                      </div>

                      {/* Quick stats */}
                      <div className="hidden shrink-0 items-center gap-4 text-xs text-slate-500 sm:flex">
                        <span>
                          <span className="font-semibold text-slate-700">{services}</span> servizi
                        </span>
                        <span>
                          <span className="font-semibold text-slate-700">{pax}</span> pax
                        </span>
                        {revenueTotal > 0 && (
                          <span className="font-semibold text-slate-700">
                            €{(revenueTotal / 100).toLocaleString("it-IT", { maximumFractionDigits: 0 })}
                          </span>
                        )}
                        <span className={`font-semibold ${trendColor}`} title="Questo mese vs mese scorso">
                          {thisMonth} ({trendLabel})
                        </span>
                        {next48h > 0 && (
                          <span className="font-semibold text-amber-600">+48h: {next48h}</span>
                        )}
                      </div>

                      {/* Azioni */}
                      <div
                        className="flex shrink-0 items-center gap-1.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                          onClick={() => {
                            setModalAgency(agency);
                            setModalOpen(true);
                          }}
                        >
                          Modifica
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(agency)}
                          className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                            agency.active
                              ? "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
                              : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {agency.active ? "Disattiva" : "Attiva"}
                        </button>
                        <button
                          type="button"
                          disabled={deletingId === agency.id}
                          className="rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                          onClick={() => void handleDelete(agency)}
                        >
                          {deletingId === agency.id ? "..." : "Elimina"}
                        </button>
                        <span
                          className={`ml-1 text-slate-400 transition-transform duration-200 text-xs ${
                            expanded ? "rotate-180" : ""
                          }`}
                        >
                          ▼
                        </span>
                      </div>
                    </div>

                    {/* Dettaglio espanso */}
                    {expanded && (
                      <div className="border-t border-slate-100 px-5 py-4">
                        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">

                          {/* Contatti */}
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Contatti
                            </p>
                            <dl className="space-y-1.5 text-sm">
                              {[
                                { label: "Email booking", value: agency.booking_email },
                                { label: "Email contatto", value: agency.contact_email },
                                { label: "Telefono", value: agency.phone },
                              ].map(({ label, value }) => (
                                <div key={label} className="flex gap-2">
                                  <dt className="w-28 shrink-0 text-slate-400">{label}</dt>
                                  <dd className="break-all text-slate-700">
                                    {value ? (
                                      label === "Telefono" ? (
                                        <a href={`tel:${value}`} className="text-blue-600 hover:underline">
                                          {value}
                                        </a>
                                      ) : (
                                        value
                                      )
                                    ) : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>

                          {/* Fatturazione */}
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Fatturazione
                            </p>
                            <dl className="space-y-1.5 text-sm">
                              {[
                                { label: "P.IVA", value: agency.vat_number },
                                { label: "SDI", value: agency.sdi_code },
                                { label: "PEC", value: agency.pec_email },
                                { label: "Listini", value: String(lists) },
                                { label: "Regole", value: String(agencyRules) },
                              ].map(({ label, value }) => (
                                <div key={label} className="flex gap-2">
                                  <dt className="w-20 shrink-0 text-slate-400">{label}</dt>
                                  <dd className={`text-slate-700 ${["P.IVA", "SDI"].includes(label) ? "font-mono" : ""}`}>
                                    {value || <span className="text-slate-300">—</span>}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>

                          {/* Operativo */}
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Operativo
                            </p>
                            <dl className="space-y-1.5 text-sm">
                              {[
                                { label: "Servizi", value: String(services) },
                                { label: "Pax", value: String(pax) },
                                { label: "Ultimo serv.", value: latestDate ?? "—" },
                                { label: "+48h", value: String(next48h), highlight: next48h > 0 },
                                { label: "Bus dom.", value: String(nextSundayBus) },
                              ].map(({ label, value, highlight }) => (
                                <div key={label} className="flex gap-2">
                                  <dt className="w-24 shrink-0 text-slate-400">{label}</dt>
                                  <dd className={highlight ? "font-semibold text-amber-700" : "text-slate-700"}>
                                    {value}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </div>

                          {/* Estratto conto */}
                          <div>
                            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                              Estratto conto
                            </p>
                            {agency.invoice_enabled ? (
                              <dl className="space-y-1.5 text-sm">
                                <div className="flex gap-2">
                                  <dt className="w-20 shrink-0 text-slate-400">Email</dt>
                                  <dd className="break-all text-slate-700">
                                    {agency.invoice_email ?? <span className="text-slate-300">—</span>}
                                  </dd>
                                </div>
                                <div className="flex gap-2">
                                  <dt className="w-20 shrink-0 text-slate-400">Cadenza</dt>
                                  <dd className="text-slate-700">
                                    {CADENCE_LABELS[agency.invoice_cadence ?? ""] ?? "—"}
                                  </dd>
                                </div>
                                <div className="flex gap-2">
                                  <dt className="w-20 shrink-0 text-slate-400">Giorno</dt>
                                  <dd className="text-slate-700">
                                    {typeof agency.invoice_send_day === "number"
                                      ? DAY_LABELS[agency.invoice_send_day]
                                      : "—"}
                                  </dd>
                                </div>
                              </dl>
                            ) : (
                              <p className="text-sm text-slate-400">Non configurato</p>
                            )}
                          </div>

                          {/* Mix servizi */}
                          {Object.keys(serviceMix).length > 0 && (
                            <div className="sm:col-span-2">
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                Mix servizi
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {Object.entries(serviceMix)
                                  .sort((a, b) => b[1] - a[1])
                                  .slice(0, 6)
                                  .map(([label, count]) => (
                                    <span
                                      key={label}
                                      className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600"
                                    >
                                      {label}: {count}
                                    </span>
                                  ))}
                              </div>
                            </div>
                          )}

                          {/* Ultime prenotazioni */}
                          {recentServices.length > 0 && (
                            <div className="sm:col-span-2 lg:col-span-3">
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                Ultime prenotazioni
                              </p>
                              <div className="overflow-hidden rounded-xl border border-slate-100">
                                <table className="w-full text-xs">
                                  <thead className="bg-slate-50 text-slate-400">
                                    <tr>
                                      <th className="px-3 py-2 text-left font-semibold">Data</th>
                                      <th className="px-3 py-2 text-left font-semibold">Cliente</th>
                                      <th className="px-3 py-2 text-left font-semibold">Tipo</th>
                                      <th className="px-3 py-2 text-right font-semibold">Pax</th>
                                      <th className="px-3 py-2 text-right font-semibold">Stato</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-50">
                                    {recentServices.map((s) => (
                                      <tr key={s.id} className="hover:bg-slate-50/60">
                                        <td className="px-3 py-2 font-mono text-slate-600">{s.date}</td>
                                        <td className="px-3 py-2 text-slate-700 max-w-[160px] truncate">{s.customer_name}</td>
                                        <td className="px-3 py-2 text-slate-500">{s.service_type_code ?? s.booking_service_kind ?? s.service_type}</td>
                                        <td className="px-3 py-2 text-right text-slate-700">{s.pax}</td>
                                        <td className="px-3 py-2 text-right">
                                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                            s.status === "completato" ? "bg-emerald-100 text-emerald-700" :
                                            s.status === "cancelled" ? "bg-rose-100 text-rose-600" :
                                            s.status === "assigned" ? "bg-blue-100 text-blue-700" :
                                            "bg-slate-100 text-slate-500"
                                          }`}>
                                            {s.status}
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}

                          {/* Note */}
                          {(agency.notes || agency.default_pricing_notes) && (
                            <div className="lg:col-span-3 sm:col-span-2">
                              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                                Note
                              </p>
                              {agency.notes && <p className="text-sm text-slate-600">{agency.notes}</p>}
                              {agency.default_pricing_notes && (
                                <p className="mt-1 text-sm text-slate-400">{agency.default_pricing_notes}</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                );
              }
            )}
          </div>
        )}
      </SectionCard>

      {/* Modal crea/modifica */}
      {modalOpen && (
        <AgencyModal
          agency={modalAgency}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            showToast("Agenzia salvata.", true);
            void load();
          }}
          getToken={getToken}
        />
      )}
    </section>
  );
}
