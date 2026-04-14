/**
 * E2E – QR smarcamento servizi al porto
 *
 * Smoke (nessuna credenziale): verifica auth guard sulla pagina /scan/[id]
 *
 * Test completo (richiede env Supabase):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY, PDF_PREVIEW_USER_EMAIL, PDF_PREVIEW_USER_PASSWORD
 *
 * Esecuzione rapida:
 *   pnpm e2e tests/e2e/scan.spec.ts
 *
 * Con app reale:
 *   E2E_REAL_APP=true pnpm e2e tests/e2e/scan.spec.ts
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ─── Env ─────────────────────────────────────────────────────────────────────

function readEnvFile(): Record<string, string> {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const idx = l.indexOf("=");
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, "")];
      })
  );
}

const localEnv = readEnvFile();
const adminEmail    = process.env.PDF_PREVIEW_USER_EMAIL     || localEnv.PDF_PREVIEW_USER_EMAIL     || "";
const adminPassword = process.env.PDF_PREVIEW_USER_PASSWORD  || localEnv.PDF_PREVIEW_USER_PASSWORD  || "";
const supabaseUrl   = process.env.NEXT_PUBLIC_SUPABASE_URL   || localEnv.NEXT_PUBLIC_SUPABASE_URL   || "";
const supabaseAnon  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRole   = process.env.SUPABASE_SERVICE_ROLE_KEY  || localEnv.SUPABASE_SERVICE_ROLE_KEY  || "";

const hasSupabaseEnv = !!(supabaseUrl && supabaseAnon && serviceRole && adminEmail && adminPassword);

// ─── Auth helpers ─────────────────────────────────────────────────────────────

let storageKey   = "";
let storageValue = "";
let e2eSession   = "";

async function openAuthenticated(page: Page, targetPath: string) {
  await page.addInitScript(
    ({ key, val }) => { window.localStorage.setItem(key, val); },
    { key: storageKey, val: storageValue }
  );
  await page.addInitScript(
    ({ val }) => { window.localStorage.setItem("__it_e2e_session", val); },
    { val: e2eSession }
  );
  await page.goto(targetPath);
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
}

// ─── Smoke (nessuna credenziale richiesta) ────────────────────────────────────

test.describe("Scan page – smoke (nessuna auth)", () => {
  test("GET /scan/[id] → redirect al login se non autenticato", async ({ page }) => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    await page.goto(`/scan/${fakeId}`);
    await expect(page).toHaveURL(/\/login/);
  });
});

// ─── Test completo con Supabase reale ─────────────────────────────────────────

test.describe.serial("Scan page – flusso completo", () => {
  test.skip(!hasSupabaseEnv, "Richiede env Supabase complete (NEXT_PUBLIC_SUPABASE_URL ecc.).");

  let testServiceId = "";
  let tenantId      = "";

  test.beforeAll(async () => {
    // 1. Login
    const anon = createClient(supabaseUrl, supabaseAnon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    if (signIn.error || !signIn.data.session) {
      throw new Error(signIn.error?.message ?? "Login E2E fallito");
    }

    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2. Recupera tenant
    const userId = signIn.data.user.id;
    const { data: membership, error: membershipErr } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (membershipErr || !membership?.tenant_id) {
      throw new Error(membershipErr?.message ?? "Membership non trovata");
    }
    tenantId = membership.tenant_id;

    // 3. Recupera un hotel del tenant (necessario per services.hotel_id)
    const { data: hotel, error: hotelErr } = await admin
      .from("hotels")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle();
    if (hotelErr || !hotel?.id) {
      throw new Error(hotelErr?.message ?? "Nessun hotel trovato per il tenant. Crea almeno un hotel prima di eseguire questo test.");
    }

    // 4. Crea servizio di test
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().slice(0, 10);

    const { data: service, error: svcErr } = await admin
      .from("services")
      .insert({
        tenant_id: tenantId,
        is_draft: false,
        status: "assigned",
        direction: "arrival",
        date: dateStr,
        time: "10:00",
        arrival_date: dateStr,
        arrival_time: "10:00",
        customer_name: "Test QR Scan E2E",
        pax: 2,
        vessel: "TEST SNAV",
        phone: "+393471234567",
        notes: "Servizio creato automaticamente dal test E2E",
        hotel_id: hotel.id,
        service_type: "transfer",
      })
      .select("id")
      .single();

    if (svcErr || !service?.id) {
      throw new Error(svcErr?.message ?? "Creazione servizio E2E fallita");
    }
    testServiceId = service.id;

    // 5. Prepara session per Playwright localStorage injection
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0] ?? "local";
    storageKey   = `sb-${projectRef}-auth-token`;
    storageValue = JSON.stringify(signIn.data.session);
    e2eSession   = JSON.stringify({ userId, tenantId, role: membership.role });
  });

  test.afterAll(async () => {
    if (!testServiceId) return;
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Pulizia: elimina scan_log e service creati
    await admin.from("service_scan_log").delete().eq("service_id", testServiceId);
    await admin.from("status_events").delete().eq("service_id", testServiceId);
    await admin.from("services").delete().eq("id", testServiceId).eq("tenant_id", tenantId);
  });

  // ─── Test 1: pagina carica con i dati giusti ────────────────────────────────

  test("mostra i dettagli del servizio", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    // Header direzione
    await expect(page.getByText("ARRIVO · Porto", { exact: false })).toBeVisible({ timeout: 15_000 });

    // Nome cliente
    await expect(page.getByRole("heading", { name: /Test QR Scan E2E/i }).or(
      page.locator("h1", { hasText: "Test QR Scan E2E" })
    )).toBeVisible();

    // Pulsante conferma visibile (servizio non ancora completato)
    await expect(page.getByRole("button", { name: /CONFERMA SERVIZIO COMPLETATO/i })).toBeVisible();
  });

  // ─── Test 2: status badge ───────────────────────────────────────────────────

  test("mostra badge stato 'Assegnato'", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);
    await expect(page.getByText("Assegnato")).toBeVisible({ timeout: 10_000 });
  });

  // ─── Test 3: flusso conferma ────────────────────────────────────────────────

  test("conferma il servizio e mostra banner successo", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    // Attendi pulsante principale
    const confirmBtn = page.getByRole("button", { name: /CONFERMA SERVIZIO COMPLETATO/i });
    await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
    await confirmBtn.click();

    // Modal di conferma
    await expect(page.getByRole("heading", { name: /Confermi il completamento/i })).toBeVisible();
    await expect(page.getByText(/Test QR Scan E2E/)).toBeVisible();

    // Clicca "Sì, conferma"
    await page.getByRole("button", { name: /Sì, conferma/i }).click();

    // Banner successo
    await expect(page.getByText(/Servizio completato/i)).toBeVisible({ timeout: 10_000 });
  });

  // ─── Test 4: doppia scansione ───────────────────────────────────────────────

  test("seconda scansione mostra avviso doppia scansione", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    // Il servizio è già stato marcato completato nel test precedente.
    // Deve mostrare il banner di avvertimento senza mostrare il pulsante conferma.
    await expect(page.getByText(/già marcato come completato/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /CONFERMA/i })).not.toBeVisible();
  });

  // ─── Test 5: verifica scan_log nel DB ──────────────────────────────────────

  test("service_scan_log registra le scansioni correttamente", async () => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: logs, error } = await admin
      .from("service_scan_log")
      .select("action")
      .eq("service_id", testServiceId)
      .order("scanned_at", { ascending: true });

    expect(error).toBeNull();
    expect(logs).not.toBeNull();

    const actions = (logs ?? []).map((l: { action: string }) => l.action);

    // Deve esserci almeno una "view" (dal test 1/2), una "complete" e una "double_complete_attempt"
    expect(actions).toContain("view");
    expect(actions).toContain("complete");
    expect(actions).toContain("double_complete_attempt");
  });

  // ─── Test 6: status nel DB ─────────────────────────────────────────────────

  test("il servizio risulta 'completato' nel DB", async () => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: svc, error } = await admin
      .from("services")
      .select("status")
      .eq("id", testServiceId)
      .single();

    expect(error).toBeNull();
    expect(svc?.status).toBe("completato");
  });

  // ─── Test 7: API GET 404 per servizio inesistente ──────────────────────────

  test("API GET /api/scan/[id] → 404 per id inesistente", async ({ request }) => {
    // Ottieni un token fresco
    const anon = createClient(supabaseUrl, supabaseAnon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    const token = signIn.data.session?.access_token ?? "";

    const fakeId = "00000000-ffff-ffff-ffff-000000000099";
    const res = await request.get(`/api/scan/${fakeId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/non trovato/i);
  });
});
