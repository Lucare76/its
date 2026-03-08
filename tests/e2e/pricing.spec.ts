import { expect, test, type Page } from "@playwright/test";

async function loginAs(page: Page, role: "admin" | "operator") {
  const redirectTarget = "/pricing";
  await page.goto(`/login?redirect=${encodeURIComponent(redirectTarget)}`);
  await page.selectOption("select", role);
  await page.fill('input[type="email"]', `${role}@demo.com`);
  await page.fill('input[type="password"]', "demo-password");
  await page.getByRole("button", { name: "Accedi" }).click();
}

test.describe("Pricing pages smoke", () => {
  test("operator can open pricing and margins pages", async ({ page }) => {
    await loginAs(page, "operator");
    await expect(page).toHaveURL(/\/pricing$/);
    await expect(page.getByRole("heading", { name: "Tariffe e Margini" })).toBeVisible();

    await page.goto("/pricing/margins");
    await expect(page.getByRole("heading", { name: "KPI Margini" })).toBeVisible();
  });
});

