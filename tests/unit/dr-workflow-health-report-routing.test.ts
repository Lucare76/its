import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * FIX MIRATO — routing del health ping DR V4 (storage-backup).
 *
 * Causa reale del gap "storage-backup assente da system_job_runs": sia
 * postgres-backup.yml sia storage-backup.yml leggevano lo STESSO secret
 * GitHub `DR_HEALTH_REPORT_URL` (un secret ha un solo valore per nome,
 * condiviso da tutti i workflow che lo referenziano) — il valore era gia'
 * occupato dall'URL di postgres-backup-report, quindi il ping di
 * storage-backup finiva silenziosamente su quell'endpoint, registrato come
 * job_key="postgres-backup" con conteggi a zero, invece che come
 * job_key="storage-backup".
 *
 * Fix: storage-backup.yml ora usa un secret DEDICATO
 * (STORAGE_HEALTH_REPORT_URL) per la stessa variabile d'ambiente
 * DR_HEALTH_REPORT_URL che scripts/storage-backup.mjs gia' leggeva (nessuna
 * modifica allo script). postgres-backup.yml resta invariato.
 *
 * Questo file blocca una regressione futura: se qualcuno reintroducesse
 * `secrets.DR_HEALTH_REPORT_URL` in storage-backup.yml, il test fallisce.
 */

const storageWorkflow = readFileSync(
  join(process.cwd(), ".github/workflows/storage-backup.yml"),
  "utf8"
);
const postgresWorkflow = readFileSync(
  join(process.cwd(), ".github/workflows/postgres-backup.yml"),
  "utf8"
);

describe("storage-backup.yml — health report URL su secret dedicato (mai condiviso con postgres-backup)", () => {
  it("usa secrets.STORAGE_HEALTH_REPORT_URL per la env DR_HEALTH_REPORT_URL letta dallo script", () => {
    expect(storageWorkflow).toMatch(/DR_HEALTH_REPORT_URL:\s*\$\{\{\s*secrets\.STORAGE_HEALTH_REPORT_URL\s*\}\}/);
  });

  it("NON usa piu' secrets.DR_HEALTH_REPORT_URL (la causa del bug: stesso nome del secret di postgres-backup)", () => {
    expect(storageWorkflow).not.toMatch(/DR_HEALTH_REPORT_URL:\s*\$\{\{\s*secrets\.DR_HEALTH_REPORT_URL\s*\}\}/);
  });

  it("il bearer DR_HEALTH_REPORT_SECRET resta condiviso (e' un token di autenticazione, non una destinazione)", () => {
    expect(storageWorkflow).toMatch(/DR_HEALTH_REPORT_SECRET:\s*\$\{\{\s*secrets\.DR_HEALTH_REPORT_SECRET\s*\}\}/);
  });
});

describe("postgres-backup.yml — invariato (nessun impatto sul backup PostgreSQL)", () => {
  it("continua a usare secrets.DR_HEALTH_REPORT_URL, esattamente come prima del fix", () => {
    expect(postgresWorkflow).toMatch(/DR_HEALTH_REPORT_URL:\s*\$\{\{\s*secrets\.DR_HEALTH_REPORT_URL\s*\}\}/);
  });

  it("nessuna riga R2/DB del backup PostgreSQL e' stata toccata (env identiche)", () => {
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT", "SUPABASE_DB_URL"]) {
      expect(postgresWorkflow).toMatch(new RegExp(`${key}: \\$\\{\\{ secrets\\.${key} \\}\\}`));
    }
  });
});

describe("storage-backup.yml — nessuna modifica alla logica R2/manifest/retention/bucket (solo il routing del ping e' cambiato)", () => {
  it("cron schedule, comando script ed env R2 restano identici", () => {
    expect(storageWorkflow).toMatch(/cron:\s*"0 3 \* \* \*"/);
    expect(storageWorkflow).toMatch(/pnpm exec tsx scripts\/storage-backup\.mjs/);
    for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_ENDPOINT", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(storageWorkflow).toMatch(new RegExp(`${key}: \\$\\{\\{ secrets\\.${key} \\}\\}`));
    }
  });

  it("scripts/storage-backup.mjs non e' stato modificato: legge ancora la stessa env DR_HEALTH_REPORT_URL", () => {
    const script = readFileSync(join(process.cwd(), "scripts/storage-backup.mjs"), "utf8");
    // Il fix cambia SOLO quale secret GitHub Actions valorizza questa env,
    // mai il codice dello script che la consuma.
    expect(script).toMatch(/process\.env\.DR_HEALTH_REPORT_URL/);
  });
});
