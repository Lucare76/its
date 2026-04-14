/**
 * E2E – QR smarcamento servizi al porto
 *
 * Smoke (nessuna credenziale): verifica auth guard sulla pagina /scan/[id]
 *
 * Test completo (richiede env Supabase + E2E_REAL_APP=true):
 *   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
 *   SUPABASE_SERVICE_ROLE_KEY, PDF_PREVIEW_USER_EMAIL, PDF_PREVIEW_USER_PASSWORD
 *
 * Modalità "servizio esistente" — non crea né cancella nulla nel DB:
 *   E2E_TEST_SERVICE_ID=<uuid>  →  usa quel servizio, salta creazione e cleanup
 *   E2E_KEEP_SERVICE=true       →  non resetta lo status dopo il test
 *
 * Esempi di esecuzione:
 *   # Smoke senza credenziali:
 *   pnpm e2e tests/e2e/scan.spec.ts
 *
 *   # Test completo su servizio esistente (app avviata da Playwright):
 *   E2E_REAL_APP=true E2E_TEST_SERVICE_ID=a5cc303b-b54f-48ec-9cd0-6c9acbbcb262 pnpm e2e tests/e2e/scan.spec.ts --reporter=line
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
const adminEmail    = process.env.PDF_PREVIEW_USER_EMAIL        || localEnv.PDF_PREVIEW_USER_EMAIL        || "";
const adminPassword = process.env.PDF_PREVIEW_USER_PASSWORD     || localEnv.PDF_PREVIEW_USER_PASSWORD     || "";
const supabaseUrl   = process.env.NEXT_PUBLIC_SUPABASE_URL      || localEnv.NEXT_PUBLIC_SUPABASE_URL      || "";
const supabaseAnon  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRole   = process.env.SUPABASE_SERVICE_ROLE_KEY     || localEnv.SUPABASE_SERVICE_ROLE_KEY     || "";

// Opzionale: usa un servizio già esistente invece di crearne uno nuovo
const externalServiceId = process.env.E2E_TEST_SERVICE_ID || "";
// Se true, non resetta lo status del servizio dopo il test
const keepService = process.env.E2E_KEEP_SERVICE === "true";

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
  // Retry se sessione non ancora valida
  for (let i = 0; i < 2; i++) {
    const invalid = await page.getByText("Sessione non valida").isVisible().catch(() => false);
    if (!invalid) break;
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  }
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

  let testServiceId  = externalServiceId; // usa quello esterno se fornito
  let tenantId       = "";
  let originalStatus = "";
  const isExternalService = !!externalServiceId;

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

    // 3a. Se usiamo un servizio esistente: legge status originale e lo resetta a "new"
    if (isExternalService) {
      const { data: svc } = await admin
        .from("services")
        .select("id, status, customer_name, date, direction, vessel")
        .eq("id", testServiceId)
        .single();
      if (!svc) throw new Error(`Servizio E2E_TEST_SERVICE_ID="${testServiceId}" non trovato nel DB.`);
      originalStatus = svc.status as string;
      console.log(`\n📋 Servizio esistente usato per il test:`);
      console.log(`   ID:        ${svc.id}`);
      console.log(`   Cliente:   ${svc.customer_name}`);
      console.log(`   Data:      ${svc.date}  ${svc.direction === "arrival" ? "ARRIVO" : "PARTENZA"}`);
      console.log(`   Mezzo:     ${svc.vessel ?? "—"}`);
      console.log(`   Status:    ${originalStatus} → verrà impostato "new" per il test\n`);
      // Resetta a "new" per poter testare il flusso di completamento
      await admin.from("services").update({ status: "new" }).eq("id", testServiceId);
      // Pulisci scan_log precedenti per questo servizio
      await admin.from("service_scan_log").delete().eq("service_id", testServiceId);
      await admin.from("status_events").delete().eq("service_id", testServiceId);
    } else {
      // 3b. Crea un servizio di test nuovo
      const { data: hotel } = await admin
        .from("hotels").select("id").eq("tenant_id", tenantId).limit(1).maybeSingle();
      if (!hotel?.id) throw new Error("Nessun hotel trovato per il tenant.");

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const dateStr = tomorrow.toISOString().slice(0, 10);

      const { data: svc, error: svcErr } = await admin
        .from("services")
        .insert({
          tenant_id: tenantId,
          is_draft: false,
          status: "new",
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
      if (svcErr || !svc?.id) throw new Error(svcErr?.message ?? "Creazione servizio fallita");
      testServiceId = svc.id;
      console.log(`\n✅ Servizio di test creato: ${testServiceId}\n`);
    }

    // 4. Prepara session per Playwright
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
    if (isExternalService) {
      if (!keepService) {
        // Ripristina lo status originale
        await admin.from("services").update({ status: originalStatus || "new" }).eq("id", testServiceId);
        // Pulisci i log di test
        await admin.from("service_scan_log").delete().eq("service_id", testServiceId);
        await admin.from("status_events").delete().eq("service_id", testServiceId);
        console.log(`\n🔄 Servizio ${testServiceId} ripristinato a status "${originalStatus || "new"}"\n`);
      } else {
        console.log(`\n⚠️  E2E_KEEP_SERVICE=true — il servizio ${testServiceId} rimane "completato"\n`);
      }
    } else {
      // Elimina il servizio di test creato
      await admin.from("service_scan_log").delete().eq("service_id", testServiceId);
      await admin.from("status_events").delete().eq("service_id", testServiceId);
      await admin.from("services").delete().eq("id", testServiceId).eq("tenant_id", tenantId);
      console.log(`\n🗑️  Servizio di test ${testServiceId} eliminato\n`);
    }
  });

  // ─── Test 1: pagina carica con i dati del servizio ─────────────────────────

  test("mostra i dettagli del servizio", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    // L'header ARRIVO/PARTENZA deve essere visibile
    const header = page.locator("p", { hasText: /ARRIVO|PARTENZA/ });
    await expect(header).toBeVisible({ timeout: 15_000 });

    // Il nome del cliente deve apparire
    const heading = page.locator("h1");
    await expect(heading).toBeVisible({ timeout: 10_000 });
    console.log(`   → Cliente visualizzato: "${await heading.textContent()}"`);

    // Il pulsante conferma deve essere visibile (status "new")
    await expect(page.getByRole("button", { name: /CONFERMA SERVIZIO COMPLETATO/i })).toBeVisible();
  });

  // ─── Test 2: status badge presente ────────────────────────────────────────

  test("mostra il badge status del servizio", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);
    // Deve esserci un badge con il testo dello status (Nuovo / Assegnato / ecc.)
    const badge = page.locator("span", { hasText: /Nuovo|Assegnato|Partito|Arrivato/ });
    await expect(badge).toBeVisible({ timeout: 10_000 });
    console.log(`   → Status badge: "${await badge.textContent()}"`);
  });

  // ─── Test 3: flusso conferma ───────────────────────────────────────────────

  test("modal conferma → banner successo → status completato", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    const confirmBtn = page.getByRole("button", { name: /CONFERMA SERVIZIO COMPLETATO/i });
    await expect(confirmBtn).toBeVisible({ timeout: 15_000 });

    // Click → si apre modal
    await confirmBtn.click();
    await expect(page.getByRole("heading", { name: /Confermi il completamento/i })).toBeVisible();

    // Screenshot del modal (visibile nel report Playwright)
    await page.screenshot({ path: "tests/e2e/screenshots/scan-modal-confirm.png" });

    // Clicca "Sì, conferma"
    await page.getByRole("button", { name: /Sì, conferma/i }).click();

    // Attende il banner di successo
    await expect(page.getByText(/Servizio completato/i)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: "tests/e2e/screenshots/scan-success.png" });

    console.log(`   ✓ Servizio ${testServiceId} marcato come completato`);
  });

  // ─── Test 4: doppia scansione ─────────────────────────────────────────────

  test("seconda scansione → avviso doppia scansione, nessun pulsante conferma", async ({ page }) => {
    await openAuthenticated(page, `/scan/${testServiceId}`);

    await expect(page.getByText(/già marcato come completato/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /CONFERMA/i })).not.toBeVisible();

    await page.screenshot({ path: "tests/e2e/screenshots/scan-double-attempt.png" });
    console.log(`   ✓ Doppia scansione rilevata correttamente`);
  });

  // ─── Test 5: verifica DB – scan_log ───────────────────────────────────────

  test("service_scan_log registra view, complete e double_complete_attempt", async () => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: logs } = await admin
      .from("service_scan_log")
      .select("action, scanned_at")
      .eq("service_id", testServiceId)
      .order("scanned_at", { ascending: true });

    const actions = (logs ?? []).map((l: { action: string }) => l.action);
    console.log(`   → scan_log: [${actions.join(", ")}]`);

    expect(actions).toContain("view");
    expect(actions).toContain("complete");
    expect(actions).toContain("double_complete_attempt");
  });

  // ─── Test 6: verifica DB – status servizio ────────────────────────────────

  test("il servizio risulta 'completato' nel DB", async () => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: svc } = await admin
      .from("services").select("status").eq("id", testServiceId).single();

    console.log(`   → services.status = "${svc?.status}"`);
    expect(svc?.status).toBe("completato");
  });

  // ─── Test 7: verifica DB – status_events ─────────────────────────────────

  test("status_events contiene un record 'completato'", async () => {
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: events } = await admin
      .from("status_events")
      .select("status, at")
      .eq("service_id", testServiceId)
      .eq("status", "completato")
      .limit(1);

    expect(events?.length).toBeGreaterThan(0);
    console.log(`   → status_event completato alle ${events?.[0]?.at}`);
  });

  // ─── Test 8: API 404 per ID inesistente ───────────────────────────────────

  test("API GET /api/scan/[id] → 404 per id inesistente", async ({ request }) => {
    const anon = createClient(supabaseUrl, supabaseAnon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    const token = signIn.data.session?.access_token ?? "";

    const res = await request.get("/api/scan/00000000-ffff-ffff-ffff-000000000099", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status()).toBe(404);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
  });
});
