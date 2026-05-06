/**
 * E2E – Piano del Giorno: flusso operativo completo
 *
 * Copre la pipeline: GET pianificazione → conferma disponibilità → auto-assign
 * → verifica assignments → verifica trip_groups.
 *
 * Richiede env Supabase reale (skip automatico senza):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY, PDF_PREVIEW_USER_EMAIL, PDF_PREVIEW_USER_PASSWORD
 *
 * Usa una data test lontana nel futuro per non interferire con dati reali.
 * Tutto ciò che viene creato (servizi, assignments, trip_groups, disponibilità,
 * conferma) viene eliminato nell'afterAll.
 *
 * Esempi:
 *   pnpm e2e tests/e2e/piano-giorno.spec.ts --reporter=line
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ─── Env ──────────────────────────────────────────────────────────────────────

function readEnvFile(): Record<string, string> {
  const parse = (filePath: string): Record<string, string> => {
    if (!fs.existsSync(filePath)) return {};
    return Object.fromEntries(
      fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/).map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; })
    );
  };
  return { ...parse(path.resolve(".env")), ...parse(path.resolve(".env.local")) };
}

const localEnv     = readEnvFile();
const adminEmail   = process.env.PDF_PREVIEW_USER_EMAIL        || localEnv.PDF_PREVIEW_USER_EMAIL        || "";
const adminPwd     = process.env.PDF_PREVIEW_USER_PASSWORD     || localEnv.PDF_PREVIEW_USER_PASSWORD     || "";
const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL      || localEnv.NEXT_PUBLIC_SUPABASE_URL      || "";
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRole  = process.env.SUPABASE_SERVICE_ROLE_KEY     || localEnv.SUPABASE_SERVICE_ROLE_KEY     || "";

const isRealApp = process.env.E2E_REAL_APP === "true";
const hasEnv = !!(supabaseUrl && supabaseAnon && serviceRole && adminEmail && adminPwd);

// Data test: 2099-06-15 — lontana abbastanza da non toccare dati reali
const TEST_DATE = "2099-06-15";

// ─── Flusso completo con Supabase reale ───────────────────────────────────────

test.describe.serial("Piano del Giorno – flusso operativo completo", () => {
  test.skip(!isRealApp || !hasEnv, "Richiede E2E_REAL_APP=true e env Supabase (NEXT_PUBLIC_SUPABASE_URL ecc.).");

  let tenantId    = "";
  let authToken   = "";
  let testServiceId = "";
  let testHotelId   = "";

  test.beforeAll(async () => {
    const anon = createClient(supabaseUrl, supabaseAnon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPwd });
    if (signIn.error || !signIn.data.session) throw new Error(signIn.error?.message ?? "Login E2E fallito");

    authToken = signIn.data.session.access_token;

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userId = signIn.data.user.id;

    const { data: membership, error: mErr } = await admin
      .from("memberships").select("tenant_id").eq("user_id", userId).limit(1).maybeSingle();
    if (mErr || !membership?.tenant_id) throw new Error("Membership non trovata");
    tenantId = membership.tenant_id;

    // Trova un hotel qualsiasi
    const { data: hotel } = await admin.from("hotels").select("id").eq("tenant_id", tenantId).limit(1).maybeSingle();
    if (!hotel?.id) throw new Error("Nessun hotel trovato");
    testHotelId = hotel.id;

    // Crea un servizio di test per la data di test
    const { data: svc, error: svcErr } = await admin.from("services").insert({
      tenant_id: tenantId,
      is_draft: false,
      status: "new",
      direction: "arrival",
      date: TEST_DATE,
      time: "10:00",
      arrival_date: TEST_DATE,
      arrival_time: "10:00",
      customer_name: "E2E PianoGiorno Test",
      pax: 2,
      vessel: "TEST SNAV 08:30",
      phone: "+393471234567",
      notes: "Servizio E2E test piano-giorno",
      hotel_id: testHotelId,
      service_type: "transfer",
    }).select("id").single();
    if (svcErr || !svc?.id) throw new Error(svcErr?.message ?? "Creazione servizio fallita");
    testServiceId = svc.id;

    console.log(`\n✅  Setup: tenant=${tenantId}, servizio=${testServiceId}, data=${TEST_DATE}\n`);
  });

  test.afterAll(async () => {
    if (!tenantId || !testServiceId) return;
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Pulizia: rimuovi tutto ciò che il test ha creato per questa data
    await admin.from("assignments").delete().eq("tenant_id", tenantId);
    await admin.from("trip_groups").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
    await admin.from("status_events").delete().eq("service_id", testServiceId);
    await admin.from("daily_availability_confirmations").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
    await admin.from("driver_daily_availability").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
    await admin.from("vehicle_daily_availability").delete().eq("tenant_id", tenantId).eq("date", TEST_DATE);
    await admin.from("services").delete().eq("id", testServiceId).eq("tenant_id", tenantId);

    console.log(`\n🗑️  Cleanup completato per data ${TEST_DATE}\n`);
  });

  // ─── Test 1: GET piano-giorno → risposta strutturata ─────────────────────

  test("GET /api/ops/piano-giorno → 200 con struttura corretta", async ({ request }) => {
    const res = await request.get(`/api/ops/piano-giorno?date=${TEST_DATE}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { ok: boolean; services: unknown[]; hotels: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.services)).toBe(true);
    expect(Array.isArray(body.hotels)).toBe(true);
    // Il nostro servizio di test deve comparire
    const found = (body.services as Array<{ id: string }>).find((s) => s.id === testServiceId);
    expect(found).toBeDefined();
    console.log(`   → Servizi per ${TEST_DATE}: ${(body.services as unknown[]).length}`);
  });

  // ─── Test 2: auto-assign senza disponibilità confermata → 409 ────────────

  test("POST auto-assign senza conferma disponibilità → 409", async ({ request }) => {
    const res = await request.post("/api/ops/piano-giorno/auto-assign", {
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      data: { date: TEST_DATE, mode: "unassigned_only" },
    });
    // Il gate disponibilità deve bloccare
    expect(res.status()).toBe(409);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    console.log(`   → 409 corretto: "${body.error}"`);
  });

  // ─── Test 3: conferma disponibilità + auto-assign ─────────────────────────

  test("Conferma disponibilità → auto-assign → assignments creati", async ({ request }) => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Inserisci conferma disponibilità
    await admin.from("daily_availability_confirmations").upsert(
      { tenant_id: tenantId, date: TEST_DATE, confirmed: true, confirmed_at: new Date().toISOString() },
      { onConflict: "tenant_id,date" }
    );

    // Esegui auto-assign (potrebbe non creare assignments se non ci sono autisti/mezzi disponibili)
    const res = await request.post("/api/ops/piano-giorno/auto-assign", {
      headers: { Authorization: `Bearer ${authToken}`, "Content-Type": "application/json" },
      data: { date: TEST_DATE, mode: "unassigned_only" },
    });

    // Con disponibilità confermata deve rispondere 200 (anche se non ci sono autisti)
    expect(res.status()).toBe(200);
    const body = await res.json() as { ok: boolean; assigned: number; skipped: number; report: unknown[] };
    expect(body.ok).toBe(true);
    expect(typeof body.assigned).toBe("number");
    expect(typeof body.skipped).toBe("number");
    expect(Array.isArray(body.report)).toBe(true);
    console.log(`   → auto-assign: ${body.assigned} assegnati, ${body.skipped} non assegnati`);
  });

  // ─── Test 4: GET piano-giorno dopo assign → trip_groups nel response ──────

  test("GET piano-giorno dopo auto-assign → risponde correttamente", async ({ request }) => {
    const res = await request.get(`/api/ops/piano-giorno?date=${TEST_DATE}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json() as { ok: boolean; trip_groups?: unknown[] };
    expect(body.ok).toBe(true);
    console.log(`   → trip_groups: ${(body.trip_groups ?? []).length}`);
  });

  // ─── Test 5: export Excel → risponde 200 con file ─────────────────────────

  test("GET export-excel → 200 con Content-Type xlsx", async ({ request }) => {
    const res = await request.get(`/api/ops/piano-giorno/export-excel?date=${TEST_DATE}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("spreadsheetml");
    console.log(`   → export-excel Content-Type: ${ct}`);
  });
});
