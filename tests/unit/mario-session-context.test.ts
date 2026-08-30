import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import { FakeUpstashRedis } from "./mario-fake-redis";
import { __setSharedRedisForTests } from "@/lib/server/redis";
import {
  getMarioSession,
  updateMarioSession,
  clearPendingConfirmation,
  clearMarioSession,
  toMarioSessionSummary,
  getLastMarioSessionStore,
  __resetMarioSessionsForTests,
} from "@/lib/server/mario-assistant/session-context";

const A = { t: "tenant-a", u: "user-1" };

function pending(createdAt = Date.now()) {
  return { toolName: "its.create_booking_group", confirmationToken: "SEGRETO.sig", op: "its.preview_create_booking_group", createdAt };
}

afterEach(() => {
  __setSharedRedisForTests(undefined);
  __resetMarioSessionsForTests();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─────────────────────────────────────────────────────────────────────────────
// Fallback in-memory (Upstash non configurato, non produzione)
// ─────────────────────────────────────────────────────────────────────────────
describe("session-context — fallback in-memory (dev/test)", () => {
  beforeEach(() => {
    __setSharedRedisForTests(null); // forza "non configurato"
    __resetMarioSessionsForTests();
  });

  it("una sessione mai vista è vuota ma definita (mai null)", async () => {
    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBeUndefined();
    expect(s.pendingConfirmation).toBeUndefined();
    expect(getLastMarioSessionStore()).toBe("memory_fallback");
  });

  it("updateMarioSession applica una patch parziale e persiste tra le letture", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1", lastBookingGroupName: "Natività" });
    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBe("g1");
    expect(s.lastBookingGroupName).toBe("Natività");
  });

  it("§15 isolamento tenant/utente: cross-tenant e cross-user impossibili", async () => {
    await updateMarioSession("tenant-a", "user-1", { lastBookingGroupId: "G1" });
    await updateMarioSession("tenant-b", "user-1", { lastBookingGroupId: "GX" }); // stesso user, tenant diverso
    await updateMarioSession("tenant-a", "user-2", { lastBookingGroupId: "GY" }); // stesso tenant, user diverso

    expect((await getMarioSession("tenant-a", "user-1")).lastBookingGroupId).toBe("G1");
    expect((await getMarioSession("tenant-b", "user-1")).lastBookingGroupId).toBe("GX");
    expect((await getMarioSession("tenant-a", "user-2")).lastBookingGroupId).toBe("GY");
  });

  it("clearPendingConfirmation rimuove SOLO la conferma", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1", pendingConfirmation: pending() });
    await clearPendingConfirmation(A.t, A.u);
    const s = await getMarioSession(A.t, A.u);
    expect(s.pendingConfirmation).toBeUndefined();
    expect(s.lastBookingGroupId).toBe("g1");
  });

  it("§15 la sessione scade dopo 10 minuti", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    vi.setSystemTime(new Date("2026-01-01T10:11:00Z"));
    expect((await getMarioSession(A.t, A.u)).lastBookingGroupId).toBeUndefined();
  });

  it("§13 la conferma in sospeso scade a 180s anche se il resto del contesto è più recente", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1", pendingConfirmation: pending(Date.now()) });
    vi.setSystemTime(new Date("2026-01-01T10:03:05Z")); // +185s
    const s = await getMarioSession(A.t, A.u);
    expect(s.pendingConfirmation).toBeUndefined();
    expect(s.lastBookingGroupId).toBe("g1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Store condiviso (fake Upstash)
// ─────────────────────────────────────────────────────────────────────────────
describe("session-context — store condiviso (Redis)", () => {
  let fake: FakeUpstashRedis;

  beforeEach(() => {
    fake = new FakeUpstashRedis();
    __setSharedRedisForTests(fake as unknown as Redis);
    __resetMarioSessionsForTests();
  });

  it("read/modify/write passano dallo store condiviso (store = 'shared')", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBe("g1");
    expect(getLastMarioSessionStore()).toBe("shared");
    // la chiave usa tenant+user, mai email/nome
    expect(fake.raw("mario:session:tenant-a:user-1")).toMatchObject({ lastBookingGroupId: "g1" });
  });

  it("§7 merge per campo: due update su campi diversi non si cancellano", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    await updateMarioSession(A.t, A.u, { pendingConfirmation: pending() });
    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBe("g1");
    expect(s.pendingConfirmation?.op).toBe("its.preview_create_booking_group");
  });

  it("§15 isolamento tenant/utente sullo store condiviso", async () => {
    await updateMarioSession("tenant-a", "user-1", { lastBookingGroupId: "G1" });
    await updateMarioSession("tenant-b", "user-1", { lastBookingGroupId: "GX" });
    await updateMarioSession("tenant-a", "user-2", { lastBookingGroupId: "GY" });
    expect((await getMarioSession("tenant-b", "user-1")).lastBookingGroupId).toBe("GX");
    expect((await getMarioSession("tenant-a", "user-2")).lastBookingGroupId).toBe("GY");
    expect((await getMarioSession("tenant-a", "user-1")).lastBookingGroupId).toBe("G1");
  });

  it("§13 pendingConfirmation scartata a 180s pur restando la key sessione", async () => {
    let clock = new Date("2026-01-01T10:00:00Z").getTime();
    fake = new FakeUpstashRedis({ now: () => clock });
    __setSharedRedisForTests(fake as unknown as Redis);
    vi.useFakeTimers();
    vi.setSystemTime(clock);

    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1", pendingConfirmation: pending(clock) });
    clock += 185_000;
    vi.setSystemTime(clock);

    const s = await getMarioSession(A.t, A.u);
    expect(s.pendingConfirmation).toBeUndefined();
    expect(s.lastBookingGroupId).toBe("g1"); // sessione ancora viva (TTL 10 min)
  });

  it("§14 cancel: dopo clearPendingConfirmation il token sparisce, il resto resta", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1", pendingConfirmation: pending() });
    await clearPendingConfirmation(A.t, A.u);
    const s = await getMarioSession(A.t, A.u);
    expect(s.pendingConfirmation).toBeUndefined();
    expect(s.lastBookingGroupId).toBe("g1");
  });

  it("clearMarioSession elimina l'intera key", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    await clearMarioSession(A.t, A.u);
    expect(fake.raw("mario:session:tenant-a:user-1")).toBeNull();
  });

  it("§11 MULTI-INSTANCE: il contesto non dipende da stato module-level", async () => {
    // "Istanza A" scrive G1
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "G1", lastBookingGroupName: "Natività" });

    // Simula un secondo processo: azzera il module cache e ri-importa i moduli.
    // Il fake redis (condiviso, in scope di test) sopravvive e viene re-iniettato.
    vi.resetModules();
    const freshRedis = await import("@/lib/server/redis");
    freshRedis.__setSharedRedisForTests(fake as unknown as Redis);
    const freshSession = await import("@/lib/server/mario-assistant/session-context");

    // "Istanza B" legge: deve vedere G1 dallo store condiviso
    const s = await freshSession.getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBe("G1");
    expect(s.lastBookingGroupName).toBe("Natività");
    expect(freshSession.getLastMarioSessionStore()).toBe("shared");
  });

  it("§16 STORE FAILURE: Redis down → contesto vuoto, nessun crash, store = 'unavailable'", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    fake.failing = true;

    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBeUndefined(); // niente contesto inventato
    expect(getLastMarioSessionStore()).toBe("unavailable");

    // una scrittura non esplode e non finisce in memoria di processo
    await expect(updateMarioSession(A.t, A.u, { lastBookingGroupId: "g2" })).resolves.toBeTruthy();
    fake.failing = false;
    expect((await getMarioSession(A.t, A.u)).lastBookingGroupId).toBe("g1"); // g2 non persistito
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-safe produzione senza store condiviso
// ─────────────────────────────────────────────────────────────────────────────
describe("session-context — fail-safe produzione senza Redis", () => {
  beforeEach(() => {
    __setSharedRedisForTests(null); // Upstash non configurato
    __resetMarioSessionsForTests();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MARIO_LLM_ENABLED", "true");
  });

  it("§5 nessuna memoria di processo come fonte primaria: contesto sempre vuoto, store = 'unavailable'", async () => {
    await updateMarioSession(A.t, A.u, { lastBookingGroupId: "g1" });
    const s = await getMarioSession(A.t, A.u);
    expect(s.lastBookingGroupId).toBeUndefined();
    expect(getLastMarioSessionStore()).toBe("unavailable");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vista sicura per l'LLM
// ─────────────────────────────────────────────────────────────────────────────
describe("toMarioSessionSummary — §10", () => {
  it("non espone mai il confirmationToken, solo l'op", () => {
    const summary = toMarioSessionSummary({
      updatedAt: Date.now(),
      lastBookingGroupId: "g1",
      pendingConfirmation: pending(),
    });
    expect(JSON.stringify(summary)).not.toContain("SEGRETO");
    expect(summary.pendingConfirmationOp).toBe("its.preview_create_booking_group");
    expect((summary as Record<string, unknown>).pendingConfirmation).toBeUndefined();
    expect((summary as Record<string, unknown>).confirmationToken).toBeUndefined();
  });
});
