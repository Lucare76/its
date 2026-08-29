// Batched Supabase lookups backing the SNAV coverage detection.
// Mirrors lib/server/medmar-convocation-coverage-source.ts exactly (same
// "successful send" rule: status='inviato' AND, if a webhook status exists,
// it isn't 'failed') — reuses the generic MedmarSentSnapshot shape and the
// shared status-resolution helpers, only the table/column names differ
// (snav_convocation_rows.departure_date / vessel_time).
//
// Two queries total, chunked only if the id list is large (spec §18: "NO N+1").

import type { createAdminClient } from "@/lib/server/whatsapp";
import { normalizeStatusGroup, resolveLatestStatusByMessageId, type MessageStatusSource } from "@/lib/server/whatsapp-log-shared";
import type { MedmarSentSnapshot } from "@/lib/medmar-convocation-coverage";

type AdminClient = ReturnType<typeof createAdminClient>;

type SentRowFromDb = {
  id: string;
  service_id: string | null;
  phone_e164: string | null;
  customer_name: string | null;
  departure_date: string | null;
  hotel: string | null;
  passengers: string | null;
  pickup_time: string | null;
  vessel_time: string | null;
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
    travel_date_iso: row.departure_date,
    hotel: row.hotel ?? "",
    passengers: row.passengers ?? "",
    pickup_time: row.pickup_time ?? "",
    vessel_time: row.vessel_time ?? "",
    sent_at: row.sent_at,
  };
}

function fallbackKey(row: SentRowFromDb): string | null {
  const phone = (row.phone_e164 ?? "").trim();
  const date = (row.departure_date ?? "").trim();
  const vessel = (row.vessel_time ?? "").trim().toLowerCase();
  if (!phone || !date || !vessel) return null;
  return `${phone}||${date}||${vessel}`;
}

export type SnavCoverageSnapshots = {
  byServiceId: Map<string, MedmarSentSnapshot>;
  byFallbackKey: Map<string, MedmarSentSnapshot[]>;
};

const EMPTY: SnavCoverageSnapshots = { byServiceId: new Map(), byFallbackKey: new Map() };

export async function loadSnavSentSnapshots(
  admin: AdminClient,
  tenantId: string,
  serviceIds: string[],
  phoneE164s: string[],
): Promise<SnavCoverageSnapshots> {
  const uniqueServiceIds = [...new Set(serviceIds.filter(Boolean))];
  const uniquePhones = [...new Set(phoneE164s.filter(Boolean))];
  if (uniqueServiceIds.length === 0 && uniquePhones.length === 0) return EMPTY;

  const SELECT = "id, service_id, phone_e164, customer_name, departure_date, hotel, passengers, pickup_time, vessel_time, provider_message_id, sent_at";

  const rows: SentRowFromDb[] = [];

  for (const idsChunk of chunk(uniqueServiceIds, 500)) {
    if (idsChunk.length === 0) continue;
    const { data } = await admin
      .from("snav_convocation_rows")
      .select(SELECT)
      .eq("tenant_id", tenantId)
      .eq("status", "inviato")
      .in("service_id", idsChunk)
      .limit(2000);
    if (data) rows.push(...(data as SentRowFromDb[]));
  }

  // Fallback candidates: only rows with no service_id (pre-STEP-2 Excel
  // history) can need the phone+date+vessel fallback.
  for (const phonesChunk of chunk(uniquePhones, 500)) {
    if (phonesChunk.length === 0) continue;
    const { data } = await admin
      .from("snav_convocation_rows")
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
