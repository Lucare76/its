import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Regressione schema drift (2026-09-13): il job "backup" (JSON legacy)
 * elencava "driver_availability", tabella mai esistita in nessuna migrazione
 * — la tabella canonica e' "driver_daily_availability" (supabase/migrations/
 * 0144_daily_availability.sql). route.ts non esporta TABLES (route handler
 * Next.js, nessun export extra), quindi qui si verifica direttamente il
 * sorgente per evitare di caricare l'intero modulo route (Supabase admin
 * client, ecc.) solo per controllare un array di nomi tabella.
 */
describe("app/api/cron/backup/route.ts — TABLES array", () => {
  const source = readFileSync(join(process.cwd(), "app/api/cron/backup/route.ts"), "utf8");

  it("1. NON contiene piu' 'driver_availability' (tabella mai esistita)", () => {
    expect(source).not.toMatch(/"driver_availability"/);
  });

  it("2. contiene 'driver_daily_availability' (tabella canonica, migrazione 0144)", () => {
    expect(source).toMatch(/"driver_daily_availability"/);
  });
});
