"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

type MembershipRow = {
  user_id: string;
  tenant_id: string;
  role: UserRole;
  full_name: string;
  created_at?: string | null;
};

type UserFormState = {
  full_name: string;
  email: string;
  password: string;
  role: UserRole;
};

const defaultForm: UserFormState = {
  full_name: "",
  email: "",
  password: "",
  role: "operator"
};

const roleDescriptions: Array<{ role: UserRole; label: string; description: string }> = [
  { role: "admin", label: "Admin", description: "Accesso completo, configurazioni, utenti, listini e supervisione operativa." },
  { role: "operator", label: "Operatore", description: "Gestisce servizi, review PDF, inbox, pianificazione e riepiloghi." },
  { role: "driver", label: "Autista", description: "Vede solo i servizi assegnati e la parte mobile operativa." },
  { role: "agency", label: "Agenzia", description: "Inserisce prenotazioni e consulta solo la propria area dedicata." }
];

function formatCreatedAt(value?: string | null) {
  if (!value) return "N/D";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function SettingsUsersPage() {
  const [memberships, setMemberships] = useState<MembershipRow[]>([]);
  const [form, setForm] = useState<UserFormState>(defaultForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState("Caricamento utenti tenant...");

  const sortedMemberships = useMemo(
    () =>
      [...memberships].sort((left, right) => {
        if (left.role !== right.role) return left.role.localeCompare(right.role);
        return left.full_name.localeCompare(right.full_name, "it");
      }),
    [memberships]
  );

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (!hasSupabaseEnv || !supabase) {
        if (!active) return;
        setLoading(false);
        setMessage("Supabase non configurato.");
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (!active) return;
      if (error || !data.session?.access_token) {
        setLoading(false);
        setMessage("Sessione non valida.");
        return;
      }

      const response = await fetch("/api/settings/users", {
        headers: { Authorization: `Bearer ${data.session.access_token}` }
      });

      if (!active) return;
      if (response.status === 403) {
        setLoading(false);
        setMessage("Accesso negato: solo admin.");
        return;
      }
      if (!response.ok) {
        setLoading(false);
        setMessage("Errore caricamento utenti.");
        return;
      }

      const body = (await response.json().catch(() => null)) as { memberships?: MembershipRow[] } | null;
      setMemberships((body?.memberships ?? []) as MembershipRow[]);
      setLoading(false);
      setMessage("Crea nuovi utenti del tenant e assegna il ruolo corretto.");
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasSupabaseEnv || !supabase) return;

    setSaving(true);
    setMessage("Creazione utente in corso...");

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setSaving(false);
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch("/api/settings/users", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(form)
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; user?: MembershipRow & { email?: string } }
      | null;

    if (!response.ok || !body?.user) {
      setSaving(false);
      setMessage(body?.error ?? "Creazione utente fallita.");
      return;
    }

    const createdUser = body.user;

    setMemberships((prev) => [
      ...prev,
      {
        user_id: createdUser.user_id,
        tenant_id: createdUser.tenant_id,
        role: createdUser.role,
        full_name: createdUser.full_name,
        created_at: new Date().toISOString()
      }
    ]);
    setForm(defaultForm);
    setSaving(false);
    setMessage(`Utente creato: ${createdUser.full_name} (${createdUser.role}).`);
  };

  const updateMembership = async (membership: MembershipRow, nextRole: UserRole) => {
    if (!hasSupabaseEnv || !supabase || updatingUserId) return;
    setUpdatingUserId(membership.user_id);
    setMessage(`Aggiornamento ruolo di ${membership.full_name}...`);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setUpdatingUserId(null);
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch("/api/settings/users", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        user_id: membership.user_id,
        full_name: membership.full_name,
        role: nextRole
      })
    });

    const body = (await response.json().catch(() => null)) as { error?: string; user?: MembershipRow } | null;
    if (!response.ok || !body?.user) {
      setUpdatingUserId(null);
      setMessage(body?.error ?? "Aggiornamento ruolo fallito.");
      return;
    }

    const updatedUser = body.user;

    setMemberships((prev) => prev.map((item) => (item.user_id === membership.user_id ? { ...item, role: updatedUser.role } : item)));
    setUpdatingUserId(null);
    setMessage(`Ruolo aggiornato: ${membership.full_name} -> ${updatedUser.role}.`);
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Impostazioni utenti (Admin)</h1>
        <p className="text-sm text-muted">{message}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <article className="card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Nuovo utente</h2>
            <p className="text-sm text-muted">Crea accessi interni o agenzia senza passare dall&apos;onboarding tecnico.</p>
          </div>

          <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2">
            <label className="grid gap-1 md:col-span-2">
              <span className="text-sm font-medium text-text">Nome completo</span>
              <input
                value={form.full_name}
                onChange={(event) => setForm((prev) => ({ ...prev, full_name: event.target.value }))}
                className="input-saas"
                placeholder="Mario Rossi"
                required
              />
            </label>

            <label className="grid gap-1">
              <span className="text-sm font-medium text-text">Email</span>
              <input
                type="email"
                value={form.email}
                onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
                className="input-saas"
                placeholder="utente@dominio.it"
                required
              />
            </label>

            <label className="grid gap-1">
              <span className="text-sm font-medium text-text">Password iniziale</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                className="input-saas"
                placeholder="Minimo 8 caratteri"
                required
              />
            </label>

            <label className="grid gap-1 md:col-span-2">
              <span className="text-sm font-medium text-text">Ruolo</span>
              <select
                value={form.role}
                onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as UserRole }))}
                className="input-saas"
              >
                {roleDescriptions.map((item) => (
                  <option key={item.role} value={item.role}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>

            <div className="md:col-span-2">
              <button type="submit" className="btn-primary" disabled={saving || loading}>
                {saving ? "Creazione..." : "Crea utente"}
              </button>
            </div>
          </form>
        </article>

        <article className="card p-4">
          <div className="mb-4">
            <h2 className="text-lg font-semibold">Permessi per ruolo</h2>
            <p className="text-sm text-muted">Gradi permesso semplici e leggibili, coerenti con le funzioni del gestionale.</p>
          </div>

          <div className="space-y-3">
            {roleDescriptions.map((item) => (
              <article key={item.role} className="rounded-2xl border border-border bg-surface/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-text">{item.label}</h3>
                  <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-muted">{item.role}</span>
                </div>
                <p className="mt-2 text-sm text-muted">{item.description}</p>
              </article>
            ))}
          </div>
        </article>
      </div>

      <article className="card p-4">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Utenti del tenant</h2>
          <p className="text-sm text-muted">Elenco attuale degli utenti che lavorano nel tenant attivo.</p>
        </div>

        {loading ? (
          <div className="text-sm text-muted">Caricamento utenti...</div>
        ) : sortedMemberships.length === 0 ? (
          <div className="text-sm text-muted">Nessun utente presente nel tenant.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="px-3 py-2 font-medium">Nome</th>
                  <th className="px-3 py-2 font-medium">Ruolo</th>
                  <th className="px-3 py-2 font-medium">Creato il</th>
                  <th className="px-3 py-2 font-medium">User ID</th>
                </tr>
              </thead>
              <tbody>
                {sortedMemberships.map((membership) => (
                  <tr key={membership.user_id} className="border-b border-border/70">
                    <td className="px-3 py-2 font-medium text-text">{membership.full_name}</td>
                    <td className="px-3 py-2">
                      <select
                        value={membership.role}
                        onChange={(event) => void updateMembership(membership, event.target.value as UserRole)}
                        className="input-saas min-w-36"
                        disabled={updatingUserId === membership.user_id}
                      >
                        {roleDescriptions.map((item) => (
                          <option key={`${membership.user_id}-${item.role}`} value={item.role}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-muted">{formatCreatedAt(membership.created_at)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted">{membership.user_id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
    </section>
  );
}
