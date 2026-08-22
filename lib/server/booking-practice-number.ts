/**
 * Numero pratica leggibile (ITS-YYYY-N) per una nuova prenotazione — vedi
 * supabase/migrations/0243_booking_practice_numbers.sql per la generazione
 * atomica lato DB (INSERT ... ON CONFLICT DO UPDATE ... RETURNING, sicura
 * contro due creazioni simultanee). Questo modulo si limita a invocare la
 * funzione RPC e a normalizzare l'esito: best-effort, mai bloccante — se la
 * generazione fallisce per un motivo transitorio, la prenotazione viene
 * comunque creata (stesso principio gia' usato per ensureWhatsAppContact/
 * autoAllocateBusService in app/api/ops/new-booking/route.ts), semplicemente
 * senza numero pratica.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function resolveBookingPracticeNumber(admin: SupabaseClient, tenantId: string): Promise<string | null> {
  try {
    const { data, error } = await admin.rpc("next_booking_practice_number", { p_tenant_id: tenantId });
    if (error) throw error;
    return typeof data === "string" && data.trim() ? data : null;
  } catch (error) {
    console.error("next_booking_practice_number failed:", error);
    return null;
  }
}
