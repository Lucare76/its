import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

function loadDotEnvLocal() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

async function signIn(email, password) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const signIn = await supabase.auth.signInWithPassword({ email, password });
  if (signIn.error || !signIn.data.session?.access_token || !signIn.data.user?.id) {
    throw new Error(signIn.error?.message ?? "Login fallito");
  }
  return { token: signIn.data.session.access_token, userId: signIn.data.user.id };
}

async function main() {
  loadDotEnvLocal();
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3010").replace(/\/$/, "");
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const agencyLogin = await signIn(process.env.AGENCY_TEST_EMAIL || "agency@demo.com", process.env.AGENCY_TEST_PASSWORD || "demo123");
  const listBeforeResponse = await fetch(`${appUrl}/api/agency/bookings?limit=20`, {
    headers: { Authorization: `Bearer ${agencyLogin.token}` }
  });
  const listBefore = await listBeforeResponse.json();
  if (!listBeforeResponse.ok) throw new Error(`Agency list failed: ${JSON.stringify(listBefore)}`);

  const { data: hotels } = await admin.from("hotels").select("id").limit(1);
  if (!hotels?.[0]?.id) throw new Error("Nessun hotel disponibile per smoke test agenzia.");
  const hotelId = hotels[0].id;
  const ref = `BETA-${Date.now()}`;
  const createPayload = {
    booking_service_kind: "transfer_port_hotel",
    customer_first_name: "Beta",
    customer_last_name: "Agency",
    customer_email: "beta-agency@example.com",
    customer_phone: "3331234567",
    arrival_date: "2026-06-10",
    arrival_time: "12:10",
    departure_date: "2026-06-12",
    departure_time: "09:20",
    hotel_id: hotelId,
    pax: 2,
    transport_code: "NA123",
    include_ferry_tickets: true,
    ferry_outbound_code: "OUT123",
    ferry_return_code: "RET123",
    notes: `Smoke test agency ${ref}`
  };

  const createResponse = await fetch(`${appUrl}/api/agency/bookings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${agencyLogin.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(createPayload)
  });
  const createBody = await createResponse.json();
  if (!createResponse.ok) throw new Error(`Agency create failed: ${JSON.stringify(createBody)}`);

  const listAfterResponse = await fetch(`${appUrl}/api/agency/bookings?limit=50`, {
    headers: { Authorization: `Bearer ${agencyLogin.token}` }
  });
  const listAfter = await listAfterResponse.json();
  if (!listAfterResponse.ok) throw new Error(`Agency list after failed: ${JSON.stringify(listAfter)}`);

  const serviceId = createBody.id ?? createBody.existing_id ?? null;
  const { data: statusEvents } = serviceId
    ? await admin.from("status_events").select("id, status").eq("service_id", serviceId)
    : { data: [] };

  console.log(
    JSON.stringify(
      {
        before_count: Array.isArray(listBefore.rows) ? listBefore.rows.length : 0,
        create: createBody,
        after_count: Array.isArray(listAfter.rows) ? listAfter.rows.length : 0,
        listed_after: Array.isArray(listAfter.rows) ? listAfter.rows.some((row) => row.id === serviceId) : false,
        status_events: statusEvents ?? []
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
