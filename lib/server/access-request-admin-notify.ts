import type { SupabaseClient } from "@supabase/supabase-js";
import { sendOnboardingTransactionalEmail } from "@/lib/server/onboarding-email-transport";
import { getConfiguredAppUrl } from "@/lib/app-url";

const escape = (value: string) => value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Saved requests survive notification failures. Never broadcast across tenants. */
export async function notifyAccessRequestAdmins(admin: SupabaseClient, input: {
  requestId: string; tenantId?: string | null; fullName: string; email: string; agencyName?: string | null;
}) {
  const result = { in_app: 0, email_sent: 0, errors: [] as string[] };
  try {
    let tenantId = input.tenantId;
    // Public signup requests are unassigned. Use the same server-owned default
    // tenant as the authenticated access-request flow, never a client tenant ID.
    if (!tenantId) {
      const tenants = await admin.from("tenants").select("id").order("created_at", { ascending: true }).limit(1);
      if (tenants.error) throw new Error(tenants.error.message);
      tenantId = tenants.data?.[0]?.id;
    }
    if (!tenantId) throw new Error("Tenant destinatario non disponibile.");
    const members = await admin.from("memberships").select("user_id,role,suspended").eq("tenant_id", tenantId).in("role", ["admin", "supervisor"]);
    if (members.error) throw new Error(members.error.message);
    const ids = [...new Set((members.data ?? []).filter(m => m.suspended !== true && ["admin", "supervisor"].includes(m.role)).map(m => m.user_id))];
    if (!ids.length) throw new Error("Nessun amministratore attivo disponibile.");
    const body = `${input.fullName} · ${input.agencyName || input.email}`;
    const notifications = await admin.from("notifications").insert(ids.map(userId => ({ tenant_id: tenantId, user_id: userId, type: "access_requested", title: "Nuova richiesta di accesso", body, link: "/settings/users", reference_id: input.requestId })));
    if (notifications.error) result.errors.push(notifications.error.message);
    else result.in_app = ids.length;
    const sent = new Set<string>();
    for (const id of ids) {
      try {
        const user = await admin.auth.admin.getUserById(id);
        if (user.error) throw new Error(user.error.message);
        const to = user.data.user?.email?.trim().toLowerCase();
        if (!to || sent.has(to)) continue;
        sent.add(to);
        const url = `${getConfiguredAppUrl()}/settings/users`;
        const email = await sendOnboardingTransactionalEmail({ to, subject: `Nuova richiesta di accesso ITS — ${input.agencyName || input.fullName}`,
          html: `<h2>Nuova richiesta di accesso</h2><p>${escape(input.fullName)}</p><p>${escape(input.email)}</p><p>${escape(input.agencyName || "")}</p><p><a href="${escape(url)}">Esamina la richiesta</a></p>`,
          text: `Nuova richiesta di accesso\n${input.fullName}\n${input.email}\n${input.agencyName || ""}\nEsamina: ${url}`, failureLabel: "Notifica amministratore non inviata" });
        if (email.status === "sent") result.email_sent++;
        else result.errors.push(email.error || email.status);
      } catch (error) { result.errors.push(error instanceof Error ? error.message : "Errore notifica email."); }
    }
  } catch (error) { result.errors.push(error instanceof Error ? error.message : "Errore notifica amministratori."); }
  return result;
}
