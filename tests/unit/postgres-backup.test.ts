import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PG_BACKUP_R2_PREFIX,
  PG_BACKUP_RETENTION_DAYS,
  PG_BACKUP_REQUIRED_ENV,
  PG_BACKUP_FULL_SCOPE_ARGS,
  PG_BACKUP_AUTH_TABLES,
  PG_BACKUP_AUTH_EXCLUDED_TABLES,
  buildAuthDumpArgs,
  buildBackupBaseName,
  fullDumpFileName,
  authDumpFileName,
  manifestFileName,
  backupR2Key,
  isPgBackupObjectKey,
  backupSetBaseFromKey,
  backupDateFromBase,
  sha256Hex,
  groupBackupSets,
  selectExpiredBackupSets,
  buildPgBackupManifest,
  verifyRestoreList,
  verifyAuthRestoreList,
  redactSecrets,
  maskConnectionString,
  missingBackupEnv,
  parsePgMajorFromVersionLine,
  serverMajorFromVersionNum,
  isClientVersionSufficient,
  versionCompatMessage,
} from "@/lib/server/postgres-backup";

describe("postgres-backup — Disaster Recovery V3 (pure helpers)", () => {
  // ─── Naming ─────────────────────────────────────────────────────────────
  describe("naming", () => {
    it("base name e' UTC, formato its_full_YYYY-MM-DD_HH-mm", () => {
      expect(buildBackupBaseName(new Date("2026-09-06T02:30:41.000Z"))).toBe("its_full_2026-09-06_02-30");
    });
    it("base name usa UTC anche quando l'ora locale sarebbe un altro giorno", () => {
      expect(buildBackupBaseName(new Date("2026-01-01T00:15:00.000Z"))).toBe("its_full_2026-01-01_00-15");
    });
    it("nomi file derivati e chiave R2 sotto il prefix dedicato", () => {
      const base = "its_full_2026-09-06_02-30";
      expect(fullDumpFileName(base)).toBe("its_full_2026-09-06_02-30.dump");
      expect(authDumpFileName(base)).toBe("its_full_2026-09-06_02-30.auth.dump");
      expect(manifestFileName(base)).toBe("its_full_2026-09-06_02-30.manifest.json");
      expect(backupR2Key(fullDumpFileName(base))).toBe("production/postgres/its_full_2026-09-06_02-30.dump");
      expect(PG_BACKUP_R2_PREFIX).toBe("production/postgres");
    });
    it("backupDateFromBase / backupSetBaseFromKey", () => {
      expect(backupDateFromBase("its_full_2026-09-06_02-30")).toBe("2026-09-06");
      expect(backupDateFromBase("garbage")).toBeNull();
      expect(backupSetBaseFromKey("production/postgres/its_full_2026-09-06_02-30.dump")).toBe("its_full_2026-09-06_02-30");
      expect(backupSetBaseFromKey("production/postgres/its_full_2026-09-06_02-30.auth.dump")).toBe("its_full_2026-09-06_02-30");
      expect(backupSetBaseFromKey("production/postgres/its_full_2026-09-06_02-30.manifest.json")).toBe("its_full_2026-09-06_02-30");
      expect(backupSetBaseFromKey("production/postgres/other.txt")).toBeNull();
    });
  });

  // ─── Scope dump: PUBLIC + AUTH selettivo ───────────────────────────────
  describe("scope dei dump", () => {
    it("PUBLIC = --schema=public soltanto", () => {
      expect([...PG_BACKUP_FULL_SCOPE_ARGS]).toEqual(["--schema=public"]);
    });

    it("AUTH e' selettivo: SOLO users, identities, mfa_factors, mfa_amr_claims", () => {
      expect([...PG_BACKUP_AUTH_TABLES]).toEqual([
        "auth.users",
        "auth.identities",
        "auth.mfa_factors",
        "auth.mfa_amr_claims",
      ]);
    });

    it("buildAuthDumpArgs = --data-only + un --table per ciascuna tabella inclusa, MAI --schema=auth", () => {
      const argv = buildAuthDumpArgs();
      expect(argv[0]).toBe("--data-only");
      expect(argv).not.toContain("--schema=auth");
      expect(argv.filter((a) => a.startsWith("--table=")).sort()).toEqual([
        "--table=auth.identities",
        "--table=auth.mfa_amr_claims",
        "--table=auth.mfa_factors",
        "--table=auth.users",
      ]);
    });

    it("le tabelle auth ESCLUSE non compaiono mai negli args del dump", () => {
      const argv = buildAuthDumpArgs().join(" ");
      for (const excluded of PG_BACKUP_AUTH_EXCLUDED_TABLES) {
        expect(argv).not.toContain(excluded);
      }
    });

    it("elenco esclusioni auth: schema_migrations, instances, sessions, refresh_tokens, audit_log_entries, flow_state, one_time_tokens", () => {
      expect([...PG_BACKUP_AUTH_EXCLUDED_TABLES]).toEqual([
        "auth.schema_migrations",
        "auth.instances",
        "auth.sessions",
        "auth.refresh_tokens",
        "auth.audit_log_entries",
        "auth.flow_state",
        "auth.one_time_tokens",
      ]);
    });
  });

  // ─── Isolamento prefix production/postgres/ ─────────────────────────────
  describe("isolamento prefix production/postgres/", () => {
    it("riconosce solo i propri artefatti sotto il prefix", () => {
      expect(isPgBackupObjectKey("production/postgres/its_full_2026-09-06_02-30.dump")).toBe(true);
      expect(isPgBackupObjectKey("production/postgres/its_full_2026-09-06_02-30.auth.dump")).toBe(true);
      expect(isPgBackupObjectKey("production/postgres/its_full_2026-09-06_02-30.manifest.json")).toBe(true);
    });
    it("NON riconosce gli snapshot JSON (Layer 3) ne' altri oggetti", () => {
      expect(isPgBackupObjectKey("production/backup_2026-09-05.json")).toBe(false);
      expect(isPgBackupObjectKey("backup_2026-09-05.json")).toBe(false);
      expect(isPgBackupObjectKey("production/postgres/random.dump")).toBe(false);
      expect(isPgBackupObjectKey("production/postgres/its_full_2026-09-06.dump")).toBe(false); // manca HH-mm
      expect(isPgBackupObjectKey("other-prefix/its_full_2026-09-06_02-30.dump")).toBe(false);
    });
  });

  // ─── SHA-256 ───────────────────────────────────────────────────────────
  describe("sha256Hex", () => {
    it("vettore noto per stringa vuota", () => {
      expect(sha256Hex(Buffer.from(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    });
    it("vettore noto per 'abc'", () => {
      expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
    it("deterministico byte-per-byte", () => {
      expect(sha256Hex(Buffer.from([1, 2, 3, 4, 5]))).toBe(sha256Hex(Uint8Array.from([1, 2, 3, 4, 5])));
    });
  });

  // ─── Version compatibility client/server ──────────────────────────────
  describe("compatibilita' versione client/server", () => {
    it("parsePgMajorFromVersionLine", () => {
      expect(parsePgMajorFromVersionLine("pg_dump (PostgreSQL) 17.2 (Ubuntu 17.2-1.pgdg22.04+1)")).toBe(17);
      expect(parsePgMajorFromVersionLine("pg_restore (PostgreSQL) 15.8")).toBe(15);
      expect(parsePgMajorFromVersionLine("15.8")).toBe(15);
      expect(parsePgMajorFromVersionLine("")).toBeNull();
      expect(parsePgMajorFromVersionLine(null)).toBeNull();
    });
    it("serverMajorFromVersionNum", () => {
      expect(serverMajorFromVersionNum("150008")).toBe(15);
      expect(serverMajorFromVersionNum("170002")).toBe(17);
      expect(serverMajorFromVersionNum("160004")).toBe(16);
      expect(serverMajorFromVersionNum(150008)).toBe(15);
      expect(serverMajorFromVersionNum("")).toBeNull();
      expect(serverMajorFromVersionNum("abc")).toBeNull();
    });
    it("isClientVersionSufficient: client >= server", () => {
      expect(isClientVersionSufficient(17, 15)).toBe(true);
      expect(isClientVersionSufficient(17, 17)).toBe(true);
      expect(isClientVersionSufficient(15, 17)).toBe(false);
      expect(isClientVersionSufficient(null, 15)).toBe(false);
      expect(isClientVersionSufficient(17, null)).toBe(false);
    });
    it("versionCompatMessage: OK / non affidabile / non rilevabile", () => {
      expect(versionCompatMessage(17, 15)).toMatch(/OK/);
      expect(versionCompatMessage(15, 17)).toMatch(/non affidabile.*postgresql-client >= 17/);
      expect(versionCompatMessage(null, 15)).toMatch(/non rilevabile/);
      expect(versionCompatMessage(17, null)).toMatch(/non rilevabile/);
    });
  });

  // ─── Retention ─────────────────────────────────────────────────────────
  describe("retention", () => {
    const keysFor = (bases: string[]) =>
      bases.flatMap((b) => [
        `production/postgres/${b}.dump`,
        `production/postgres/${b}.auth.dump`,
        `production/postgres/${b}.manifest.json`,
      ]);

    it("groupBackupSets raggruppa per base name, piu' recente prima", () => {
      const sets = groupBackupSets(keysFor(["its_full_2026-09-01_02-30", "its_full_2026-09-05_02-30"]));
      expect(sets.map((s) => s.base)).toEqual(["its_full_2026-09-05_02-30", "its_full_2026-09-01_02-30"]);
      expect(sets[0]!.keys).toHaveLength(3);
    });

    it("elimina i set piu' vecchi del cutoff (30gg)", () => {
      const now = new Date("2026-09-30T02:30:00.000Z");
      const keys = keysFor([
        "its_full_2026-07-01_02-30",
        "its_full_2026-08-15_02-30",
        "its_full_2026-09-10_02-30",
        "its_full_2026-09-29_02-30",
      ]);
      const plan = selectExpiredBackupSets(keys, now, PG_BACKUP_RETENTION_DAYS);
      expect(plan.expire.map((s) => s.base).sort()).toEqual([
        "its_full_2026-07-01_02-30",
        "its_full_2026-08-15_02-30",
      ]);
      expect(plan.expiredKeys).toHaveLength(6);
      expect(plan.newestKeptBase).toBe("its_full_2026-09-29_02-30");
    });

    it("NON elimina MAI il set piu' recente, anche se oltre il cutoff", () => {
      const now = new Date("2026-12-31T02:30:00.000Z");
      const keys = keysFor(["its_full_2026-01-01_02-30", "its_full_2026-02-01_02-30"]);
      const plan = selectExpiredBackupSets(keys, now, PG_BACKUP_RETENTION_DAYS);
      expect(plan.newestKeptBase).toBe("its_full_2026-02-01_02-30");
      expect(plan.keep.map((s) => s.base)).toEqual(["its_full_2026-02-01_02-30"]);
      expect(plan.expire.map((s) => s.base)).toEqual(["its_full_2026-01-01_02-30"]);
    });

    it("un solo set presente -> mai eliminato", () => {
      const plan = selectExpiredBackupSets(keysFor(["its_full_2026-01-01_02-30"]), new Date("2030-01-01T00:00:00.000Z"));
      expect(plan.expiredKeys).toEqual([]);
      expect(plan.newestKeptBase).toBe("its_full_2026-01-01_02-30");
    });

    it("tutti i set recenti -> niente da eliminare", () => {
      const now = new Date("2026-09-30T02:30:00.000Z");
      const plan = selectExpiredBackupSets(
        keysFor(["its_full_2026-09-20_02-30", "its_full_2026-09-25_02-30", "its_full_2026-09-29_02-30"]),
        now,
      );
      expect(plan.expiredKeys).toEqual([]);
      expect(plan.keep).toHaveLength(3);
    });

    it("IGNORA gli snapshot JSON e qualunque chiave fuori dal prefix (Layer 3 intoccabile)", () => {
      const now = new Date("2026-09-30T02:30:00.000Z");
      const keys = [
        "production/backup_2026-01-01.json",
        "production/backup_2026-09-29.json",
        "production/postgres/its_full_2026-01-01_02-30.dump",
        "production/postgres/its_full_2026-09-29_02-30.dump",
        "unrelated/whatever.dump",
      ];
      const plan = selectExpiredBackupSets(keys, now);
      expect(plan.expiredKeys).toEqual(["production/postgres/its_full_2026-01-01_02-30.dump"]);
      expect(plan.expiredKeys.some((k) => k.includes("backup_2026-01-01.json"))).toBe(false);
      expect(plan.expiredKeys.some((k) => k.startsWith("unrelated/"))).toBe(false);
    });

    it("input vuoto -> piano vuoto", () => {
      expect(selectExpiredBackupSets([], new Date())).toEqual({ keep: [], expire: [], expiredKeys: [], newestKeptBase: null });
    });
  });

  // ─── Verifica PUBLIC ──────────────────────────────────────────────────
  describe("verifyRestoreList (PUBLIC dump)", () => {
    const tableLines = [
      "215; 1259 16384 TABLE public tenants postgres",
      "4001; 0 16384 TABLE DATA public tenants postgres",
      "216; 1259 16390 TABLE public services postgres",
      "217; 1259 16400 TABLE public assignments postgres",
      "218; 1259 16410 TABLE public agencies postgres",
      "219; 1259 16420 TABLE public hotels postgres",
      "220; 1259 16430 TABLE public memberships postgres",
      "221; 1259 16440 TABLE public booking_groups postgres",
      "222; 1259 16450 TABLE public tenant_bus_allocations postgres",
      "5; 2615 16385 SCHEMA - public postgres",
    ];
    const goodToc = [
      ";",
      "; Archive created at 2026-09-06 02:30:00 UTC",
      ";     Dumped from database version 15.8",
      ";",
      "2; 3079 16816 EXTENSION - unaccent",
      ...tableLines,
      "900; 1255 16500 FUNCTION public current_tenant_id() postgres",
    ].join("\n");

    it("PASS: TOC non vuoto + schema public + tabelle di controllo + estensione unaccent", () => {
      const v = verifyRestoreList(goodToc);
      expect(v.status).toBe("passed");
      expect(v.has_public_schema).toBe(true);
      expect(v.checked_tables_missing).toEqual([]);
      expect(v.unaccent_extension_present).toBe(true);
    });

    it("FAIL: TOC vuoto", () => {
      const v = verifyRestoreList("");
      expect(v.status).toBe("failed");
      expect(v.pg_restore_list_entries).toBe(0);
      expect(v.notes.join(" ")).toMatch(/TOC vuoto/i);
    });

    it("FAIL: manca una tabella di controllo", () => {
      const toc = goodToc.split("\n").filter((l) => !/\bservices\b/.test(l)).join("\n");
      const v = verifyRestoreList(toc);
      expect(v.status).toBe("failed");
      expect(v.checked_tables_missing).toContain("services");
    });

    it("UNVERIFIED (non failed): estensione unaccent assente dal TOC — nessun oggetto ITS ne dipende", () => {
      const toc = goodToc.split("\n").filter((l) => !/unaccent/i.test(l)).join("\n");
      const v = verifyRestoreList(toc);
      expect(v.status).toBe("unverified");
      expect(v.unaccent_extension_present).toBe(false);
      expect(v.has_public_schema).toBe(true);
      expect(v.checked_tables_missing).toEqual([]);
      expect(v.notes.join(" ")).toMatch(/unaccent.*0189/i);
      expect(v.notes.join(" ")).toMatch(/CREATE EXTENSION unaccent/i);
    });

    it("FAIL (non unverified): struttura rotta (manca una tabella di controllo) resta failed anche con unaccent presente", () => {
      const toc = goodToc.split("\n").filter((l) => !/\bagencies\b/.test(l)).join("\n");
      const v = verifyRestoreList(toc);
      expect(v.status).toBe("failed");
      expect(v.checked_tables_missing).toContain("agencies");
    });

    it("detection unaccent robusta su varianti di formato pg_dump", () => {
      const base = [...tableLines, "; Dumped from database version 15.8"].join("\n");
      expect(verifyRestoreList(`${base}\n216; 3079 1 EXTENSION - unaccent postgres`).unaccent_extension_present).toBe(true);
      expect(verifyRestoreList(`${base}\n216; 3079 1 EXTENSION unaccent`).unaccent_extension_present).toBe(true);
      expect(verifyRestoreList(`${base}\n3320; 0 0 COMMENT - EXTENSION unaccent postgres`).unaccent_extension_present).toBe(true);
      // falso positivo da evitare: una funzione con "unaccent" nel nome ma nessun EXTENSION
      expect(verifyRestoreList(`${base}\n99; 1255 1 FUNCTION public my_unaccent_wrapper() postgres`).unaccent_extension_present).toBe(false);
    });
  });

  // ─── Verifica AUTH ───────────────────────────────────────────────────
  describe("verifyAuthRestoreList (AUTH dump)", () => {
    const authToc = (tables: string[]) =>
      [
        ";",
        "; Archive created at 2026-09-06 02:30:05 UTC",
        ";",
        ...tables.map((t, i) => `${4000 + i}; 0 ${16000 + i} TABLE DATA auth ${t} supabase_auth_admin`),
      ].join("\n");

    it("PASS: auth.users E auth.identities presenti (mfa opzionali)", () => {
      const v = verifyAuthRestoreList(authToc(["users", "identities", "mfa_factors", "mfa_amr_claims"]));
      expect(v.status).toBe("passed");
      expect(v.has_users).toBe(true);
      expect(v.has_identities).toBe(true);
      expect(v.tables_present).toEqual([
        "auth.users",
        "auth.identities",
        "auth.mfa_factors",
        "auth.mfa_amr_claims",
      ]);
    });

    it("PASS: users + identities presenti, mfa ASSENTI (progetto senza MFA)", () => {
      const v = verifyAuthRestoreList(authToc(["users", "identities"]));
      expect(v.status).toBe("passed");
      expect(v.tables_present).toEqual(["auth.users", "auth.identities"]);
    });

    it("FAIL: auth.users assente -> BACKUP FAILED", () => {
      const v = verifyAuthRestoreList(authToc(["identities", "mfa_factors"]));
      expect(v.status).toBe("failed");
      expect(v.has_users).toBe(false);
      expect(v.notes.join(" ")).toMatch(/auth\.users assente/i);
    });

    it("FAIL: auth.identities assente -> BACKUP FAILED (login non ripristinabile)", () => {
      const v = verifyAuthRestoreList(authToc(["users"]));
      expect(v.status).toBe("failed");
      expect(v.has_identities).toBe(false);
      expect(v.notes.join(" ")).toMatch(/auth\.identities assente/i);
    });

    it("FAIL: TOC auth vuoto", () => {
      const v = verifyAuthRestoreList("");
      expect(v.status).toBe("failed");
      expect(v.pg_restore_list_entries).toBe(0);
    });
  });

  // ─── Manifest v2 ─────────────────────────────────────────────────────
  describe("buildPgBackupManifest (schema_version 2)", () => {
    const publicOk = {
      status: "passed" as const,
      pg_restore_list_entries: 4200,
      has_public_schema: true,
      checked_tables_present: ["tenants", "services"],
      checked_tables_missing: [] as string[],
      unaccent_extension_present: true,
      notes: [] as string[],
    };
    const authOk = {
      status: "passed" as const,
      pg_restore_list_entries: 4,
      has_users: true,
      has_identities: true,
      tables_present: ["auth.users", "auth.identities"],
      notes: [] as string[],
    };
    const baseInput = (over: Partial<Parameters<typeof buildPgBackupManifest>[0]> = {}) => ({
      now: new Date("2026-09-06T02:30:12.000Z"),
      baseName: "its_full_2026-09-06_02-30",
      postgresServerVersion: "15.8",
      postgresServerMajor: 15,
      pgDumpVersion: "pg_dump (PostgreSQL) 17.2",
      pgDumpMajor: 17,
      pgRestoreVersion: "pg_restore (PostgreSQL) 17.2",
      fullScope: "--schema=public",
      authScope: "--data-only --table=auth.users --table=auth.identities --table=auth.mfa_factors --table=auth.mfa_amr_claims",
      artifacts: [
        { filename: "its_full_2026-09-06_02-30.dump", kind: "full" as const, size_bytes: 1000, sha256: "a".repeat(64), r2_key: "production/postgres/its_full_2026-09-06_02-30.dump", r2_verified: true },
        { filename: "its_full_2026-09-06_02-30.auth.dump", kind: "auth" as const, size_bytes: 200, sha256: "b".repeat(64), r2_key: "production/postgres/its_full_2026-09-06_02-30.auth.dump", r2_verified: true },
      ],
      publicVerification: publicOk,
      authVerification: authOk,
      durationMs: 41234.7,
      runner: "github-actions",
      ...over,
    });

    it("shape v2: verification split public/auth + overall, versioni major, connection session-pooler", () => {
      const m = buildPgBackupManifest(baseInput());
      expect(m.schema_version).toBe(2);
      expect(m.connection).toBe("session-pooler");
      expect(m.pg_dump_major).toBe(17);
      expect(m.postgres_server_major).toBe(15);
      expect(m.dump_scope.auth_tables_included).toEqual(["auth.users", "auth.identities", "auth.mfa_factors", "auth.mfa_amr_claims"]);
      expect(m.dump_scope.auth_tables_excluded).toContain("auth.schema_migrations");
      expect(m.verification.status).toBe("passed");
      expect(m.verification.public.status).toBe("passed");
      expect(m.verification.auth.status).toBe("passed");
      expect(m.totals).toEqual({ artifact_count: 2, total_size_bytes: 1200 });
      expect(m.duration_ms).toBe(41235);
    });

    it("overall = failed se PUBLIC fallisce", () => {
      const m = buildPgBackupManifest(baseInput({ publicVerification: { ...publicOk, status: "failed", unaccent_extension_present: false } }));
      expect(m.verification.status).toBe("failed");
      expect(m.verification.auth.status).toBe("passed");
    });

    it("overall = failed se AUTH fallisce", () => {
      const m = buildPgBackupManifest(baseInput({ authVerification: { ...authOk, status: "failed", has_identities: false } }));
      expect(m.verification.status).toBe("failed");
      expect(m.verification.public.status).toBe("passed");
    });

    it("overall = unverified se PUBLIC e' unverified (unaccent assente) e AUTH passed", () => {
      const m = buildPgBackupManifest(
        baseInput({ publicVerification: { ...publicOk, status: "unverified", unaccent_extension_present: false } }),
      );
      expect(m.verification.status).toBe("unverified");
      expect(m.verification.public.status).toBe("unverified");
      expect(m.verification.auth.status).toBe("passed");
    });

    it("overall = failed vince su unverified: PUBLIC unverified + AUTH failed -> failed", () => {
      const m = buildPgBackupManifest(
        baseInput({
          publicVerification: { ...publicOk, status: "unverified", unaccent_extension_present: false },
          authVerification: { ...authOk, status: "failed", has_users: false },
        }),
      );
      expect(m.verification.status).toBe("failed");
    });

    it("nessun segreto/PII nel manifest", () => {
      const json = JSON.stringify(buildPgBackupManifest(baseInput()));
      expect(json).not.toMatch(/postgres:\/\//i);
      expect(json).not.toMatch(/password|secret|:\/\/[^"]*@/i);
    });
  });

  // ─── Redazione segreti ────────────────────────────────────────────────
  describe("redactSecrets", () => {
    it("rimuove la password da una connection string postgres:// (anche Session Pooler)", () => {
      const out = redactSecrets(
        'connection to server at "postgresql://postgres.abcdefghijklmnop:SuperSecret123@aws-0-eu-central-1.pooler.supabase.com:5432/postgres" failed',
        [],
      );
      expect(out).not.toContain("SuperSecret123");
      expect(out).toContain("[redacted]@aws-0-eu-central-1.pooler.supabase.com");
    });
    it("rimuove ogni occorrenza letterale dei segreti passati", () => {
      const secret = "r2-secret-access-key-abcdef";
      const out = redactSecrets(`AccessDenied for key ${secret} and again ${secret}`, [secret, undefined, null, "ab"]);
      expect(out).not.toContain(secret);
    });
    it("ignora segreti troppo corti (<4)", () => {
      expect(redactSecrets("valore x1 non sensibile", ["x1"])).toBe("valore x1 non sensibile");
    });
    it("tronca output molto lunghi", () => {
      const out = redactSecrets("A".repeat(5000), []);
      expect(out.length).toBeLessThanOrEqual(2000);
      expect(out.endsWith("...")).toBe(true);
    });
  });

  describe("maskConnectionString (Session Pooler URI)", () => {
    it("maschera password, username (postgres.<ref>) e parte dell'host", () => {
      const m = maskConnectionString("postgresql://postgres.lnjgwxqblapmxabwiyrg:pwd@aws-0-eu-central-1.pooler.supabase.com:5432/postgres");
      expect(m).not.toContain("pwd");
      expect(m).not.toContain("lnjgwxqblapmxabwiyrg");
      expect(m).toContain(":***@");
      expect(m).toMatch(/^postgresql:\/\/po\*\*\*:\*\*\*@aw\*\*\*/);
    });
    it("non impostata / non parsabile", () => {
      expect(maskConnectionString(undefined)).toBe("(non impostata)");
      expect(maskConnectionString("   ")).toBe("(non impostata)");
      expect(maskConnectionString("not-a-url")).toBe("(connection string non parsabile)");
    });
  });

  // ─── Configurazione mancante ──────────────────────────────────────────
  describe("missingBackupEnv", () => {
    const saved: Record<string, string | undefined> = {};
    afterEach(() => {
      for (const k of PG_BACKUP_REQUIRED_ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    const stash = () => {
      for (const k of PG_BACKUP_REQUIRED_ENV) saved[k] = process.env[k];
    };

    it("elenca TUTTE le env richieste quando l'ambiente e' vuoto (nessun valore restituito)", () => {
      stash();
      expect(missingBackupEnv({})).toEqual([...PG_BACKUP_REQUIRED_ENV]);
    });

    it("elenca solo quelle effettivamente mancanti", () => {
      const env = {
        SUPABASE_DB_URL: "postgresql://postgres.ref:y@aws-0-x.pooler.supabase.com:5432/postgres",
        R2_ACCOUNT_ID: "acc",
        R2_ACCESS_KEY_ID: "key",
        R2_SECRET_ACCESS_KEY: "sec",
        R2_BUCKET_NAME: "  ",
      } as NodeJS.ProcessEnv;
      expect(missingBackupEnv(env).sort()).toEqual(["R2_BUCKET_NAME", "R2_ENDPOINT"]);
    });

    it("nessuna mancante quando tutte presenti", () => {
      const env = Object.fromEntries(PG_BACKUP_REQUIRED_ENV.map((k) => [k, "value"])) as NodeJS.ProcessEnv;
      expect(missingBackupEnv(env)).toEqual([]);
    });
  });

  // ─── Connection strategy documentata + nessun secret hardcoded ────────
  describe("workflow + runbook: connection strategy (Session Pooler 5432) e nessun secret", () => {
    const wf = readFileSync(join(process.cwd(), ".github/workflows/postgres-backup.yml"), "utf8");
    const doc = readFileSync(join(process.cwd(), "docs/disaster-recovery.md"), "utf8");
    const script = readFileSync(join(process.cwd(), "scripts/postgres-backup.mjs"), "utf8");

    it("il workflow installa postgresql-client-17 (non 15) e verifica pg_dump/pg_restore/psql", () => {
      expect(wf).toMatch(/postgresql-client-17/);
      expect(wf).not.toMatch(/postgresql-client-15/);
      expect(wf).toMatch(/pg_dump --version/);
      expect(wf).toMatch(/pg_restore --version/);
      expect(wf).toMatch(/psql --version/);
    });

    it("workflow e runbook documentano il Session Pooler, porta 5432, e sconsigliano Transaction Pooler 6543 e Direct", () => {
      for (const text of [wf, doc]) {
        expect(text).toMatch(/Session [Pp]ooler/);
        expect(text).toMatch(/5432/);
        expect(text).toMatch(/6543/); // menzionato per dire di NON usarlo
        expect(text).toMatch(/[Tt]ransaction [Pp]ooler/);
        expect(text).toMatch(/[Dd]irect/);
      }
      // la forma concettuale e' documentata senza project-ref/regione reali
      expect(doc).toMatch(/postgres\.<project-ref>:<DB_PASSWORD>@aws-0-<region>\.pooler\.supabase\.com:5432/);
    });

    it("nessun secret / connection string reale hardcoded nel workflow o nello script", () => {
      // niente password/URL concreti: solo placeholder <...> e riferimenti a ${{ secrets.* }}
      for (const text of [wf, script]) {
        expect(text).not.toMatch(/postgres(?:ql)?:\/\/[^\s<]*:[^\s<@]+@[^\s<]+\.supabase\.(?:com|co)/i);
        expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/); // JWT-like (service role)
      }
      expect(wf).toMatch(/\$\{\{ secrets\.SUPABASE_DB_URL \}\}/);
    });

    it("lo script non stampa mai la connection string in chiaro (usa maskConnectionString / redactSecrets)", () => {
      expect(script).toMatch(/maskConnectionString\(connStr\)/);
      expect(script).not.toMatch(/console\.log\([^)]*connStr[^)]*\)/);
      expect(script).not.toMatch(/log\(\s*connStr\s*\)/);
    });
  });
});
