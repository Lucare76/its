import type { SupabaseClient } from "@supabase/supabase-js";

const INACTIVITY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

/** Close handled, unanswered outbound conversations; never delete their history. */
export async function closeInactiveWhatsAppThreads(
  admin: SupabaseClient,
  now = new Date(),
) {
  const cutoff = new Date(now.getTime() - INACTIVITY_MS).toISOString();
  let cursor: string | null = null;
  let scanned = 0;
  let closed = 0;
  let skipped = 0;

  for (;;) {
    let query = admin.from("whatsapp_threads")
      .select("id, tenant_id, last_message_at, updated_at")
      .not("tenant_id", "is", null)
      .eq("status", "open")
      .eq("match_status", "matched")
      .eq("unread_count", 0)
      .lt("last_message_at", cutoff)
      // A manual reopen must not immediately be undone by the next run.
      .lt("updated_at", cutoff)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor) query = query.gt("id", cursor);
    const { data: threads, error } = await query;
    if (error) throw error;
    if (!threads?.length) break;

    // Small bounded batches keep database connections and query load predictable.
    for (let offset = 0; offset < threads.length; offset += 10) {
      await Promise.all(threads.slice(offset, offset + 10).map(async (thread) => {
        scanned += 1;
        const { data: latest, error: messageError } = await admin
          .from("whatsapp_messages")
          .select("direction, status, timestamp, raw_message")
          .eq("tenant_id", thread.tenant_id)
          .eq("thread_id", thread.id)
          .order("timestamp", { ascending: false, nullsFirst: true })
          .order("created_at", { ascending: false })
          // Ambiguous equal timestamps are kept open, rather than hiding a reply.
          .limit(2);
        if (messageError) throw messageError;
        const message = latest?.[0];
        const raw = message?.raw_message as { source?: string } | null;
        const timestamp = message?.timestamp ? Date.parse(message.timestamp) : NaN;
        if (!message || message.direction !== "outbound" ||
          !["sent", "delivered", "read"].includes(message.status ?? "") ||
          !Number.isFinite(timestamp) || timestamp >= Date.parse(cutoff) ||
          timestamp !== Date.parse(thread.last_message_at) ||
          raw?.source === "office_closed_auto_reply" ||
          (latest?.[1]?.timestamp === message.timestamp)) {
          skipped += 1;
          return;
        }

        // Compare-and-set: a concurrent inbound, new send, review, read or reopen
        // changes these fields. In that case this update affects zero rows.
        const { data: changed, error: updateError } = await admin
          .from("whatsapp_threads")
          .update({ status: "closed", updated_at: now.toISOString() })
          .eq("tenant_id", thread.tenant_id)
          .eq("id", thread.id)
          .eq("status", "open")
          .eq("match_status", "matched")
          .eq("unread_count", 0)
          .eq("last_message_at", thread.last_message_at)
          .eq("updated_at", thread.updated_at)
          .select("id");
        if (updateError) throw updateError;
        if (changed?.length) closed += changed.length;
        else skipped += 1;
      }));
    }
    cursor = String(threads[threads.length - 1].id);
    if (threads.length < PAGE_SIZE) break;
  }
  return { scanned, closed, skipped, cutoff };
}
