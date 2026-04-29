import { type SupabaseClient } from "@supabase/supabase-js";

type ExpirableLegRow = {
  id: string;
  medmar_ar_tickets: { travel_date: string } | Array<{ travel_date: string }> | null;
};

function normalizeJoinedTicket(
  joined: ExpirableLegRow["medmar_ar_tickets"],
): { travel_date: string } | null {
  if (Array.isArray(joined)) return joined[0] ?? null;
  return joined ?? null;
}

export async function expirePastDueRecoverableLegs(
  admin: SupabaseClient,
  tenantId: string,
) {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await admin
    .from("medmar_ar_ticket_legs")
    .select("id, medmar_ar_tickets!inner(travel_date)")
    .eq("tenant_id", tenantId)
    .eq("status", "available_for_reassignment")
    .lt("medmar_ar_tickets.travel_date", today);

  if (error) {
    throw new Error(error.message);
  }

  const expiredIds = (data ?? [])
    .map((row) => row as ExpirableLegRow)
    .filter((row) => normalizeJoinedTicket(row.medmar_ar_tickets)?.travel_date)
    .map((row) => row.id);

  if (expiredIds.length === 0) {
    return { expiredCount: 0 };
  }

  const { error: updateError } = await admin
    .from("medmar_ar_ticket_legs")
    .update({
      status: "lost",
      status_changed_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .in("id", expiredIds);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { expiredCount: expiredIds.length };
}
