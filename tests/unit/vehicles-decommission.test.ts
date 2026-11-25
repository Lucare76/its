import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
vi.mock("@/lib/server/driver-registry", () => ({
  deactivateDriverProfileAndAccess: vi.fn(), ensureDriverAccessForProfile: vi.fn(),
  listDriverRegistry: vi.fn(async () => []), normalizeDriverPassword: (v: string) => v ?? "",
  syncMembershipNameFromProfile: vi.fn(),
}));
import { POST } from "@/app/api/ops/vehicles/route";

const TENANT = "11111111-1111-4111-8111-111111111111";
const VEHICLE = "33333333-3333-4333-8333-333333333333";

type Call = { table: string; method: string; args: unknown[] };
let calls: Call[];
let state: { vehicleExists: boolean; changed: boolean; counts: Record<string, number>; updateError: string | null };

function admin() {
  return {
    from(table: string) {
      const ops: string[] = [];
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "is", "not", "order", "gte", "update", "insert", "delete"]) {
        query[method] = (...args: unknown[]) => { calls.push({ table, method, args }); ops.push(method); return query; };
      }
      const result = () => {
        if (table !== "vehicles") return { data: null, error: null, count: state.counts[table] ?? 0 };
        if (ops.includes("update")) {
          if (state.updateError) return { data: null, error: { message: state.updateError } };
          return { data: state.changed ? { id: VEHICLE } : null, error: null };
        }
        if (ops.includes("delete")) return { data: null, error: null };
        if (ops.includes("eq") && calls.some((c) => c.table === "vehicles" && c.method === "eq" && c.args[0] === "id")) {
          return { data: state.vehicleExists ? { id: VEHICLE } : null, error: null };
        }
        return { data: [], error: null };
      };
      query.maybeSingle = () => Promise.resolve(result());
      query.then = (ok: (value: unknown) => unknown) => Promise.resolve(result()).then(ok);
      return query;
    },
  };
}

function as(role: string) {
  mocks.authorize.mockResolvedValue({ admin: admin(), user: { id: "user-1" }, membership: { tenant_id: TENANT, role } });
}
const post = (body: unknown) => POST(new NextRequest("https://its.test/api/ops/vehicles", { method: "POST", body: JSON.stringify(body) }));
const vehicleUpdates = () => calls.filter((c) => c.table === "vehicles" && c.method === "update").map((c) => c.args[0] as Record<string, unknown>);

beforeEach(() => {
  calls = [];
  state = { vehicleExists: true, changed: true, counts: {}, updateError: null };
  as("operator");
});

describe("dismissione mezzo", () => {
  const body = { action: "decommission_vehicle", id: VEHICLE, decommissioned_at: "2026-11-25", reason: "sold", note: "Venduto a Rossi" };

  it("disattiva, toglie il QR e registra data, motivo e autore", async () => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(vehicleUpdates()[0]).toMatchObject({
      active: false, qr_token: null, decommissioned_at: "2026-11-25", decommission_reason: "sold",
      decommission_note: "Venduto a Rossi", decommissioned_by: "user-1",
    });
    expect(calls).toContainEqual({ table: "vehicles", method: "eq", args: ["tenant_id", TENANT] });
    expect(calls).toContainEqual({ table: "vehicles", method: "is", args: ["decommissioned_at", null] });
  });

  it("motivo 'altro' senza nota: 400", async () => {
    expect((await post({ ...body, reason: "other", note: "  " })).status).toBe(400);
    expect(vehicleUpdates()).toEqual([]);
  });

  it("data o motivo non validi: 400", async () => {
    expect((await post({ ...body, decommissioned_at: "25/11/2026" })).status).toBe(400);
    expect((await post({ ...body, reason: "rubato" })).status).toBe(400);
  });

  it("già dismesso o di un altro tenant: 409", async () => {
    state.changed = false;
    expect((await post(body)).status).toBe(409);
  });

  it("supervisore non può dismettere", async () => {
    as("supervisor");
    expect((await post(body)).status).toBe(403);
  });
});

describe("annulla dismissione", () => {
  it("solo admin; nuovo QR e campi azzerati, il mezzo resta inattivo", async () => {
    expect((await post({ action: "restore_vehicle", id: VEHICLE })).status).toBe(403);
    as("admin");
    const res = await post({ action: "restore_vehicle", id: VEHICLE });
    expect(res.status).toBe(200);
    const update = vehicleUpdates()[0];
    expect(update).toMatchObject({ decommissioned_at: null, decommission_reason: null, decommissioned_by: null });
    expect(String(update.qr_token)).toMatch(/^[0-9a-f]{32}$/);
    expect(update).not.toHaveProperty("active");
  });
});

describe("eliminazione definitiva", () => {
  it("rifiutata se il mezzo ha uno storico, con l'elenco di cosa andrebbe perso", async () => {
    as("admin");
    state.counts = { vehicle_fuel: 12, vehicle_maintenance: 3, vehicle_km_logs: 40 };
    const res = await post({ action: "delete_vehicle", id: VEHICLE });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("12 rifornimenti");
    expect(json.error).toContain("Dismetti mezzo");
    expect(json.history).toEqual({ rifornimenti: 12, manutenzioni: 3, "chilometri dei turni": 40 });
    expect(calls.some((c) => c.table === "vehicles" && c.method === "delete")).toBe(false);
  });

  it("km dei turni contati per mezzo (la tabella non ha tenant_id), le altre anche per tenant", async () => {
    as("admin");
    await post({ action: "delete_vehicle", id: VEHICLE });
    expect(calls.filter((c) => c.table === "vehicle_km_logs" && c.method === "eq")).toEqual([
      { table: "vehicle_km_logs", method: "eq", args: ["vehicle_id", VEHICLE] },
    ]);
    expect(calls).toContainEqual({ table: "vehicle_fuel", method: "eq", args: ["tenant_id", TENANT] });
  });

  it("permessa per un mezzo senza storico", async () => {
    as("admin");
    expect((await post({ action: "delete_vehicle", id: VEHICLE })).status).toBe(200);
    expect(calls).toContainEqual({ table: "vehicles", method: "delete", args: [] });
  });

  it("mezzo di un altro tenant: 404, nessun conteggio né eliminazione", async () => {
    as("admin");
    state.vehicleExists = false;
    expect((await post({ action: "delete_vehicle", id: VEHICLE })).status).toBe(404);
    expect(calls.some((c) => c.table === "vehicle_fuel")).toBe(false);
  });
});

describe("riattivazione bloccata dal database", () => {
  it("rendere attivo un mezzo dismesso dà un messaggio chiaro (409)", async () => {
    state.updateError = 'new row for relation "vehicles" violates check constraint "vehicles_decommissioned_inactive_check"';
    const res = await post({ action: "toggle_vehicle_active", id: VEHICLE, active: true });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("Mezzo dismesso");
  });
});
