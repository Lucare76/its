"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { capabilityRoleMap, type AppCapability } from "@/lib/rbac";
import { hasSupabaseEnv, supabase } from "@/lib/supabase/client";
import type { UserRole } from "@/lib/types";

type MembershipRow = {
  user_id: string;
  tenant_id: string;
  role: UserRole;
  full_name: string;
  created_at?: string | null;
  suspended?: boolean;
};

type RoleCapabilityOverrideRow = {
  role: UserRole;
  capability: AppCapability;
  enabled: boolean;
};

type UserFormState = {
  full_name: string;
  email: string;
  password: string;
  role: UserRole;
};

type PendingAccessRequestRow = {
  id: string;
  tenant_id: string | null;
  user_id: string;
  email: string;
  full_name: string;
  agency_name?: string | null;
  requested_role?: UserRole | null;
  status: "pending" | "approved" | "rejected";
  created_at?: string | null;
  review_notes?: string | null;
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
  { role: "agency", label: "Agenzia", description: "Accede solo a Prenotazioni agenzia e alla propria area dedicata. Nessun accesso ai moduli interni." }
];

const capabilityLabels = [
  { capability: "dashboard:view", label: "Cruscotto" },
  { capability: "arrivals:view", label: "Arrivi" },
  { capability: "departures:view", label: "Partenze" },
  { capability: "notifications:view", label: "Notifiche" },
  { capability: "services:view", label: "Vista servizi" },
  { capability: "services:create", label: "Nuovo servizio" },
  { capability: "planning:manage", label: "Pianificazione" },
  { capability: "crm_agencies:view", label: "CRM agenzie" },
  { capability: "dispatch:manage", label: "Dispatch interno" },
  { capability: "ops_summary:view", label: "Riepiloghi operativi" },
  { capability: "report_center:view", label: "Centro report" },
  { capability: "scheduler:view", label: "Scheduler" },
  { capability: "service_workflow:view", label: "Workflow servizi" },
  { capability: "excel_workspace:view", label: "Excel workspace" },
  { capability: "excel_import:view", label: "Import Excel" },
  { capability: "ops_rules:view", label: "Regole operative" },
  { capability: "audit:view", label: "Audit" },
  { capability: "pricing:view", label: "Tariffe e margini" },
  { capability: "pricing:manage", label: "Gestione listini" },
  { capability: "users:manage", label: "Utenti" },
  { capability: "agency_bookings:self", label: "Prenotazioni agenzia" },
  { capability: "driver:self", label: "Area autista" }
] as const;

function formatCreatedAt(value?: string | null) {
  if (!value) return "N/D";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const formatter = new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  return formatter.format(parsed);
}

function roleSwitchLabel(role: UserRole) {
  if (role === "admin") return "Admin";
  if (role === "operator") return "Operatore";
  if (role === "driver") return "Autista";
  return "Agenzia";
}

function isAgencyLockedCapability(role: UserRole, capability: AppCapability) {
  return role === "agency" && capability !== "agency_bookings:self";
}

function roleBadgeTone(role: UserRole) {
  if (role === "admin") return "bg-slate-100 text-slate-700";
  if (role === "operator") return "bg-sky-100 text-sky-700";
  if (role === "driver") return "bg-emerald-100 text-emerald-700";
  return "bg-amber-100 text-amber-800";
}

export default function SettingsUsersPage() {
  const [memberships, setMemberships] = useState<MembershipRow[]>([]);
  const [roleCapabilityOverrides, setRoleCapabilityOverrides] = useState<RoleCapabilityOverrideRow[]>([]);
  const [pendingAccessRequests, setPendingAccessRequests] = useState<PendingAccessRequestRow[]>([]);
  const [permissionsExpanded, setPermissionsExpanded] = useState(false);
  const [form, setForm] = useState<UserFormState>(defaultForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingUserId, setUpdatingUserId] = useState<string | null>(null);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [sendingResetUserId, setSendingResetUserId] = useState<string | null>(null);
  const [updatingCapabilityKey, setUpdatingCapabilityKey] = useState<string | null>(null);
  const [reviewingRequestId, setReviewingRequestId] = useState<string | null>(null);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [requestRoleDrafts, setRequestRoleDrafts] = useState<Record<string, UserRole>>({});
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

      const body = (await response.json().catch(() => null)) as
        | { memberships?: MembershipRow[]; role_capability_overrides?: RoleCapabilityOverrideRow[]; pending_access_requests?: PendingAccessRequestRow[] }
        | null;
      setMemberships((body?.memberships ?? []) as MembershipRow[]);
      setRoleCapabilityOverrides((body?.role_capability_overrides ?? []) as RoleCapabilityOverrideRow[]);
      setPendingAccessRequests((body?.pending_access_requests ?? []) as PendingAccessRequestRow[]);
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

  const updateMembership = async (membership: MembershipRow, nextRole: UserRole, nextPassword?: string, nextSuspended?: boolean) => {
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
        role: nextRole,
        password: nextPassword?.trim() ? nextPassword.trim() : undefined,
        suspended: nextSuspended ?? membership.suspended ?? false
      })
    });

    const body = (await response.json().catch(() => null)) as { error?: string; user?: MembershipRow } | null;
    if (!response.ok || !body?.user) {
      setUpdatingUserId(null);
      setMessage(body?.error ?? "Aggiornamento ruolo fallito.");
      return;
    }

    const updatedUser = body.user;

    setMemberships((prev) =>
      prev.map((item) =>
        item.user_id === membership.user_id
          ? { ...item, role: updatedUser.role, suspended: updatedUser.suspended ?? nextSuspended ?? item.suspended ?? false }
          : item
      )
    );
    setPasswordDrafts((prev) => ({ ...prev, [membership.user_id]: "" }));
    setUpdatingUserId(null);
    setMessage(
      nextPassword?.trim()
        ? `Utente aggiornato: ${membership.full_name} (${updatedUser.role}) con nuova password.`
        : nextSuspended !== undefined && nextSuspended !== (membership.suspended ?? false)
          ? `${membership.full_name} ${nextSuspended ? "sospeso" : "riattivato"}.`
          : `Ruolo aggiornato: ${membership.full_name} -> ${updatedUser.role}.`
    );
  };

  const getEffectiveCapability = (role: UserRole, capability: AppCapability) => {
    if (role === "agency") {
      return capability === "agency_bookings:self";
    }
    const override = roleCapabilityOverrides.find((item) => item.role === role && item.capability === capability);
    if (override) return override.enabled;
    return capabilityRoleMap[capability].includes(role);
  };

  const updateRoleCapability = async (role: UserRole, capability: AppCapability, enabled: boolean) => {
    if (!hasSupabaseEnv || !supabase || updatingCapabilityKey) return;
    if (isAgencyLockedCapability(role, capability)) {
      setMessage("Il ruolo agenzia puo usare solo Prenotazioni agenzia. Gli altri moduli restano bloccati.");
      return;
    }

    const requestKey = `${role}:${capability}`;
    setUpdatingCapabilityKey(requestKey);
    setMessage(`Aggiornamento permesso ${capability} per ${role}...`);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setUpdatingCapabilityKey(null);
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
        role,
        capability,
        enabled
      })
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; override?: RoleCapabilityOverrideRow }
      | null;

    if (!response.ok || !body?.override) {
      setUpdatingCapabilityKey(null);
      setMessage(body?.error ?? "Aggiornamento permesso fallito.");
      return;
    }

    const override = body.override;
    setRoleCapabilityOverrides((prev) => {
      const next = prev.filter((item) => !(item.role === role && item.capability === capability));
      next.push(override);
      return next;
    });
    setUpdatingCapabilityKey(null);
    setMessage(`Permesso aggiornato: ${roleDescriptions.find((item) => item.role === role)?.label ?? role} -> ${capabilityLabels.find((item) => item.capability === capability)?.label ?? capability}.`);
  };

  const deleteMembership = async (membership: MembershipRow) => {
    if (!hasSupabaseEnv || !supabase || deletingUserId || updatingUserId) return;

    const confirmed = window.confirm(`Vuoi eliminare definitivamente l'utente ${membership.full_name}?`);
    if (!confirmed) return;

    setDeletingUserId(membership.user_id);
    setMessage(`Eliminazione di ${membership.full_name} in corso...`);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setDeletingUserId(null);
      setMessage("Sessione non valida.");
      return;
    }

    const response = await fetch(`/api/settings/users?user_id=${encodeURIComponent(membership.user_id)}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    const body = (await response.json().catch(() => null)) as { error?: string; deleted_user_id?: string } | null;
    if (!response.ok || !body?.deleted_user_id) {
      setDeletingUserId(null);
      setMessage(body?.error ?? "Eliminazione utente fallita.");
      return;
    }

    setMemberships((prev) => prev.filter((item) => item.user_id !== membership.user_id));
    setPasswordDrafts((prev) => {
      const next = { ...prev };
      delete next[membership.user_id];
      return next;
    });
    setDeletingUserId(null);
    setMessage(`Utente eliminato: ${membership.full_name}.`);
  };

  const sendResetPasswordEmail = async (membership: MembershipRow) => {
    if (!hasSupabaseEnv || !supabase || sendingResetUserId || updatingUserId) return;

    setSendingResetUserId(membership.user_id);
    setMessage(`Invio email reset password a ${membership.full_name}...`);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setSendingResetUserId(null);
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
        action: "send_reset_password_email",
        user_id: membership.user_id
      })
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; reset_email?: { email?: string; status?: string } }
      | null;

    if (!response.ok || !body?.reset_email) {
      setSendingResetUserId(null);
      setMessage(body?.error ?? "Invio email reset fallito.");
      return;
    }

    setSendingResetUserId(null);
    setMessage(`Email reset inviata a ${body.reset_email.email ?? membership.full_name}.`);
  };

  const reviewAccessRequest = async (request: PendingAccessRequestRow, action: "approve" | "reject") => {
    if (!hasSupabaseEnv || !supabase || reviewingRequestId) return;

    setReviewingRequestId(request.id);
    setMessage(`${action === "approve" ? "Approvazione" : "Rifiuto"} richiesta di ${request.full_name}...`);

    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setReviewingRequestId(null);
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
        request_id: request.id,
        action,
        role: action === "approve" ? requestRoleDrafts[request.id] ?? request.requested_role ?? "operator" : undefined
      })
    });

    const body = (await response.json().catch(() => null)) as
      | { error?: string; approved_request?: { user_id: string; tenant_id: string; full_name: string; role: UserRole } }
      | null;

    if (!response.ok) {
      setReviewingRequestId(null);
      setMessage(body?.error ?? "Revisione richiesta fallita.");
      return;
    }

    setPendingAccessRequests((prev) => prev.filter((item) => item.id !== request.id));

    const approvedRequest = body?.approved_request;
    if (approvedRequest) {
      setMemberships((prev) => [
        ...prev,
        {
          user_id: approvedRequest.user_id,
          tenant_id: approvedRequest.tenant_id,
          role: approvedRequest.role,
          full_name: approvedRequest.full_name,
          created_at: new Date().toISOString(),
          suspended: false
        }
      ]);
      setMessage(`Richiesta approvata: ${approvedRequest.full_name} ora entra come ${approvedRequest.role}.`);
    } else {
      setMessage(`Richiesta rifiutata: ${request.full_name}.`);
    }

    setReviewingRequestId(null);
  };

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Impostazioni utenti (Admin)</h1>
        <p className="text-sm text-muted">{message}</p>
      </div>

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1.08fr)_minmax(440px,0.92fr)]">
        <article className="card p-4 sm:p-5">
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
              <button type="submit" className="btn-primary w-full sm:w-auto" disabled={saving || loading}>
                {saving ? "Creazione..." : "Crea utente"}
              </button>
            </div>
          </form>
        </article>

        <article className="card p-4 sm:p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Permessi per ruolo</h2>
              <p className="text-sm text-muted">Gradi permesso semplici e leggibili, coerenti con le funzioni del gestionale.</p>
            </div>
            <button
              type="button"
              className="btn-secondary w-full text-sm sm:w-auto"
              onClick={() => setPermissionsExpanded((prev) => !prev)}
              aria-expanded={permissionsExpanded}
            >
              {permissionsExpanded ? "Riduci" : "Espandi"}
            </button>
          </div>

          <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50/90 px-4 py-3 text-sm text-amber-900">
            <span className="font-semibold">Ruolo Agenzia:</span> accesso limitato a <span className="font-semibold">Prenotazioni agenzia</span> e alla sola area dedicata. Non puo entrare nei moduli interni.
          </div>

          {permissionsExpanded ? (
            <>
              <div className="space-y-3">
                {roleDescriptions.map((item) => (
                  <article key={item.role} className="rounded-2xl border border-border bg-surface/80 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold text-text">{item.label}</h3>
                      <span className={`rounded-full px-2 py-1 text-[11px] uppercase tracking-[0.12em] ${roleBadgeTone(item.role)}`}>{item.role}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted">{item.description}</p>
                  </article>
                ))}
              </div>
              <div className="mt-4 hidden overflow-x-auto rounded-2xl border border-border xl:block">
                <table className="min-w-[860px] text-sm">
                  <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Modulo</th>
                      {roleDescriptions.map((item) => (
                        <th key={item.role} className="px-4 py-3 whitespace-nowrap">
                          {item.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {capabilityLabels.map((row) => (
                      <tr key={row.capability} className="border-t border-slate-100">
                        <td className="px-4 py-3 font-medium text-text">{row.label}</td>
                        {roleDescriptions.map((item) => {
                          return (
                            <td key={`${row.capability}-${item.role}`} className="px-4 py-3">
                              {(() => {
                                const enabled = getEffectiveCapability(item.role, row.capability);
                                const agencyLocked = isAgencyLockedCapability(item.role, row.capability);
                                const isUpdating = updatingCapabilityKey === `${item.role}:${row.capability}`;
                                return (
                                  <button
                                    type="button"
                                    role="switch"
                                    aria-checked={enabled}
                                    aria-label={`${row.label} per ${roleSwitchLabel(item.role)}`}
                                    disabled={isUpdating || agencyLocked}
                                    onClick={() => void updateRoleCapability(item.role, row.capability, !enabled)}
                                    className={`inline-flex w-[86px] items-center rounded-full p-1 transition ${
                                      enabled ? "bg-emerald-100 hover:bg-emerald-200" : "bg-slate-200 hover:bg-slate-300"
                                    } ${isUpdating || agencyLocked ? "cursor-not-allowed opacity-60" : ""}`}
                                    title={
                                      agencyLocked
                                        ? "Bloccato: il ruolo agenzia puo usare solo Prenotazioni agenzia"
                                        : enabled
                                          ? "Click per impostare NO"
                                          : "Click per impostare SI"
                                    }
                                  >
                                    <span
                                      className={`inline-flex h-7 min-w-[40px] items-center justify-center rounded-full text-[11px] font-semibold uppercase transition ${
                                        enabled
                                          ? "translate-x-[38px] bg-emerald-600 text-white shadow-sm"
                                          : "translate-x-0 bg-white text-slate-500 shadow-sm"
                                      }`}
                                    >
                                      {isUpdating ? "..." : enabled ? "si" : "no"}
                                    </span>
                                  </button>
                                );
                              })()}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 space-y-3 xl:hidden">
                {capabilityLabels.map((row) => (
                  <article key={`mobile-${row.capability}`} className="rounded-2xl border border-border bg-white p-3">
                    <p className="text-sm font-semibold text-text">{row.label}</p>
                    <div className="mt-3 grid gap-2">
                      {roleDescriptions.map((item) => {
                        const enabled = getEffectiveCapability(item.role, row.capability);
                        const agencyLocked = isAgencyLockedCapability(item.role, row.capability);
                        const isUpdating = updatingCapabilityKey === `${item.role}:${row.capability}`;
                        return (
                          <div key={`mobile-${row.capability}-${item.role}`} className="flex items-center justify-between gap-3 rounded-xl bg-surface/70 px-3 py-2">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-text">{item.label}</p>
                              {agencyLocked ? <p className="text-xs text-muted">Bloccato per questo ruolo</p> : null}
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={enabled}
                              aria-label={`${row.label} per ${roleSwitchLabel(item.role)}`}
                              disabled={isUpdating || agencyLocked}
                              onClick={() => void updateRoleCapability(item.role, row.capability, !enabled)}
                              className={`inline-flex w-[86px] shrink-0 items-center rounded-full p-1 transition ${
                                enabled ? "bg-emerald-100 hover:bg-emerald-200" : "bg-slate-200 hover:bg-slate-300"
                              } ${isUpdating || agencyLocked ? "cursor-not-allowed opacity-60" : ""}`}
                            >
                              <span
                                className={`inline-flex h-7 min-w-[40px] items-center justify-center rounded-full text-[11px] font-semibold uppercase transition ${
                                  enabled
                                    ? "translate-x-[38px] bg-emerald-600 text-white shadow-sm"
                                    : "translate-x-0 bg-white text-slate-500 shadow-sm"
                                }`}
                              >
                                {isUpdating ? "..." : enabled ? "si" : "no"}
                              </span>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                ))}
              </div>
            </>
          ) : (
            <div className="rounded-2xl border border-border bg-surface/70 px-4 py-3 text-sm text-muted">
              La matrice completa dei permessi e nascosta. Usa <span className="font-semibold text-text">Espandi</span> per consultare o modificare i moduli per ruolo.
            </div>
          )}
        </article>
      </div>

      <article className="card p-4 sm:p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Richieste accesso pending</h2>
          <p className="text-sm text-muted">Chi si registra resta fuori dal tenant finche un admin non approva il ruolo.</p>
        </div>

        {loading ? (
          <div className="text-sm text-muted">Caricamento richieste...</div>
        ) : pendingAccessRequests.length === 0 ? (
          <div className="text-sm text-muted">Nessuna richiesta pending.</div>
        ) : (
          <div className="grid gap-3 2xl:grid-cols-2">
            {pendingAccessRequests.map((request) => (
              <article key={`pending-${request.id}`} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-text">{request.full_name}</p>
                    <p className="mt-1 break-all text-sm text-muted">{request.email}</p>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] ${roleBadgeTone(request.requested_role ?? "agency")}`}>
                    {request.requested_role ?? "non indicato"}
                  </span>
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px] xl:items-start">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Email</p>
                      <p className="mt-1 break-all text-sm text-text">{request.email}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Agenzia</p>
                      <p className="mt-1 text-sm text-text">{request.agency_name?.trim() || "Da completare al primo accesso"}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Origine</p>
                      <p className="mt-1 text-sm text-text">{request.tenant_id ? "Tenant corrente" : "Area riservata sito"}</p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Ruolo da assegnare</p>
                      <select
                        value={request.requested_role === "agency" ? "agency" : requestRoleDrafts[request.id] ?? request.requested_role ?? "operator"}
                        onChange={(event) => setRequestRoleDrafts((prev) => ({ ...prev, [request.id]: event.target.value as UserRole }))}
                        className="input-saas mt-1"
                        disabled={reviewingRequestId === request.id || request.requested_role === "agency"}
                      >
                        {(request.requested_role === "agency" ? roleDescriptions.filter((item) => item.role === "agency") : roleDescriptions).map((item) => (
                          <option key={`pending-${request.id}-${item.role}`} value={item.role}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      {request.requested_role === "agency" ? (
                        <p className="mt-2 text-xs text-muted">Le richieste agenzia entrano solo con il ruolo Agenzia.</p>
                      ) : null}
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Creata il</p>
                      <p className="mt-1 text-sm text-text">{formatCreatedAt(request.created_at)}</p>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 xl:items-end">
                    <button
                      type="button"
                      className="btn-primary w-full px-3 py-2 text-xs xl:w-auto"
                      disabled={reviewingRequestId === request.id}
                      onClick={() => void reviewAccessRequest(request, "approve")}
                    >
                      {reviewingRequestId === request.id ? "Elaborazione..." : "Approva"}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 xl:w-auto"
                      disabled={reviewingRequestId === request.id}
                      onClick={() => void reviewAccessRequest(request, "reject")}
                    >
                      Rifiuta
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>

      <article className="card p-4 sm:p-5">
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Utenti del tenant</h2>
          <p className="text-sm text-muted">Elenco attuale degli utenti che lavorano nel tenant attivo.</p>
        </div>

        {loading ? (
          <div className="text-sm text-muted">Caricamento utenti...</div>
        ) : sortedMemberships.length === 0 ? (
          <div className="text-sm text-muted">Nessun utente presente nel tenant.</div>
        ) : (
          <div className="space-y-3">
            {sortedMemberships.map((membership) => (
              <article key={`tenant-user-${membership.user_id}`} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <p className="text-base font-semibold text-text">{membership.full_name}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted break-all">{membership.user_id}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-1 text-[11px] font-medium uppercase tracking-[0.08em] ${roleBadgeTone(membership.role)}`}>
                      {roleSwitchLabel(membership.role)}
                    </span>
                    <span className="text-sm text-muted">Creato il: <span className="text-text">{formatCreatedAt(membership.created_at)}</span></span>
                  </div>
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-[180px_minmax(220px,1fr)_220px_150px_160px_120px] xl:items-end">
                  <label className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Ruolo</span>
                    <select
                      value={membership.role}
                      onChange={(event) => void updateMembership(membership, event.target.value as UserRole)}
                      className="input-saas"
                      disabled={updatingUserId === membership.user_id}
                    >
                      {roleDescriptions.map((item) => (
                        <option key={`mobile-${membership.user_id}-${item.role}`} value={item.role}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Stato</span>
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-surface/70 px-3 py-2">
                      <span
                        className={
                          membership.suspended
                            ? "mt-1 inline-flex rounded-full bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-800"
                            : "mt-1 inline-flex rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-800"
                        }
                      >
                        {membership.suspended ? "Sospeso" : "Attivo"}
                      </span>
                      <button
                        type="button"
                        className="btn-secondary ml-auto px-3 py-2 text-xs whitespace-nowrap"
                        disabled={updatingUserId === membership.user_id}
                        onClick={() => void updateMembership(membership, membership.role, undefined, !(membership.suspended ?? false))}
                      >
                        {membership.suspended ? "Riattiva" : "Sospendi"}
                      </button>
                    </div>
                  </div>

                  <label className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Nuova password</span>
                    <input
                      type="password"
                      value={passwordDrafts[membership.user_id] ?? ""}
                      onChange={(event) => setPasswordDrafts((prev) => ({ ...prev, [membership.user_id]: event.target.value }))}
                      className="input-saas"
                      placeholder="Reset password"
                      disabled={updatingUserId === membership.user_id}
                    />
                  </label>

                  <div className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Salva</span>
                    <button
                      type="button"
                      className="btn-secondary h-[42px] px-3 py-2 text-xs whitespace-nowrap"
                      disabled={updatingUserId === membership.user_id || deletingUserId === membership.user_id || !(passwordDrafts[membership.user_id] ?? "").trim()}
                      onClick={() => void updateMembership(membership, membership.role, passwordDrafts[membership.user_id], membership.suspended ?? false)}
                    >
                      {updatingUserId === membership.user_id ? "Salvataggio..." : "Salva password"}
                    </button>
                  </div>

                  <div className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Reset via email</span>
                    <button
                      type="button"
                      className="btn-secondary h-[42px] px-3 py-2 text-xs whitespace-nowrap"
                      disabled={updatingUserId === membership.user_id || deletingUserId === membership.user_id || sendingResetUserId === membership.user_id}
                      onClick={() => void sendResetPasswordEmail(membership)}
                    >
                      {sendingResetUserId === membership.user_id ? "Invio..." : "Invia reset"}
                    </button>
                  </div>

                  <div className="grid gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-400">Elimina</span>
                    <button
                      type="button"
                      className="h-[42px] rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
                      disabled={updatingUserId === membership.user_id || deletingUserId === membership.user_id}
                      onClick={() => void deleteMembership(membership)}
                    >
                      {deletingUserId === membership.user_id ? "Eliminazione..." : "Elimina"}
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}
