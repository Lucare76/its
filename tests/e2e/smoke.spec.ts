import { expect, test } from "@playwright/test";

test.describe("Smoke e2e", () => {
  test("auth guard e login production-only senza fallback demo", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?redirect=%2Fdashboard/);

    await expect(page.getByRole("heading", { name: "Login Supabase" })).toBeVisible();
    await expect(page.getByTestId("login-email")).toBeVisible();
    await expect(page.getByTestId("login-password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accedi all'area riservata" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Invia link magico via email" })).toBeVisible();
    await expect(page.getByText("Forza demo locale (bypass Supabase)")).toHaveCount(0);
  });
});
