import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveBookingPracticeNumber } from "@/lib/server/booking-practice-number";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function fakeAdmin(rpcImpl: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>): SupabaseClient {
  return { rpc: rpcImpl } as unknown as SupabaseClient;
}

describe("resolveBookingPracticeNumber", () => {
  it("1. RPC restituisce il numero pratica -> lo ritorna cosi' com'e'", async () => {
    const admin = fakeAdmin(async () => ({ data: "ITS-2026-154", error: null }));
    const result = await resolveBookingPracticeNumber(admin, TENANT);
    expect(result).toBe("ITS-2026-154");
  });

  it("2. invoca la funzione RPC corretta con il tenant_id giusto", async () => {
    const rpcSpy = vi.fn(async () => ({ data: "ITS-2026-1", error: null }));
    const admin = fakeAdmin(rpcSpy);
    await resolveBookingPracticeNumber(admin, TENANT);
    expect(rpcSpy).toHaveBeenCalledWith("next_booking_practice_number", { p_tenant_id: TENANT });
  });

  it("3. errore RPC -> null, mai un'eccezione propagata (il modulo resta best-effort: e' la route new-booking a trattare null come fatale, vedi tests/unit/new-booking-practice-number.test.ts)", async () => {
    const admin = fakeAdmin(async () => ({ data: null, error: { message: "connection reset" } }));
    const result = await resolveBookingPracticeNumber(admin, TENANT);
    expect(result).toBeNull();
  });

  it("4. eccezione lanciata dal client -> null, mai propagata", async () => {
    const admin = fakeAdmin(async () => {
      throw new Error("network down");
    });
    await expect(resolveBookingPracticeNumber(admin, TENANT)).resolves.toBeNull();
  });

  it("5. data vuota/non stringa -> null (mai un valore inventato)", async () => {
    const admin1 = fakeAdmin(async () => ({ data: null, error: null }));
    expect(await resolveBookingPracticeNumber(admin1, TENANT)).toBeNull();
    const admin2 = fakeAdmin(async () => ({ data: "", error: null }));
    expect(await resolveBookingPracticeNumber(admin2, TENANT)).toBeNull();
  });
});

describe("booking_practice_counters (migration 0243) — nessuna logica di decremento/riutilizzo", () => {
  const migrationPath = fileURLToPath(new URL("../../supabase/migrations/0243_booking_practice_numbers.sql", import.meta.url));
  const sql = readFileSync(migrationPath, "utf8");

  it("1. la migration non contiene mai una DELETE su booking_practice_counters", () => {
    expect(sql).not.toMatch(/delete\s+from\s+public\.booking_practice_counters/i);
  });

  it("2. la migration non contiene mai un decremento di last_value (nessun riutilizzo di un numero consumato)", () => {
    expect(sql).not.toMatch(/last_value\s*=\s*[^,]*-\s*1/i);
  });

  it("3. l'unica scrittura su last_value e' un incremento atomico (INSERT ... ON CONFLICT DO UPDATE ... +1 ... RETURNING)", () => {
    expect(sql).toMatch(/last_value\s*=\s*public\.booking_practice_counters\.last_value\s*\+\s*1/i);
    expect(sql).toMatch(/returning\s+last_value/i);
  });
});
