import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgencyRecipientCandidate } from "./recipient-resolver";

/**
 * Fase 2B.6 — lookup diretto per FK services.agency_id -> agencies.id.
 *
 * Priorità email: booking_email/booking_emails prima di
 * contact_email/contact_emails prima di invoice_email. Confermata contro il
 * pattern operativo già esistente in app/(app)/crm-agencies/page.tsx
 * (`agency.booking_email ?? agency.contact_email` per l'invio email report,
 * riga ~1690): booking_email è il campo destinato alla corrispondenza
 * prenotazioni/documenti, contact_email è un contatto generico, invoice_email
 * è riservato alle fatture (mai usato per invii operativi nel resto del
 * codebase) — semanticamente sbagliato metterlo primo per un documento come
 * il biglietto Medmar pulito. Le colonne jsonb *_emails (multi-email,
 * migrazione 0026) fanno da fallback solo se il campo singolo corrispondente
 * è vuoto: nel CRM restano i campi editati attivamente, gli array sono un
 * backfill storico.
 */
export async function loadAgencyRecipient(
  admin: SupabaseClient,
  tenantId: string,
  agencyId: string
): Promise<AgencyRecipientCandidate> {
  const result = await admin
    .from("agencies")
    .select("name, invoice_email, contact_email, booking_email, contact_emails, booking_emails")
    .eq("tenant_id", tenantId)
    .eq("id", agencyId)
    .maybeSingle();
  if (result.error || !result.data) return null;
  const row = result.data as {
    name: string;
    invoice_email: string | null;
    contact_email: string | null;
    booking_email: string | null;
    contact_emails: string[] | null;
    booking_emails: string[] | null;
  };
  const email =
    row.booking_email ||
    row.booking_emails?.[0] ||
    row.contact_email ||
    row.contact_emails?.[0] ||
    row.invoice_email ||
    null;
  return { name: row.name, email };
}
