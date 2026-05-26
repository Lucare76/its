import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { GET, POST } from "../app/api/ops/disponibilita/route";

function loadEnv() {
  for (const file of [".env", ".env.local"]) {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) continue;
    for (const line of fs.readFileSync(fullPath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      process.env[key] ??= value;
    }
  }
}

type DriverRow = { id: string; user_id: string | null; full_name: string };
type VehicleRow = { id: string; label: string };
type AvailabilityRow = {
  driver_profile_id: string;
  available: boolean;
  available_from: string | null;
  available_to: string | null;
  vehicle_1_id: string | null;
  vehicle_1_to: string | null;
  vehicle_2_id: string | null;
  vehicle_2_from: string | null;
};

const TEST_DATE = "2099-06-16";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hhmm(value: string | null) {
  return value?.slice(0, 5) ?? null;
}

function postRequest(token: string, payload: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/ops/disponibilita", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/ops/disponibilita?date=${TEST_DATE}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function postJson(token: string, payload: Record<string, unknown>) {
  const response = await POST(postRequest(token, payload));
  const body = await response.json() as { ok: boolean; error?: string };
  assert(response.status < 400 && body.ok, `${payload.action}: ${response.status} ${body.error ?? "errore"}`);
}

async function loadAvailability(token: string) {
  const response = await GET(getRequest(token));
  const body = await response.json() as { ok: boolean; error?: string; driver_availability: AvailabilityRow[] };
  assert(response.status === 200 && body.ok, `GET disponibilita: ${response.status} ${body.error ?? "errore"}`);
  return new Map(body.driver_availability.map((row) => [row.driver_profile_id, row]));
}

async function main() {
  loadEnv();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.E2E_TEST_EMAIL ?? process.env.PDF_PREVIEW_USER_EMAIL;
  const password = process.env.E2E_TEST_PASSWORD ?? process.env.PDF_PREVIEW_USER_PASSWORD;
  assert(supabaseUrl && anonKey && serviceKey && email && password, "Env Supabase/E2E mancanti.");

  const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const signIn = await anon.auth.signInWithPassword({ email, password });
  assert(signIn.data.session?.access_token && signIn.data.user?.id, signIn.error?.message ?? "Login fallito.");
  const token = signIn.data.session.access_token;

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", signIn.data.user.id)
    .limit(1);
  assert(!membershipError && memberships?.[0]?.tenant_id, membershipError?.message ?? "Membership non trovata.");
  const tenantId = memberships[0].tenant_id as string;

  await admin.from("daily_availability_confirmations").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
  await admin.from("driver_daily_availability").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);

  const [{ data: drivers, error: driversError }, { data: vehicles, error: vehiclesError }] = await Promise.all([
    admin.from("driver_profiles").select("id,user_id,full_name").eq("tenant_id", tenantId).in("full_name", ["MARIO", "ILARIA", "LEO"]),
    admin.from("vehicles").select("id,label").eq("tenant_id", tenantId).in("label", ["DUCATO GRIGIO", "25 BIANCO"]),
  ]);
  assert(!driversError && !vehiclesError, driversError?.message ?? vehiclesError?.message ?? "Errore lookup.");
  const driverByName = new Map((drivers as DriverRow[]).map((driver) => [driver.full_name, driver]));
  const vehicleByLabel = new Map((vehicles as VehicleRow[]).map((vehicle) => [vehicle.label, vehicle]));
  const mario = driverByName.get("MARIO");
  const ilaria = driverByName.get("ILARIA");
  const leo = driverByName.get("LEO");
  const ducato = vehicleByLabel.get("DUCATO GRIGIO");
  const bianco = vehicleByLabel.get("25 BIANCO");
  assert(mario && ilaria && leo && ducato && bianco, "Driver o mezzi di test non trovati.");

  await postJson(token, {
    action: "save_driver",
    date: TEST_DATE,
    driver_profile_id: mario.id,
    available: true,
    available_from: "06:30",
    available_to: "17:30",
  });
  let rows = await loadAvailability(token);
  assert(rows.get(mario.id)?.available === true, "Test 1: MARIO non attivo dopo reload.");
  assert(hhmm(rows.get(mario.id)?.available_from ?? null) === "06:30", "Test 1: inizio MARIO perso.");
  assert(hhmm(rows.get(mario.id)?.available_to ?? null) === "17:30", "Test 1: fine MARIO perso.");

  await postJson(token, {
    action: "save_driver",
    date: TEST_DATE,
    driver_profile_id: mario.id,
    available: true,
    available_from: "06:30",
    available_to: "17:30",
    vehicle_1_id: ducato.id,
  });
  rows = await loadAvailability(token);
  assert(rows.get(mario.id)?.vehicle_1_id === ducato.id, "Test 2: DUCATO GRIGIO perso.");

  await postJson(token, {
    action: "save_driver",
    date: TEST_DATE,
    driver_profile_id: mario.id,
    available: true,
    available_from: "06:30",
    available_to: "17:30",
    vehicle_1_id: ducato.id,
    vehicle_1_to: "14:00",
    vehicle_2_id: bianco.id,
    vehicle_2_from: "14:00",
  });
  rows = await loadAvailability(token);
  assert(rows.get(mario.id)?.vehicle_1_id === ducato.id, "Test 3: mezzo 1 perso.");
  assert(hhmm(rows.get(mario.id)?.vehicle_1_to ?? null) === "14:00", "Test 3: fine mezzo 1 persa.");
  assert(rows.get(mario.id)?.vehicle_2_id === bianco.id, "Test 3: mezzo 2 perso.");
  assert(hhmm(rows.get(mario.id)?.vehicle_2_from ?? null) === "14:00", "Test 3: inizio mezzo 2 perso.");

  for (const driver of [mario, ilaria, leo]) {
    await postJson(token, {
      action: "save_driver",
      date: TEST_DATE,
      driver_profile_id: driver.id,
      available: true,
      available_from: driver.id === mario.id ? "06:30" : "08:00",
      available_to: driver.id === mario.id ? "17:30" : "18:00",
    });
  }
  rows = await loadAvailability(token);
  assert([mario, ilaria, leo].every((driver) => rows.get(driver.id)?.available === true), "Test 4: salvataggio multiplo perso.");

  await postJson(token, {
    action: "save_driver",
    date: TEST_DATE,
    driver_profile_id: mario.id,
    available: false,
  });
  rows = await loadAvailability(token);
  assert(rows.get(mario.id)?.available === false, "Test 5: disattivazione MARIO persa.");

  await postJson(token, {
    action: "save_driver",
    date: TEST_DATE,
    driver_profile_id: ilaria.id,
    available: true,
    available_from: "09:00",
    available_to: "16:00",
  });
  rows = await loadAvailability(token);
  assert(rows.get(ilaria.id)?.available === true, "Test 6: ILARIA non attiva.");
  assert(hhmm(rows.get(ilaria.id)?.available_from ?? null) === "09:00", "Test 6: modifica ILARIA persa.");
  assert(rows.get(mario.id)?.available === false, "Test 6: MARIO non e rimasto invariato.");

  await admin.from("daily_availability_confirmations").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
  await admin.from("driver_daily_availability").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);

  console.log(JSON.stringify({ ok: true, date: TEST_DATE, tests: 6 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
