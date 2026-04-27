import { expect, test } from "@playwright/test";

test.describe("Scan page smoke", () => {
  test("GET /scan/[id] -> redirect al login se non autenticato", async ({ page }) => {
    const fakeId = "00000000-0000-0000-0000-000000000001";
    await page.goto(`/scan/${fakeId}`);
    await expect(page).toHaveURL(/\/login/);
  });
});
