import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Sprint Performance 8 — lock distribuito + cooldown per pollEmailNow().
 *
 * Il fake admin.rpc replica in memoria la semantica delle funzioni Postgres
 * acquire_email_import_lock / release_email_import_lock (vedi migration
 * 0233_email_import_locks.sql): la garanzia di atomicità reale viene dal row
 * lock (FOR UPDATE) lato Postgres, qui verifichiamo che pollEmailNow orchestri
 * correttamente acquire/release e che due chiamate concorrenti in JS
 * (Promise.all, nessun await interno prima della mutazione critica nel mock)
 * si serializzino esattamente come farebbe la funzione SQL.
 */

const mocks = vi.hoisted(() => ({
  runEmailOperationalImport: vi.fn(),
}));

vi.mock("@/lib/server/email-test-import", () => ({
  runEmailOperationalImport: mocks.runEmailOperationalImport,
}));

import { pollEmailNow } from "@/lib/server/email-poll";

type LockRow = { status: "idle" | "running"; lock_expires_at: string | null; last_success_at: string | null };

function createFakeAdmin(nowRef: { current: number }) {
  const store = new Map<string, LockRow>();

  const admin = {
    rpc: vi.fn(async (fnName: string, params: Record<string, unknown>) => {
      const now = nowRef.current;
      const key = `${params.p_tenant_id}::${params.p_mailbox}`;

      if (fnName === "acquire_email_import_lock") {
        let row = store.get(key);
        if (!row) {
          row = { status: "idle", lock_expires_at: null, last_success_at: null };
          store.set(key, row);
        }
        const ttlMs = (params.p_ttl_seconds as number) * 1000;
        const cooldownMs = (params.p_cooldown_seconds as number) * 1000;
        const force = Boolean(params.p_force);

        if (row.status === "running" && row.lock_expires_at && new Date(row.lock_expires_at).getTime() > now) {
          return { data: [{ acquired: false, reason: "skipped_in_progress", last_success_at: row.last_success_at, lock_expires_at: row.lock_expires_at }], error: null };
        }
        if (!force && row.last_success_at && new Date(row.last_success_at).getTime() > now - cooldownMs) {
          return { data: [{ acquired: false, reason: "skipped_recent", last_success_at: row.last_success_at, lock_expires_at: row.lock_expires_at }], error: null };
        }

        const expiresAt = new Date(now + ttlMs).toISOString();
        row.status = "running";
        row.lock_expires_at = expiresAt;
        return { data: [{ acquired: true, reason: "acquired", last_success_at: row.last_success_at, lock_expires_at: expiresAt }], error: null };
      }

      if (fnName === "release_email_import_lock") {
        const row = store.get(key);
        if (row) {
          row.status = "idle";
          row.lock_expires_at = null;
          if (params.p_success) row.last_success_at = new Date(now).toISOString();
        }
        return { data: null, error: null };
      }

      throw new Error(`RPC non atteso nel test: ${fnName}`);
    }),
  };

  return { admin, store };
}

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function authFor(admin: ReturnType<typeof createFakeAdmin>["admin"], tenantId = TENANT_A) {
  return { admin: admin as unknown as import("@supabase/supabase-js").SupabaseClient, membership: { tenant_id: tenantId } };
}

function importResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    mailbox: "INBOX",
    unreadFound: 1,
    emailsProcessed: 1,
    pdfFound: 1,
    draftsCreated: 1,
    duplicateWarnings: 0,
    skippedNoPdf: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pollEmailNow — concorrenza (test 1 e 6 dello sprint)", () => {
  it("due richieste simultanee: solo una esegue l'import, l'altra torna skipped_in_progress", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockResolvedValue(importResult());

    const [resA, resB] = await Promise.all([
      pollEmailNow(authFor(admin), { force: false }),
      pollEmailNow(authFor(admin), { force: false }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual(["imported", "skipped_in_progress"]);
    expect(mocks.runEmailOperationalImport).toHaveBeenCalledTimes(1);
  });

  it("cron (force=false) e refresh manuale (force=true) in concorrenza: un solo import reale", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockResolvedValue(importResult({ draftsCreated: 2 }));

    const [cronResult, manualResult] = await Promise.all([
      pollEmailNow(authFor(admin), { force: false }),
      pollEmailNow(authFor(admin), { force: true }),
    ]);

    expect([cronResult.status, manualResult.status].sort()).toEqual(["imported", "skipped_in_progress"]);
    expect(mocks.runEmailOperationalImport).toHaveBeenCalledTimes(1);
  });
});

describe("pollEmailNow — cooldown (test 2 e 3 dello sprint)", () => {
  it("richiesta entro il cooldown senza force: skip, nessuna nuova connessione IMAP", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockResolvedValue(importResult());

    const first = await pollEmailNow(authFor(admin), { force: false });
    expect(first.status).toBe("imported");

    nowRef.current += 30_000; // 30s dopo: cooldown di 60s non ancora scaduto
    const second = await pollEmailNow(authFor(admin), { force: false });

    expect(second.status).toBe("skipped_recent");
    expect(mocks.runEmailOperationalImport).toHaveBeenCalledTimes(1);
  });

  it("richiesta dopo il cooldown: import consentito", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockResolvedValue(importResult());

    const first = await pollEmailNow(authFor(admin), { force: false });
    expect(first.status).toBe("imported");

    nowRef.current += 61_000; // oltre il cooldown di 60s
    const second = await pollEmailNow(authFor(admin), { force: false });

    expect(second.status).toBe("imported");
    expect(mocks.runEmailOperationalImport).toHaveBeenCalledTimes(2);
  });

  it("force=true bypassa il cooldown ma non il lock di concorrenza", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockResolvedValue(importResult());

    const first = await pollEmailNow(authFor(admin), { force: false });
    expect(first.status).toBe("imported");

    nowRef.current += 5_000; // ben dentro il cooldown
    const second = await pollEmailNow(authFor(admin), { force: true });

    expect(second.status).toBe("imported");
    expect(mocks.runEmailOperationalImport).toHaveBeenCalledTimes(2);
  });
});

describe("pollEmailNow — TTL (test 4 dello sprint)", () => {
  it("lock scaduto: nuovo import consentito anche se lo stato in DB è rimasto 'running'", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin, store } = createFakeAdmin(nowRef);

    // Simula una Function uccisa da Vercel dopo aver acquisito il lock, senza
    // mai chiamare release (niente finally eseguito).
    await admin.rpc("acquire_email_import_lock", {
      p_tenant_id: TENANT_A,
      p_mailbox: "default",
      p_ttl_seconds: 150,
      p_cooldown_seconds: 60,
      p_force: false,
    });
    expect(store.get(`${TENANT_A}::default`)?.status).toBe("running");

    nowRef.current += 151_000; // oltre il TTL di 150s
    mocks.runEmailOperationalImport.mockResolvedValue(importResult());

    const result = await pollEmailNow(authFor(admin), { force: false });

    expect(result.status).toBe("imported");
  });
});

describe("pollEmailNow — errori (test 5 dello sprint)", () => {
  it("import fallito: lock rilasciato (idle), last_success_at non aggiornato", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin, store } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockRejectedValueOnce(new Error("IMAP timeout"));

    const result = await pollEmailNow(authFor(admin), { force: false });

    expect(result.status).toBe("error");
    expect(result.error).toBe("IMAP timeout");
    const row = store.get(`${TENANT_A}::default`);
    expect(row?.status).toBe("idle");
    expect(row?.last_success_at).toBeNull();
  });

  it("dopo un fallimento un nuovo tentativo è consentito subito (nessun cooldown su errore)", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockRejectedValueOnce(new Error("IMAP timeout"));

    const first = await pollEmailNow(authFor(admin), { force: false });
    expect(first.status).toBe("error");

    mocks.runEmailOperationalImport.mockResolvedValueOnce(importResult());
    nowRef.current += 1_000;
    const second = await pollEmailNow(authFor(admin), { force: false });

    expect(second.status).toBe("imported");
  });

  it("IMAP non configurato: segnala imap_not_configured e rilascia comunque il lock", async () => {
    const nowRef = { current: Date.parse("2026-08-14T10:00:00.000Z") };
    const { admin, store } = createFakeAdmin(nowRef);
    mocks.runEmailOperationalImport.mockRejectedValueOnce(new Error("Missing IMAP_HOST/IMAP_USER/IMAP_PASS env vars"));

    const result = await pollEmailNow(authFor(admin), { force: false });

    expect(result.status).toBe("error");
    expect(result.imap_not_configured).toBe(true);
    expect(store.get(`${TENANT_A}::default`)?.status).toBe("idle");
  });
});
