import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Call = { method: string; args: unknown[] };
let calls: Call[];
let quoteRow: Record<string, unknown> | null;
let claimRow: Record<string, unknown> | null;
let serviceInsertError: unknown;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const ops: string[] = [];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "update", "insert", "in", "limit"]) {
        q[m] = (...args: unknown[]) => { calls.push({ method: `${table}.${m}`, args }); ops.push(m); return q; };
      }
      const result = () => {
        if (table === "quotes" && ops.includes("update")) return { data: claimRow, error: null };
        if (table === "quotes") return { data: quoteRow, error: null };
        if (table === "services" && ops.includes("insert")) return { data: [{ id: "svc-1" }], error: serviceInsertError };
        return { data: null, error: null };
      };
      q.maybeSingle = () => Promise.resolve(result());
      q.single = () => Promise.resolve(result());
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result()).then(ok);
      return q;
    },
  }),
}));

import { GET, POST } from "@/app/api/ops/quotes/respond/route";

const post = (body: unknown) => POST(new NextRequest("https://its.test/api/ops/quotes/respond", { method: "POST", body: JSON.stringify(body) }));
const quoteUpdates = () => calls.filter((c) => c.method === "quotes.update").map((c) => c.args[0]);

beforeEach(() => {
  calls = []; serviceInsertError = null;
  quoteRow = { id: "q1", tenant_id: "t1", status: "sent", valid_until: null, route_label: "Napoli → Ischia", service_kind: "transfer", price_cents: 10000, currency: "EUR" };
  claimRow = { id: "q1" };
});

describe("risposta preventivo", () => {
  it("GET non modifica nulla e porta alla pagina", async () => {
    const res = await GET(new NextRequest("https://its.test/api/ops/quotes/respond?token=abc&action=accepted"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://its.test/quote/respond?token=abc");
    expect(calls).toEqual([]);
  });

  it("rifiuto: passaggio atomico sent -> rejected", async () => {
    const res = await post({ token: "abc", action: "rejected" });
    expect(res.status).toBe(200);
    expect(quoteUpdates()).toEqual([{ status: "rejected" }]);
    expect(calls).toContainEqual({ method: "quotes.eq", args: ["status", "sent"] });
  });

  it("già risposto da un'altra richiesta: 409, nessun servizio creato", async () => {
    claimRow = null;
    const res = await post({ token: "abc", action: "accepted" });
    expect(res.status).toBe(409);
    expect(calls.some((c) => c.method === "services.insert")).toBe(false);
  });

  it("preventivo non più in stato inviato: 409", async () => {
    quoteRow = { ...quoteRow, status: "accepted" };
    const res = await post({ token: "abc", action: "accepted" });
    expect(res.status).toBe(409);
    expect(quoteUpdates()).toEqual([]);
  });

  it("scaduto: non si accetta", async () => {
    quoteRow = { ...quoteRow, valid_until: "2020-01-01" };
    const res = await post({ token: "abc", action: "accepted" });
    expect(res.status).toBe(410);
    expect(quoteUpdates()).toEqual([]);
  });

  it("token sconosciuto: 404; azione non valida: 400", async () => {
    expect((await post({ token: "abc", action: "boh" })).status).toBe(400);
    quoteRow = null;
    expect((await post({ token: "abc", action: "rejected" })).status).toBe(404);
  });
});
