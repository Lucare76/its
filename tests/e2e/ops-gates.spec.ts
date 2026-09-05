import { expect, test } from "@playwright/test";

const PROTECTED_PAGES = [
  "/piano-giorno",
  "/dispatch",
  "/disponibilita",
  "/arrivals",
  "/departures",
  "/liste-bruno",
  "/crm-agencies",
  "/pricing",
  "/medmar-ar",
];

test.describe("Operational pages — auth gates", () => {
  for (const path of PROTECTED_PAGES) {
    test(`${path} → redirect a /login se non autenticato`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("heading", { name: "Accesso riservato" })).toBeVisible();
    });
  }
});

test.describe("API routes — 401 senza token", () => {
  test("GET /api/services/list → 401", async ({ request }) => {
    const res = await request.get("/api/services/list");
    expect(res.status()).toBe(401);
  });

  test("GET /api/ops/piano-giorno → 401", async ({ request }) => {
    const res = await request.get("/api/ops/piano-giorno?date=2026-06-15");
    expect(res.status()).toBe(401);
  });

  test("POST /api/ops/piano-giorno/auto-assign → 401", async ({ request }) => {
    const res = await request.post("/api/ops/piano-giorno/auto-assign", {
      data: { date: "2026-06-15", mode: "unassigned_only" },
    });
    expect(res.status()).toBe(401);
  });
});
