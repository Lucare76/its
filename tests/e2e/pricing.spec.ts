import { expect, test } from "@playwright/test";

test.describe("Pricing pages smoke", () => {
  test("pricing route richiede login reale", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fpricing/);
    await expect(page.getByRole("heading", { name: "Login Supabase" })).toBeVisible();
  });

  test("margins route richiede login reale", async ({ page }) => {
    await page.goto("/pricing/margins");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fpricing%2Fmargins/);
    await expect(page.getByRole("heading", { name: "Login Supabase" })).toBeVisible();
  });

  test("login non mostra controlli demo legacy", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText("Forza demo locale (bypass Supabase)")).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Invia link magico via email" })).toBeVisible();
  });
});
