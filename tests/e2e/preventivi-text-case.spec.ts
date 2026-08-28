import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

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

const localEnv = readEnvFile();
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || localEnv.NEXT_PUBLIC_SUPABASE_URL || "";
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || localEnv.SUPABASE_SERVICE_ROLE_KEY || "";
const email = process.env.PDF_PREVIEW_USER_EMAIL || localEnv.PDF_PREVIEW_USER_EMAIL || "";
const password = process.env.PDF_PREVIEW_USER_PASSWORD || localEnv.PDF_PREVIEW_USER_PASSWORD || "";

let storageKey = "";
let storageValue = "";
let e2eSession = "";
let authToken = "";
let createdQuoteId = "";

async function openAuthenticated(page: Page, targetPath: string) {
  await page.addInitScript(
    ({ key, session, appSession }) => {
      window.localStorage.setItem(key, session);
      window.localStorage.setItem("__it_e2e_session", appSession);
    },
    { key: storageKey, session: storageValue, appSession: e2eSession },
  );
  await page.goto(targetPath);
  await page.waitForURL((url) => url.pathname === targetPath, { timeout: 30_000 });
}

function fieldInput(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator("..").locator("input, textarea").first();
}

async function dismissMotivation(page: Page) {
  const modal = page.locator("div.fixed.inset-0.z-50");
  if (await modal.isVisible().catch(() => false)) {
    await modal.locator("button").first().click();
    await expect(modal).toBeHidden();
  }
}

test.describe("Preventivi conserva maiuscole e minuscole", () => {
  test.skip(
    !supabaseUrl || !anonKey || !serviceRole || !email || !password,
    "Richiede le credenziali real-app configurate in .env.local.",
  );

  test.beforeAll(async () => {
    const anon = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) {
      throw new Error(signIn.error?.message ?? "Login E2E preventivi fallito.");
    }

    const userId = signIn.data.session.user.id;
    authToken = signIn.data.session.access_token;
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const membershipResult = await admin
      .from("memberships")
      .select("tenant_id,role")
      .eq("user_id", userId)
      .limit(1)
      .single();
    if (membershipResult.error || !membershipResult.data) {
      throw new Error(membershipResult.error?.message ?? "Membership E2E non disponibile.");
    }

    const projectRef = new URL(supabaseUrl).hostname.split(".")[0] ?? "local";
    storageKey = `sb-${projectRef}-auth-token`;
    storageValue = JSON.stringify(signIn.data.session);
    e2eSession = JSON.stringify({
      userId,
      tenantId: membershipResult.data.tenant_id,
      role: membershipResult.data.role,
    });
  });

  test.afterAll(async () => {
    if (!createdQuoteId) return;
    const admin = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    await admin.from("service_quote_items").delete().eq("quote_id", createdQuoteId);
    await admin.from("service_quotes").delete().eq("id", createdQuoteId);
  });

  test("computed style, digitazione, salvataggio e riapertura", async ({ page }) => {
    test.setTimeout(180_000);
    await openAuthenticated(page, "/preventivi/new");
    await dismissMotivation(page);

    const name = fieldInput(page, "Nome *");
    const surname = fieldInput(page, "Cognome *");
    const hotel = fieldInput(page, "Hotel");
    const address = fieldInput(page, "Indirizzo hotel");
    const requests = fieldInput(page, "Richieste speciali");
    const emailInput = fieldInput(page, "Email *");

    await expect(name).toBeVisible();
    const beforeComputed = await name.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        textTransform: style.textTransform,
        fontVariantCaps: style.fontVariantCaps,
        className: element.className,
        parentClasses: Array.from(element.parentElement?.parentElement?.classList ?? []),
      };
    });
    console.log("PREVENTIVI_COMPUTED_BEFORE", JSON.stringify(beforeComputed));

    await name.fill("Mario");
    await surname.fill("Rossi");
    await hotel.fill("Hotel Terme President");
    await address.fill("Via Roma 10");
    await requests.fill("Cliente chiede camera vista mare e arrivo anticipato.");
    await emailInput.fill("Mario.Rossi@gmail.com");

    await expect(name).toHaveValue("Mario");
    await expect(surname).toHaveValue("Rossi");
    await expect(hotel).toHaveValue("Hotel Terme President");
    await expect(address).toHaveValue("Via Roma 10");
    await expect(requests).toHaveValue("Cliente chiede camera vista mare e arrivo anticipato.");
    await expect(emailInput).toHaveValue("Mario.Rossi@gmail.com");

    const afterComputed = await name.evaluate((element) => {
      const style = window.getComputedStyle(element);
      return {
        textTransform: style.textTransform,
        fontVariantCaps: style.fontVariantCaps,
        value: (element as HTMLInputElement).value,
      };
    });
    console.log("PREVENTIVI_COMPUTED_AFTER", JSON.stringify(afterComputed));
    await page.screenshot({ path: "tests/e2e/screenshots/preventivi-text-case-typed.png", fullPage: true });

    await fieldInput(page, "Prezzo per persona (€) *").fill("10");
    await dismissMotivation(page);
    await page.getByRole("button", { name: "Crea preventivo" }).click();
    await page.waitForURL(/\/preventivi\/[0-9a-f-]+$/, { timeout: 30_000 });
    createdQuoteId = new URL(page.url()).pathname.split("/").pop() ?? "";

    await page.getByRole("button", { name: /Modifica/ }).click();
    await expect(fieldInput(page, "Nome *")).toHaveValue("Mario");
    await expect(fieldInput(page, "Cognome *")).toHaveValue("Rossi");
    await expect(fieldInput(page, "Hotel")).toHaveValue("Hotel Terme President");
    await expect(fieldInput(page, "Indirizzo hotel")).toHaveValue("Via Roma 10");
    await expect(fieldInput(page, "Richieste speciali")).toHaveValue("Cliente chiede camera vista mare e arrivo anticipato.");
    await expect(fieldInput(page, "Email *")).toHaveValue("Mario.Rossi@gmail.com");
    await page.screenshot({ path: "tests/e2e/screenshots/preventivi-text-case-reopened.png", fullPage: true });

    const response = await page.request.get(`/api/ops/service-quotes/${createdQuoteId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.ok()).toBe(true);
    const body = await response.json() as {
      quote: {
        customer_first_name: string;
        customer_last_name: string;
        customer_email: string;
        hotel_name: string;
        hotel_address: string;
        special_requests: string;
      };
    };
    expect(body.quote.customer_first_name).toBe("Mario");
    expect(body.quote.customer_last_name).toBe("Rossi");
    expect(body.quote.customer_email).toBe("Mario.Rossi@gmail.com");
    expect(body.quote.hotel_name).toBe("Hotel Terme President");
    expect(body.quote.hotel_address).toBe("Via Roma 10");
    expect(body.quote.special_requests).toBe("Cliente chiede camera vista mare e arrivo anticipato.");
  });
});
