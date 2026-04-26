/**
 * Test di integrazione — POST /api/ops/piano-giorno/auto-assign
 *
 * Prerequisiti:
 *   - Supabase in esecuzione (locale: supabase start, oppure remote via .env.local)
 *   - Variabili d'ambiente caricate da .env.local (via setupFiles)
 *
 * Esecuzione:
 *   pnpm test:integration --reporter=verbose
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedVehicle,
  seedDriver,
  seedService,
  type TestContext,
} from "./helpers/seed";

const TEST_DATE = "2026-05-10";
const additionalUsers: string[] = [];
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  if (!ctx) return; // beforeAll potrebbe aver fallito (errore di rete, rate-limit)
  await ctx.cleanup();
  for (const uid of additionalUsers) {
    await ctx.admin.auth.admin.deleteUser(uid);
  }
});

describe("auto-assign — nessun servizio", () => {
  it("ritorna ok:true con assigned:0 se non ci sono servizi per la data", async () => {
    const req = makeNextRequest("POST", { date: "2099-01-01", mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number; trips: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBe(0);
    expect(body.trips).toBe(0);
  });

  it("risponde 401 senza token", async () => {
    const req = makeNextRequest("POST", { date: TEST_DATE, mode: "unassigned_only" }, "invalid");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });
});

describe("auto-assign — assegnazione arrivi", () => {
  let hotelId: string;

  beforeAll(async () => {
    hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel Moresco",
      zone: "Forio",
      lat: 40.7355,
      lng: 13.8675,
    });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 8", capacity: 8 });
    await seedDriver(ctx.admin, ctx.tenantId, additionalUsers);

    // Due arrivi nello stesso porto e finestra temporale → dovrebbero mergiare in 1 giro
    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "09:00",
      direction: "arrival",
      vessel: "SNAV",
      pax: 2,
      meeting_point: "Ischia Porto",
    });
    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "09:15",
      direction: "arrival",
      vessel: "Caremar",
      pax: 3,
      meeting_point: "Ischia Porto",
    });
  });

  it("assegna i servizi e crea almeno un giro", async () => {
    const req = makeNextRequest("POST", { date: TEST_DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number; trips: number; report: string[] }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(2);
    expect(body.trips).toBeGreaterThanOrEqual(1);
  });

  it("i servizi risultano nello stato 'assigned' in DB", async () => {
    const { data } = await ctx.admin
      .from("services")
      .select("id, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", TEST_DATE)
      .eq("direction", "arrival");

    expect(data).toBeDefined();
    expect(data!.length).toBeGreaterThanOrEqual(2);
    for (const svc of data!) {
      expect(svc.status).toBe("assigned");
    }
  });

  it("esistono trip_groups per la data", async () => {
    const { data } = await ctx.admin
      .from("trip_groups")
      .select("id, date, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", TEST_DATE)
      .eq("status", "active");

    expect(data).toBeDefined();
    expect(data!.length).toBeGreaterThanOrEqual(1);
  });

  it("mode regenerate_all annulla i giri esistenti e riassegna", async () => {
    const req = makeNextRequest(
      "POST",
      { date: TEST_DATE, mode: "regenerate_all" },
      ctx.token,
    );
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(2);

    // Dopo rigenera: nessun gruppo cancelled deve essere in stato active
    const { data: cancelled } = await ctx.admin
      .from("trip_groups")
      .select("id, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", TEST_DATE)
      .eq("status", "cancelled");
    expect(cancelled!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("auto-assign — partenze", () => {
  let hotelId: string;

  beforeAll(async () => {
    hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel San Montano",
      zone: "Lacco Ameno",
      lat: 40.758,
      lng: 13.8887,
    });

    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "14:00",
      direction: "departure",
      vessel: "SNAV",
      pax: 2,
      meeting_point: "Casamicciola",
      pickup_hotel: "13:30",
    });
  });

  it("assegna la partenza e crea un giro", async () => {
    const req = makeNextRequest("POST", { date: TEST_DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(1);
  });
});
