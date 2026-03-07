import { expect, test, type Page } from "@playwright/test";

function uniqueLabel(prefix: string) {
  return `${prefix}-${Date.now()}`;
}

async function loginAs(page: Page, role: "admin" | "operator" | "driver" | "agency") {
  const redirectTarget = role === "driver" ? "/driver" : role === "agency" ? "/agency" : "/dashboard";
  await page.goto(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
  await page.selectOption("select", role);
  await page.fill('input[type="email"]', `${role}@demo.com`);
  await page.fill('input[type="password"]', "demo-password");
  await page.getByRole("button", { name: "Accedi" }).click();
}

test.describe("Smoke e2e", () => {
  test("login -> create service -> assign driver -> driver status -> export", async ({ page }) => {
    const customerName = uniqueLabel("E2E Cliente");

    await loginAs(page, "operator");
    await expect(page).toHaveURL(/\/dashboard$/);

    await page.goto("/services/new");
    await page.fill('input[name="customer_name"]', customerName);
    await page.fill('input[name="phone"]', "+390000000001");
    await page.getByRole("button", { name: "Conferma prenotazione" }).click();
    await expect(page.getByText("Prenotazione creata. Stato iniziale: Da assegnare.")).toBeVisible();

    await page.goto("/dispatch");
    const serviceOption = page.locator("select[name='service_id'] option", { hasText: customerName });
    await expect(serviceOption).toHaveCount(1);
    const serviceId = await serviceOption.first().getAttribute("value");
    expect(serviceId).toBeTruthy();
    await page.selectOption("select[name='service_id']", serviceId as string);
    await page.selectOption("select[name='driver_user_id']", { label: "Giovanni Esposito" });
    await page.getByRole("button", { name: "Conferma assegnazione" }).click();
    await expect(page.getByText("Assegnazione salvata.")).toBeVisible();

    await loginAs(page, "driver");
    await expect(page).toHaveURL(/\/driver$/);
    await page.goto("/driver");
    const serviceButton = page.getByRole("button", { name: new RegExp(customerName) });
    if (await serviceButton.count()) {
      await serviceButton.first().click();
    }
    await page.getByRole("button", { name: "Problema", exact: true }).first().click();
    await expect(page.locator("article .status-badge-problema").first()).toBeVisible();

    await loginAs(page, "operator");
    await page.goto("/dashboard");
    await page.getByRole("button", { name: "Export" }).first().click();
    await page.getByRole("button", { name: "Download .xlsx" }).first().click();
    await expect(page.getByText("Export disponibile solo con Supabase configurato.")).toBeVisible();
  });
});
