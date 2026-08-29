// Batched Supabase lookups backing the MEDMAR coverage detection (STEP 2).
// Two queries total, chunked only if the id list is large — never one query
// per row (spec §19: "NO N+1").
//
// A medmar_convocation_rows row with status = 'inviato' means Meta *accepted*
// the send; it does not by itself mean the message actually reached the
// customer. Any row whose provider_message_id later resolved to a 'failed'
// webhook status is excluded from "successfully sent" — reusing the exact
// same status-resolution rules as the WhatsApp log (lib/server/whatsapp-log-shared.ts).

import type { createAdminClient } from "@/lib/server/whatsapp";
import { normalizeStatusGroup, resolveLatestStatusByMessageId, type MessageStatusSource } from "@/lib/server/whatsapp-log-shared";
import type { MedmarSentSnapshot } from "@/lib/medmar-convocation-coverage";

type AdminClient = ReturnType<typeof createAdminClient>;

type SentRowFromDb = {
  id: string;
  service_id: string | null;
  phone_e164: string | null;
  customer_name: string | null;
  travel_date_iso: string | null;
  hotel: string | null;
  passengers: string | null;
  pickup_time: string | null;
  departure_time: string | null; // "ora nave" (vessel_time)
  provider_message_id: string | null;
  sent_at: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toSnapshot(row: SentRowFromDb): MedmarSentSnapshot {
  return {
    source_row_id: row.id,
    phone_e164: row.phone_e164,
    customer_name: row.customer_name ?? "",
    travel_date_iso: row.travel_date_iso,
    hotel: row.hotel ?? "",
    passengers: row.passengers ?? "",
    pickup_time: row.pickup_time ?? "",
    vessel_time: row.departure_time ?? "",
    sent_at: row.sent_at,
  };
}

function fallbackKey(row: SentRowFromDb): string | null {
  const phone = (row.phone_e164 ?? "").trim();
  const date = (row.travel_date_iso ?? "").trim();
  const vessel = (row.departure_time ?? "").trim().toLowerCase();
  if (!phone || !date || !vessel) return null;
  return `${phone}||${date}||${vessel}`;
}

export type MedmarCoverageSnapshots = {
  byServiceId: Map<string, MedmarSentSnapshot>;
  byFallbackKey: Map<string, MedmarSentSnapshot[]>;
};

const EMPTY: MedmarCoverageSnapshots = { byServiceId: new Map(), byFallbackKey: new Map() };

export async function loadMedmarSentSnapshots(
  admin: AdminClient,
  tenantId: string,
  serviceIds: string[],
  phoneE164s: string[],
): Promise<MedmarCoverageSnapshots> {
  const uniqueServiceIds = [...new Set(serviceIds.filter(Boolean))];
  const uniquePhones = [...new Set(phoneE164s.filter(Boolean))];
  if (uniqueServiceIds.length === 0 && uniquePhones.length === 0) return EMPTY;

  const SELECT = "id, service_id, phone_e164, customer_name, travel_date_iso, hotel, passengers, pickup_time, departure_time, provider_message_id, sent_at";

  const rows: SentRowFromDb[] = [];

  for (const idsChunk of chunk(uniqueServiceIds, 500)) {
    if (idsChunk.length === 0) continue;
    const { data } = await admin
      .from("medmar_convocation_rows")
      .select(SELECT)
      .eq("tenant_id", tenantId)
      .eq("status", "inviato")
      .in("service_id", idsChunk)
      .limit(2000);
    if (data) rows.push(...(data as SentRowFromDb[]));
  }

  // Fallback candidates: only rows with no service_id (pre-STEP-2 Excel
  // history) can need the phone+date+vessel fallback — rows that already
  // have a service_id are matched exactly above, never via fallback.
  for (const phonesChunk of chunk(uniquePhones, 500)) {
    if (phonesChunk.length === 0) continue;
    const { data } = await admin
      .from("medmar_convocation_rows")
      .select(SELECT)
      .eq("tenant_id", tenantId)
      .eq("status", "inviato")
      .is("service_id", null)
      .in("phone_e164", phonesChunk)
      .limit(2000);
    if (data) rows.push(...(data as SentRowFromDb[]));
  }

  if (rows.length === 0) return EMPTY;

  const messageIds = rows.map((r) => r.provider_message_id).filter((id): id is string => !!id);
  let statuses: MessageStatusSource[] = [];
  for (const idsChunk of chunk([...new Set(messageIds)], 500)) {
    const { data } = await admin
      .from("whatsapp_message_statuses")
      .select("wa_message_id, status, timestamp, created_at")
      .in("wa_message_id", idsChunk);
    if (data) statuses = statuses.concat(data as MessageStatusSource[]);
  }
  const latestStatusByMsg = resolveLatestStatusByMessageId(statuses);

  // "Successful send" = Meta accepted it (status='inviato') AND, if we have
  // a webhook status for it, that status isn't 'failed'.
  const successfulRows = rows.filter((r) => {
    if (!r.provider_message_id) return true; // accepted, no webhook update yet
    const latest = latestStatusByMsg.get(r.provider_message_id);
    if (!latest) return true;
    return normalizeStatusGroup(latest.status) !== "failed";
  });

  const byServiceId = new Map<string, MedmarSentSnapshot>();
  const byFallbackKey = new Map<string, MedmarSentSnapshot[]>();

  for (const row of successfulRows) {
    const snapshot = toSnapshot(row);

    if (row.service_id) {
      const existing = byServiceId.get(row.service_id);
      if (!existing || (snapshot.sent_at ?? "") > (existing.sent_at ?? "")) {
        byServiceId.set(row.service_id, snapshot);
      }
      continue;
    }

    const key = fallbackKey(row);
    if (!key) continue;
    const list = byFallbackKey.get(key) ?? [];
    list.push(snapshot);
    byFallbackKey.set(key, list);
  }

  return { byServiceId, byFallbackKey };
}
