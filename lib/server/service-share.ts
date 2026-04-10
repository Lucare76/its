import { createClient } from "@supabase/supabase-js";

export interface PublicSharedService {
  id: string;
  date: string;
  time: string;
  customer_name: string;
  pax: number;
  vessel: string;
  meeting_point: string | null;
  share_token: string | null;
  share_expires_at: string | null;
  hotel_name: string | null;
  hotel_zone: string | null;
}

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRole) return null;
  return createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

export async function getSharedServiceByToken(token: string): Promise<PublicSharedService | null> {
  if (!token || token.length < 32) return null;
  const admin = createAdminClient();
  if (!admin) return null;

  const { data, error } = await admin
    .from("services")
    .select("id, date, time, customer_name, pax, vessel, meeting_point, share_token, share_expires_at, hotels(name, zone)")
    .eq("share_token", token)
    .maybeSingle();

  if (error || !data) return null;

  if (data.share_expires_at) {
    const expiresAtMs = new Date(data.share_expires_at).getTime();
    if (Number.isFinite(expiresAtMs) && expiresAtMs < Date.now()) {
      return null;
    }
  }

  const hotel = Array.isArray(data.hotels) ? data.hotels[0] : (data.hotels as { name?: string; zone?: string } | null);

  return {
    id: data.id,
    date: data.date,
    time: data.time,
    customer_name: data.customer_name,
    pax: data.pax,
    vessel: data.vessel,
    meeting_point: data.meeting_point,
    share_token: data.share_token,
    share_expires_at: data.share_expires_at,
    hotel_name: hotel?.name ?? null,
    hotel_zone: hotel?.zone ?? null
  };
}

export function formatServiceDateTime(date: string, time: string) {
  const hhmm = time.length >= 5 ? time.slice(0, 5) : time;
  const [year, month, day] = date.split("-");
  if (!year || !month || !day) return `${date} ${hhmm}`;
  return `${day}/${month}/${year} ${hhmm}`;
}

