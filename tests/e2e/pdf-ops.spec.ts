import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

type PreparedDraft = {
  inbound_email_id: string;
  draft_service_id: string;
  external_reference: string;
  import_state: string;
};

function readEnvFile() {
  const envPath = path.resolve(".env.local");
  if (!fs.existsSync(envPath)) return {} as Record<string, string>;
  return Object.fromEntries(
    fs
      .readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const idx = line.indexOf("=");
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^"|"$/g, "")];
      })
  );
}

const localEnv = readEnvFile();
const adminEmail = process.env.PDF_PREVIEW_USER_EMAIL || localEnv.PDF_PREVIEW_USER_EMAIL || "admin@demo.com";
const adminPassword = process.env.PDF_PREVIEW_USER_PASSWORD || localEnv.PDF_PREVIEW_USER_PASSWORD || "demo123";
const inferredPort = process.env.E2E_PORT || "3010";
const baseURL = process.env.E2E_BASE_URL || `http://127.0.0.1:${inferredPort}`;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY || "";

let preparedDraft: PreparedDraft | null = null;
let storageKey = "";
let storageValue = "";
let e2eSessionValue = "";
let uploadPdfPath = "";

async function openWithSupabaseSession(page: Page, targetPath: string) {
  await page.addInitScript(
    ({ value }) => {
      window.localStorage.setItem("__it_e2e_session", value);
    },
    { value: e2eSessionValue }
  );
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value);
    },
    { key: storageKey, value: storageValue }
  );
  await page.goto(targetPath);
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sessionInvalid = await page.getByText("Sessione non valida. Rifai login.").isVisible().catch(() => false);
    const tenantMissing = await page.getByText("Tenant non configurato per questo utente. Completa onboarding.").isVisible().catch(() => false);
    if (!sessionInvalid && !tenantMissing) break;
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForURL((url) => url.pathname === targetPath, { timeout: 20_000 });
  }
}

test.describe.serial("PDF ops UI", () => {
  test.skip(!baseURL || !supabaseUrl || !supabaseAnonKey || !serviceRoleKey, "Richiede env Supabase complete.");

  test.beforeAll(async () => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const signIn = await supabase.auth.signInWithPassword({ email: adminEmail, password: adminPassword });
    if (signIn.error || !signIn.data.session) {
      throw new Error(signIn.error?.message ?? "Login Supabase E2E fallito");
    }
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const userId = signIn.data.user?.id;
    if (!userId) {
      throw new Error("User id E2E non disponibile.");
    }
    const membershipResult = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    const tenantId = membershipResult.data?.tenant_id;
    const role = membershipResult.data?.role;
    if (membershipResult.error || !tenantId || !role) {
      throw new Error(membershipResult.error?.message ?? "Membership E2E non disponibile");
    }
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0] || "local";
    storageKey = `sb-${projectRef}-auth-token`;
    storageValue = JSON.stringify(signIn.data.session);
    e2eSessionValue = JSON.stringify({ userId, tenantId, role });

    const stdout = execFileSync("node", ["scripts/prepare-pdf-e2e-draft.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_APP_URL: baseURL
      }
    });
    preparedDraft = JSON.parse(stdout.trim()) as PreparedDraft;

    const uploadPdfPractice = `E2E-UPLOAD-${String(Date.now()).slice(-6)}`;
    uploadPdfPath = path.resolve(`samples/review-test-e2e-${Date.now()}.pdf`);
    execFileSync("node", ["scripts/generate-synthetic-agency-pdf.mjs", uploadPdfPractice, uploadPdfPath], {
      encoding: "utf8",
      env: process.env
    });
  });

  test("upload da /pdf-imports", async ({ page }) => {
    if (!uploadPdfPath) throw new Error("PDF upload E2E non preparato.");

    await openWithSupabaseSession(page, "/pdf-imports");
    await expect(page.getByTestId("pdf-imports-page")).toBeVisible();

    await page.getByTestId("pdf-upload-input").setInputFiles(uploadPdfPath);
    await expect(page.getByTestId("pdf-upload-status")).toContainText("File selezionato");

    await page.getByTestId("pdf-upload-preview").click();
    await expect(page.getByTestId("pdf-upload-status")).toContainText("Anteprima parser pronta.", { timeout: 90_000 });

    await page.getByTestId("pdf-upload-draft").click();
    await expect(page.getByTestId("pdf-upload-status")).toContainText(/Draft creato|Duplicato rilevato/, { timeout: 90_000 });
  });

  test("ignore da /pdf-imports", async ({ page }) => {
    const stdout = execFileSync("node", ["scripts/prepare-pdf-e2e-draft.mjs"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NEXT_PUBLIC_APP_URL: baseURL
      }
    });
    const draftToIgnore = JSON.parse(stdout.trim()) as PreparedDraft;

    await openWithSupabaseSession(page, "/pdf-imports");
    await expect(page.getByTestId("pdf-imports-page")).toBeVisible();

    await page.getByTestId("pdf-imports-search").fill(draftToIgnore.inbound_email_id);
    const row = page.getByTestId(`pdf-import-row-${draftToIgnore.inbound_email_id}`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    await expect(page.getByTestId("pdf-import-status-badge")).toContainText("Draft");
    await page.getByTestId("pdf-ignore-import").click();
    await expect(page.getByTestId("pdf-import-status-badge")).toContainText("Scartato", { timeout: 30_000 });
  });

  test("review/edit e conferma finale da /pdf-imports", async ({ page }) => {
    if (!preparedDraft) throw new Error("Draft PDF E2E non preparato.");

    await openWithSupabaseSession(page, "/pdf-imports");
    await expect(page.getByTestId("pdf-imports-page")).toBeVisible();

    await page.getByTestId("pdf-imports-search").fill(preparedDraft.inbound_email_id);
    const row = page.getByTestId(`pdf-import-row-${preparedDraft.inbound_email_id}`);
    await expect(row).toBeVisible();
    await row.click();

    await expect(page.getByTestId("pdf-import-status-badge")).toContainText("Draft");
    await page.getByTestId("pdf-review-field-notes").click();
    await page.getByTestId("pdf-review-field-notes").fill("Review salvata da Playwright");
    await expect(page.getByTestId("pdf-review-field-notes")).toHaveValue("Review salvata da Playwright");

    await page.getByTestId("pdf-review-save").click();
    await expect(page.getByText("Review salvata:")).toBeVisible();

    await page.getByTestId("pdf-confirm-import").click();
    await expect(page.getByTestId("pdf-import-status-badge")).toContainText("Confermato");
    await expect(page.getByText("Review manuale", { exact: true })).toBeVisible();
  });

  test("booking PDF confermato visibile e filtrabile in /dispatch", async ({ page }) => {
    if (!preparedDraft?.external_reference) throw new Error("Riferimento draft non disponibile.");

    await openWithSupabaseSession(page, "/dispatch");
    await expect(page.getByTestId("dispatch-source-filter")).toBeVisible({ timeout: 30_000 });

    await page.getByTestId("dispatch-source-filter").selectOption("pdf");
    await page.getByTestId("dispatch-review-filter").selectOption("yes");

    const option = page
      .locator('[data-testid="dispatch-service-select"] option')
      .filter({ hasText: preparedDraft.external_reference })
      .first();
    await expect(option).toHaveCount(1, { timeout: 30_000 });
    const optionValue = await option.getAttribute("value");
    if (!optionValue) throw new Error("Option value dispatch non trovato.");

    await page.getByTestId("dispatch-service-select").selectOption(optionValue);
    await expect(page.getByTestId("dispatch-priority-panel")).toBeVisible();
    await expect(page.getByTestId("dispatch-priority-badge-pdf")).toContainText("PDF");
    await expect(page.getByTestId("dispatch-priority-badge-reviewed")).toContainText("Reviewed");
    await expect(page.getByTestId("dispatch-priority-external-ref")).toContainText(preparedDraft.external_reference);
  });
});
