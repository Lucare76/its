import { expect, test } from "@playwright/test";

test.describe("Smoke e2e", () => {
  test("auth guard e login production-only senza fallback demo", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard/);

    await expect(page.getByRole("heading", { name: "Login Supabase" })).toBeVisible();
    await page.fill('input[type="email"]', "operator@example.com");
    await page.fill('input[type="password"]', "wrong-password");
    await page.getByRole("button", { name: "Accedi" }).click();

    await expect(page.getByText(/Supabase non configurato: login non disponibile.|Login non riuscito:/)).toBeVisible();
    await expect(page.getByText("Forza demo locale (bypass Supabase)")).toHaveCount(0);
  });
});
