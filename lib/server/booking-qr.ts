import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export function generateQrToken(): string {
  return crypto.randomBytes(18).toString("hex"); // 36-char hex, no dashes
}

async function insertAndGet(
  admin: SupabaseClient,
  tenantId: string,
  bookingId: string,
  direction: "outbound" | "return",
  serviceDate: string
): Promise<string> {
  const token = generateQrToken();
  await admin.from("booking_qr_codes").upsert(
    {
      booking_id: bookingId,
      direction,
      qr_token: token,
      tenant_id: tenantId,
      service_date: serviceDate,
      status: "active",
    },
    { onConflict: "booking_id,direction", ignoreDuplicates: true }
  );
  const { data } = await admin
    .from("booking_qr_codes")
    .select("qr_token")
    .eq("booking_id", bookingId)
    .eq("direction", direction)
    .maybeSingle();
  return data?.qr_token ?? token;
}

export async function generateBookingQrCodes(
  admin: SupabaseClient,
  tenantId: string,
  bookingId: string,
  serviceDate: string,
  departureDate: string | null
): Promise<{ outbound: string; return: string | null }> {
  const outbound = await insertAndGet(admin, tenantId, bookingId, "outbound", serviceDate);
  const ret = departureDate
    ? await insertAndGet(admin, tenantId, bookingId, "return", departureDate)
    : null;
  return { outbound, return: ret };
}

export async function resolveQrToken(
  admin: SupabaseClient,
  tenantId: string,
  token: string
): Promise<{ bookingId: string; direction: "outbound" | "return" } | null> {
  const { data } = await admin
    .from("booking_qr_codes")
    .select("booking_id, direction")
    .eq("qr_token", token)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) return null;
  return { bookingId: data.booking_id, direction: data.direction as "outbound" | "return" };
}

export async function markQrUsed(
  admin: SupabaseClient,
  tenantId: string,
  token: string,
  userId: string
): Promise<void> {
  await admin
    .from("booking_qr_codes")
    .update({ status: "used", used_at: new Date().toISOString(), used_by: userId })
    .eq("qr_token", token)
    .eq("tenant_id", tenantId)
    .neq("status", "used");
}
