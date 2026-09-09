import { describe, expect, it } from "vitest";
import {
  RESTORE_DRILL_CONFIRM_VALUE,
  RESTORE_DRILL_KNOWN_PROD_REFS,
  assertRestoreTargetIsSafe,
  filterOutPublicSchemaCreation,
  parseProjectRefFromPoolerUsername,
  reorderAuthRestoreList,
} from "@/lib/server/postgres-restore-drill";

const PROD_REF = "lnjgwxqblapmxabwiyrg";
const PROD_DSN = `postgresql://postgres.${PROD_REF}:secret@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`;
const TEST_DSN = "postgresql://postgres.abcdtestref123:secret2@aws-0-eu-central-1.pooler.supabase.com:5432/postgres";

describe("postgres-restore-drill — guardie anti-produzione", () => {
  describe("parseProjectRefFromPoolerUsername", () => {
    it("estrae il project-ref dallo username postgres.<ref>", () => {
      expect(parseProjectRefFromPoolerUsername(PROD_DSN)).toBe(PROD_REF);
    });
    it("null su URI senza username Session Pooler", () => {
      expect(parseProjectRefFromPoolerUsername("postgresql://postgres:pwd@db.example.supabase.co:5432/postgres")).toBeNull();
    });
    it("null su input vuoto/non parsabile", () => {
      expect(parseProjectRefFromPoolerUsername(null)).toBeNull();
      expect(parseProjectRefFromPoolerUsername("")).toBeNull();
      expect(parseProjectRefFromPoolerUsername("non-una-url")).toBeNull();
    });
  });

  describe("assertRestoreTargetIsSafe", () => {
    it("ABORT: il project-ref di produzione noto compare nel target", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: PROD_DSN,
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
      expect(res.reasons.some((r) => r.includes(PROD_REF))).toBe(true);
      expect(RESTORE_DRILL_KNOWN_PROD_REFS).toContain(PROD_REF);
    });

    it("ABORT: target identico a SUPABASE_DB_URL", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: TEST_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("ABORT: stesso project-ref di produzione anche con host/password diversi", () => {
      const sameRefDifferentHost = `postgresql://postgres.${PROD_REF}:altrapwd@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
      const res = assertRestoreTargetIsSafe({
        targetDsn: sameRefDifferentHost,
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("ABORT: RESTORE_TARGET_CONFIRM mancante per un'esecuzione non dry-run", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: PROD_DSN,
        confirmEnvValue: undefined,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
      expect(res.reasons.some((r) => r.includes("RESTORE_TARGET_CONFIRM"))).toBe(true);
    });

    it("ABORT: RESTORE_TARGET_CONFIRM con valore errato", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: PROD_DSN,
        confirmEnvValue: "yes-please",
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("ABORT: RESTORE_TARGET_DB_URL mancante", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: "",
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("ABORT: URI non postgres://", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: "mysql://user:pwd@host:3306/db",
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("OK: target di test distinto, confirm corretta, requireConfirm true", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(true);
      expect(res.reasons).toEqual([]);
    });

    it("OK: dry-run (requireConfirm=false) non richiede RESTORE_TARGET_CONFIRM", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: PROD_DSN,
        confirmEnvValue: undefined,
        requireConfirm: false,
      });
      expect(res.safe).toBe(true);
    });

    it("ABORT (fail-closed): prodDsn presente ma target senza forma Session Pooler riconoscibile", () => {
      const res = assertRestoreTargetIsSafe({
        targetDsn: "postgresql://postgres:pwd@db.sometestproject.supabase.co:5432/postgres",
        prodDsn: PROD_DSN,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(res.safe).toBe(false);
    });

    it("nessun prodDsn disponibile: il confronto e' saltato, ma il project-ref noto resta bloccato", () => {
      const safeCase = assertRestoreTargetIsSafe({
        targetDsn: TEST_DSN,
        prodDsn: undefined,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(safeCase.safe).toBe(true);

      const blockedCase = assertRestoreTargetIsSafe({
        targetDsn: PROD_DSN,
        prodDsn: undefined,
        confirmEnvValue: RESTORE_DRILL_CONFIRM_VALUE,
        requireConfirm: true,
      });
      expect(blockedCase.safe).toBe(false);
    });
  });
});

describe("postgres-restore-drill — riordino AUTH per dipendenze FK", () => {
  const rawToc = [
    ";",
    "; Archive created at 2026-09-09 13:39:00 UTC",
    ";",
    "216; 1259 16820 TABLE DATA auth identities postgres",
    "217; 1259 16821 TABLE DATA auth mfa_amr_claims postgres",
    "218; 1259 16822 TABLE DATA auth mfa_factors postgres",
    "219; 1259 16823 TABLE DATA auth users postgres",
  ].join("\n");

  it("mette auth.users prima di identities/mfa_*, mantiene le righe di intestazione", () => {
    const reordered = reorderAuthRestoreList(rawToc, ["auth.users", "auth.identities", "auth.mfa_factors", "auth.mfa_amr_claims"]);
    const lines = reordered.split("\n");
    const idxUsers = lines.findIndex((l) => /TABLE DATA auth users/.test(l));
    const idxIdentities = lines.findIndex((l) => /TABLE DATA auth identities/.test(l));
    const idxMfaFactors = lines.findIndex((l) => /TABLE DATA auth mfa_factors/.test(l));
    const idxMfaAmr = lines.findIndex((l) => /TABLE DATA auth mfa_amr_claims/.test(l));
    expect(idxUsers).toBeGreaterThanOrEqual(0);
    expect(idxUsers).toBeLessThan(idxIdentities);
    expect(idxUsers).toBeLessThan(idxMfaFactors);
    expect(idxUsers).toBeLessThan(idxMfaAmr);
    expect(lines.slice(0, 3)).toEqual([";", "; Archive created at 2026-09-09 13:39:00 UTC", ";"]);
  });

  it("tabelle mancanti (progetto senza MFA): riordina comunque users prima di identities", () => {
    const tocNoMfa = [";", "216; 1259 16820 TABLE DATA auth identities postgres", "219; 1259 16823 TABLE DATA auth users postgres"].join("\n");
    const reordered = reorderAuthRestoreList(tocNoMfa);
    const lines = reordered.split("\n").filter((l) => /TABLE DATA/.test(l));
    expect(lines[0]).toMatch(/auth users/);
    expect(lines[1]).toMatch(/auth identities/);
  });

  it("non tocca righe che non sono TABLE DATA auth.*", () => {
    const toc = [";", "1; 2615 2200 SCHEMA - public postgres", "219; 1259 16823 TABLE DATA auth users postgres"].join("\n");
    const reordered = reorderAuthRestoreList(toc);
    expect(reordered).toContain("SCHEMA - public");
    expect(reordered).toContain("TABLE DATA auth users");
  });

  it("input vuoto non lancia", () => {
    expect(reorderAuthRestoreList("")).toBe("");
  });
});

describe("postgres-restore-drill — filtro creazione schema public", () => {
  it("rimuove la riga 'SCHEMA - public', lascia intatto il resto", () => {
    const toc = [
      ";",
      "1; 2615 2200 SCHEMA - public postgres",
      "2; 1259 16400 TABLE public tenants postgres",
      "3; 1259 16401 TABLE DATA public tenants postgres",
    ].join("\n");
    const filtered = filterOutPublicSchemaCreation(toc);
    expect(filtered).not.toContain("SCHEMA - public");
    expect(filtered).toContain("TABLE public tenants");
    expect(filtered).toContain("TABLE DATA public tenants");
  });

  it("non rimuove un COMMENT su SCHEMA public", () => {
    const toc = ["1; 2615 2200 SCHEMA - public postgres", "5; 0 0 COMMENT - SCHEMA public postgres"].join("\n");
    const filtered = filterOutPublicSchemaCreation(toc);
    expect(filtered).not.toMatch(/^1; 2615 2200 SCHEMA - public postgres$/m);
    expect(filtered).toContain("COMMENT - SCHEMA public");
  });

  it("no-op se la riga non e' presente", () => {
    const toc = ["2; 1259 16400 TABLE public tenants postgres"].join("\n");
    expect(filterOutPublicSchemaCreation(toc)).toBe(toc);
  });

  it("input vuoto non lancia", () => {
    expect(filterOutPublicSchemaCreation("")).toBe("");
  });
});
