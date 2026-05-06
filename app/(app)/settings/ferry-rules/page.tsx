"use client";

import { useCallback, useEffect, useState } from "react";
import { SidePanel } from "@/components/ui/side-panel";
import { getClientSessionContext } from "@/lib/supabase/client-session";
import type { FerryPickupRule } from "@/lib/ferry-pickup-rules";

// ─── Costanti ─────────────────────────────────────────────────────────────────

const COMPANIES = ["medmar", "caremar", "snav", "alilauro"];

const COMPANY_LABEL: Record<string, string> = {
  medmar: "MEDMAR",
  caremar: "CAREMAR",
  snav: "SNAV",
  alilauro: "ALILAURO",
};

const PORTS = [
  { value: "ischia_porto", label: "Ischia Porto" },
  { value: "casamicciola", label: "Casamicciola" },
];

const DAYS_LABEL = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

type Section = {
  transport_type: "train" | "flight";
  boat_type: "traghetto" | "aliscafo";
  label: string;
};

const ALESTE_SECTIONS: Section[] = [
  { transport_type: "flight", boat_type: "traghetto", label: "Volo" },
  { transport_type: "train",  boat_type: "traghetto", label: "Treno" },
];

const SOSANDRA_SECTIONS: Section[] = [
  { transport_type: "flight", boat_type: "aliscafo",  label: "Volo (aliscafo)" },
  { transport_type: "train",  boat_type: "traghetto", label: "Treno (traghetto)" },
  { transport_type: "train",  boat_type: "aliscafo",  label: "Treno (aliscafo)" },
];

// ─── Tipi form ────────────────────────────────────────────────────────────────

type RuleFormData = {
  agency_logic: "aleste" | "sosandra";
  transport_type: "train" | "flight";
  boat_type: "traghetto" | "aliscafo";
  transport_from: string;
  transport_to: string;
  company: string;
  departure_time: string;
  arrival_port: string;
  arrival_time: string;
  valid_from: string;
  valid_to: string;
  days_of_week: number[];
  season_notes: string;
};

const emptyForm = (
  agency_logic: "aleste" | "sosandra",
  transport_type: "train" | "flight",
  boat_type: "traghetto" | "aliscafo"
): RuleFormData => ({
  agency_logic,
  transport_type,
  boat_type,
  transport_from: "",
  transport_to: "",
  company: "medmar",
  departure_time: "",
  arrival_port: "ischia_porto",
  arrival_time: "",
  valid_from: "",
  valid_to: "",
  days_of_week: [],
  season_notes: "",
});

// ─── Componente ────────────────────────────────────────────────────────────────

export default function FerryRulesPage() {
  const [rules, setRules] = useState<FerryPickupRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"aleste" | "sosandra">("aleste");
  const [token, setToken] = useState<string | null>(null);

  // Panel state
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<FerryPickupRule | null>(null);
  const [form, setForm] = useState<RuleFormData>(emptyForm("aleste", "flight", "traghetto"));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────────

  const fetchRules = useCallback(async (accessToken: string) => {
    const res = await fetch("/api/ferry-pickup-rules", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error("Errore nel caricamento regole.");
    const body = await res.json() as { rules: FerryPickupRule[] };
    setRules(body.rules);
  }, []);

  useEffect(() => {
    const load = async () => {
      const session = await getClientSessionContext();
      if (!session.accessToken) { setError("Login richiesto."); setLoading(false); return; }
      setToken(session.accessToken);
      try {
        await fetchRules(session.accessToken);
      } catch (e) {
        setError((e as Error).message);
      }
      setLoading(false);
    };
    void load();
  }, [fetchRules]);

  // ─── Panel ──────────────────────────────────────────────────────────────────

  function openAdd(section: Section, logic: "aleste" | "sosandra") {
    setEditingRule(null);
    setForm(emptyForm(logic, section.transport_type, section.boat_type));
    setSaveError(null);
    setPanelOpen(true);
  }

  function openEdit(rule: FerryPickupRule) {
    setEditingRule(rule);
    setForm({
      agency_logic: rule.agency_logic,
      transport_type: rule.transport_type,
      boat_type: rule.boat_type,
      transport_from: rule.transport_from.slice(0, 5),
      transport_to: rule.transport_to.slice(0, 5),
      company: rule.company,
      departure_time: rule.departure_time.slice(0, 5),
      arrival_port: rule.arrival_port,
      arrival_time: rule.arrival_time?.slice(0, 5) ?? "",
      valid_from: rule.valid_from ?? "",
      valid_to: rule.valid_to ?? "",
      days_of_week: rule.days_of_week ?? [],
      season_notes: rule.season_notes ?? "",
    });
    setSaveError(null);
    setPanelOpen(true);
  }

  async function handleSave() {
    if (!token) return;
    setSaving(true);
    setSaveError(null);

    const payload = {
      agency_logic: form.agency_logic,
      transport_type: form.transport_type,
      boat_type: form.boat_type,
      transport_from: form.transport_from,
      transport_to: form.transport_to,
      company: form.company,
      arrival_port: form.arrival_port,
      arrival_time: form.arrival_time || null,
      valid_from: form.valid_from || null,
      valid_to: form.valid_to || null,
      days_of_week: form.days_of_week.length > 0 ? form.days_of_week : null,
      season_notes: form.season_notes || null,
      ...(editingRule ? {} : { departure_time: form.departure_time }),
    };

    const url = editingRule
      ? `/api/ferry-pickup-rules/${editingRule.id}`
      : "/api/ferry-pickup-rules";
    const method = editingRule ? "PATCH" : "POST";

    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { error?: string };

    if (!res.ok) {
      setSaveError(body.error ?? "Errore nel salvataggio.");
      setSaving(false);
      return;
    }

    await fetchRules(token);
    setPanelOpen(false);
    setSaving(false);
  }

  async function handleDelete(id: string) {
    if (!token) return;
    if (!confirm("Eliminare questa regola?")) return;
    const res = await fetch(`/api/ferry-pickup-rules/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) setRules((prev) => prev.filter((r) => r.id !== id));
  }

  function toggleDay(d: number) {
    setForm((f) => ({
      ...f,
      days_of_week: f.days_of_week.includes(d)
        ? f.days_of_week.filter((x) => x !== d)
        : [...f.days_of_week, d].sort(),
    }));
  }

  // ─── Render helpers ─────────────────────────────────────────────────────────

  function rulesFor(logic: "aleste" | "sosandra", tt: "train" | "flight", bt: "traghetto" | "aliscafo") {
    return rules
      .filter((r) => r.agency_logic === logic && r.transport_type === tt && r.boat_type === bt)
      .sort((a, b) => a.transport_from.localeCompare(b.transport_from));
  }

  function formatSeasonBadge(rule: FerryPickupRule) {
    const parts: string[] = [];
    if (rule.valid_from || rule.valid_to) {
      const from = rule.valid_from ? rule.valid_from.slice(5).replace("-", "/") : "";
      const to   = rule.valid_to   ? rule.valid_to.slice(5).replace("-", "/")   : "";
      parts.push(`${from}→${to}`);
    }
    if (rule.days_of_week?.length) {
      parts.push(rule.days_of_week.map((d) => DAYS_LABEL[d]).join("+"));
    }
    return parts.join(" ");
  }

  // ─── UI ─────────────────────────────────────────────────────────────────────

  if (loading) return <p className="text-sm text-slate-500 p-6">Caricamento...</p>;
  if (error)   return <p className="text-sm text-rose-600 p-6">{error}</p>;

  const sections = activeTab === "aleste" ? ALESTE_SECTIONS : SOSANDRA_SECTIONS;

  return (
    <>
      <section className="space-y-6 max-w-5xl">
        <div>
          <h1 className="text-2xl font-semibold">Abbinamento corse nave</h1>
          <p className="text-sm text-slate-500 mt-1">
            Tabella orari per abbinare automaticamente l&apos;arrivo di treni/voli alla corsa nave giusta.
            L&apos;orario partenza nave è fisso (non modificabile).
          </p>
        </div>

        {/* Tab Aleste / Sosandra */}
        <div className="flex gap-1 border-b border-border">
          {(["aleste", "sosandra"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium capitalize rounded-t-lg transition-colors ${
                activeTab === tab
                  ? "bg-surface border border-b-surface border-border text-slate-900 -mb-px"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {tab === "aleste" ? "Tutte le agenzie (Aleste)" : "Sosandra"}
            </button>
          ))}
        </div>

        {sections.map((section) => {
          const sectionRules = rulesFor(activeTab, section.transport_type, section.boat_type);
          return (
            <div key={`${section.transport_type}-${section.boat_type}`} className="card p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-slate-800">{section.label}</h2>
                <button
                  type="button"
                  className="btn-primary px-3 py-1.5 text-sm"
                  onClick={() => openAdd(section, activeTab)}
                >
                  + Aggiungi
                </button>
              </div>

              {sectionRules.length === 0 ? (
                <p className="text-sm text-slate-400 italic">Nessuna regola configurata.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-slate-400 border-b border-slate-100">
                        <th className="pb-2 pr-3">Arrivo mezzo</th>
                        <th className="pb-2 pr-3">Compagnia</th>
                        <th className="pb-2 pr-3">Partenza nave</th>
                        <th className="pb-2 pr-3">Porto</th>
                        <th className="pb-2 pr-3">Sbarco</th>
                        <th className="pb-2 pr-3">Validità</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {sectionRules.map((rule) => (
                        <tr key={rule.id} className="hover:bg-slate-50/60">
                          <td className="py-2 pr-3 font-mono text-slate-700">
                            {rule.transport_from.slice(0, 5)}–{rule.transport_to.slice(0, 5)}
                          </td>
                          <td className="py-2 pr-3 font-semibold text-slate-800 uppercase">
                            {COMPANY_LABEL[rule.company] ?? rule.company}
                          </td>
                          <td className="py-2 pr-3 font-mono text-slate-500">
                            {rule.departure_time.slice(0, 5)}
                          </td>
                          <td className="py-2 pr-3 text-slate-600">
                            {rule.arrival_port === "ischia_porto" ? "Ischia Porto" : "Casamicciola"}
                          </td>
                          <td className="py-2 pr-3 font-mono text-slate-500">
                            {rule.arrival_time?.slice(0, 5) ?? "—"}
                          </td>
                          <td className="py-2 pr-3 text-[11px] text-slate-400">
                            {formatSeasonBadge(rule) || "tutto l'anno"}
                          </td>
                          <td className="py-2 text-right whitespace-nowrap">
                            <button
                              type="button"
                              className="text-xs text-blue-600 hover:underline mr-3"
                              onClick={() => openEdit(rule)}
                            >
                              Modifica
                            </button>
                            <button
                              type="button"
                              className="text-xs text-rose-600 hover:underline"
                              onClick={() => handleDelete(rule.id)}
                            >
                              Elimina
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* Side panel add/edit */}
      <SidePanel
        open={panelOpen}
        title={editingRule ? "Modifica regola" : "Nuova regola"}
        subtitle={
          editingRule
            ? `${editingRule.transport_from.slice(0, 5)}–${editingRule.transport_to.slice(0, 5)} → ${COMPANY_LABEL[editingRule.company] ?? editingRule.company} ${editingRule.departure_time.slice(0, 5)}`
            : undefined
        }
        onClose={() => setPanelOpen(false)}
        widthClassName="max-w-lg"
      >
        <div className="space-y-5">
          {/* Finestra orario mezzo */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Orario arrivo {form.transport_type === "train" ? "treno" : "volo"}
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Da</span>
                <input
                  type="time"
                  value={form.transport_from}
                  onChange={(e) => setForm((f) => ({ ...f, transport_from: e.target.value }))}
                  className="input w-full"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">A</span>
                <input
                  type="time"
                  value={form.transport_to}
                  onChange={(e) => setForm((f) => ({ ...f, transport_to: e.target.value }))}
                  className="input w-full"
                />
              </label>
            </div>
          </fieldset>

          {/* Compagnia + orario barca */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Corsa nave
            </legend>
            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Compagnia</span>
              <select
                value={form.company}
                onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
                className="input w-full"
              >
                {COMPANIES.map((c) => (
                  <option key={c} value={c}>{COMPANY_LABEL[c] ?? c}</option>
                ))}
              </select>
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-slate-500">
                Orario partenza nave
                {editingRule && <span className="ml-1 text-amber-600 font-medium">(non modificabile)</span>}
              </span>
              {editingRule ? (
                <div className="input w-full bg-slate-50 text-slate-400 font-mono cursor-not-allowed select-none">
                  {form.departure_time}
                </div>
              ) : (
                <input
                  type="time"
                  value={form.departure_time}
                  onChange={(e) => setForm((f) => ({ ...f, departure_time: e.target.value }))}
                  className="input w-full font-mono"
                />
              )}
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Porto arrivo</span>
                <select
                  value={form.arrival_port}
                  onChange={(e) => setForm((f) => ({ ...f, arrival_port: e.target.value }))}
                  className="input w-full"
                >
                  {PORTS.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Orario sbarco</span>
                <input
                  type="time"
                  value={form.arrival_time}
                  onChange={(e) => setForm((f) => ({ ...f, arrival_time: e.target.value }))}
                  className="input w-full font-mono"
                />
              </label>
            </div>
          </fieldset>

          {/* Validità stagionale */}
          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Validità stagionale (opzionale)
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Dal</span>
                <input
                  type="date"
                  value={form.valid_from}
                  onChange={(e) => setForm((f) => ({ ...f, valid_from: e.target.value }))}
                  className="input w-full"
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-500">Al</span>
                <input
                  type="date"
                  value={form.valid_to}
                  onChange={(e) => setForm((f) => ({ ...f, valid_to: e.target.value }))}
                  className="input w-full"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs text-slate-500">Giorni della settimana (vuoto = tutti)</span>
              <div className="flex gap-1.5 flex-wrap">
                {DAYS_LABEL.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => toggleDay(i)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium border transition-colors ${
                      form.days_of_week.includes(i)
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-slate-500">Note stagione</span>
              <input
                type="text"
                value={form.season_notes}
                placeholder="es. estate, inverno, ven+dom mag"
                onChange={(e) => setForm((f) => ({ ...f, season_notes: e.target.value }))}
                className="input w-full"
              />
            </label>
          </fieldset>

          {saveError && (
            <p className="rounded-lg bg-rose-50 border border-rose-200 px-3 py-2 text-sm text-rose-700">
              {saveError}
            </p>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="btn-primary flex-1 py-2"
            >
              {saving ? "Salvataggio..." : editingRule ? "Salva modifiche" : "Aggiungi regola"}
            </button>
            <button
              type="button"
              onClick={() => setPanelOpen(false)}
              className="btn-secondary px-4 py-2"
            >
              Annulla
            </button>
          </div>
        </div>
      </SidePanel>
    </>
  );
}
