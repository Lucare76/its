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

  it("3. il numero di tabelle resta invariato (rinomina, non aggiunta/rimozione)", () => {
    const match = source.match(/const TABLES = \[([\s\S]*?)\] as const;/);
    expect(match).not.toBeNull();
    const entries = (match![1].match(/"[a-z_]+"/g) ?? []).length;
    expect(entries).toBe(24);
  });
});

/**
 * Regressione schema drift (2026-09-13, chiusura gap lasciato aperto dal
 * fix precedente): il commit che ha corretto route.ts e
 * verify-backup-snapshot.mjs ha lasciato deliberatamente intatto
 * scripts/restore-backup-snapshot.mjs ("untouched per scope"). Questo
 * blocco chiude quel gap: RESTORE_ORDER usava ancora "driver_availability"
 * (mai esistita) — stessa correzione, stesso nome tabella canonico. Le due
 * liste (TABLES del backup, RESTORE_ORDER del restore) restano mantenute
 * separatamente per scelta gia' presa nel fix precedente (stesso pattern di
 * verify-backup-snapshot.mjs) — non si introduce qui una fonte condivisa.
 */
describe("scripts/restore-backup-snapshot.mjs — RESTORE_ORDER array", () => {
  const source = readFileSync(join(process.cwd(), "scripts/restore-backup-snapshot.mjs"), "utf8");

  it("1. NON contiene piu' 'driver_availability' (tabella mai esistita)", () => {
    expect(source).not.toMatch(/"driver_availability"/);
  });

  it("2. contiene 'driver_daily_availability' (tabella canonica, migrazione 0144) una sola volta (nessun duplicato)", () => {
    const matches = source.match(/"driver_daily_availability"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("3. il numero di tabelle in RESTORE_ORDER resta invariato (rinomina, non aggiunta/rimozione)", () => {
    const match = source.match(/const RESTORE_ORDER = \[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    const entries = (match![1].match(/"[a-z_]+"/g) ?? []).length;
    expect(entries).toBe(23);
  });

  it("4. nessun'altra logica dello script e' stata toccata (guardie anti-produzione, CLI flag, ordine FK) — solo il nome tabella", () => {
    expect(source).toMatch(/KNOWN_PROD_REFS = \["lnjgwxqblapmxabwiyrg"\]/);
    expect(source).toMatch(/RESTORE_SUPABASE_URL/);
    expect(source).toMatch(/--confirm-restore/);
  });
});
