import { beforeEach, describe, expect, it, vi } from "vitest";

const eqCalls: unknown[][] = [];
let row: Record<string, unknown> | null = null;
vi.mock("@/lib/server/supabase-admin", () => ({
  createAdminClient: () => ({
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (...args: unknown[]) => { eqCalls.push(args); return q; };
      q.maybeSingle = () => Promise.resolve({ data: row, error: null });
      return q;
    },
    storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: { message: "no" } }) }) },
  }),
}));

import { GET } from "@/app/api/bookings/[id]/qr-codes/[direction]/image/route";

const ID = "11111111-1111-4111-8111-111111111111";
const call = (query: string) =>
  GET(new Request(`https://its.test/api/bookings/${ID}/qr-codes/outbound/image${query}`), { params: Promise.resolve({ id: ID, direction: "outbound" }) });

beforeEach(() => { eqCalls.length = 0; row = { qr_payload: "https://its.test/qr/bus/x", qr_file_path: null }; });

describe("immagine QR bus", () => {
  it("senza token: 404 e nessuna lettura del QR", async () => {
    const res = await call("");
    expect(res.status).toBe(404);
    expect(eqCalls).toEqual([]);
  });

  it("con token: cerca il QR anche per token", async () => {
    const res = await call("?t=tok123");
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["qr_token", "tok123"]);
  });

  it("token sbagliato: 404", async () => {
    row = null;
    expect((await call("?t=sbagliato")).status).toBe(404);
  });
});
