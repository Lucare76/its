import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "@/app/api/ops/piano-giorno/trips/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedAvailabilityConfirmation,
  seedDriver,
  seedHotel,
  seedService,
  seedVehicle,
  type TestContext,
} from "./helpers/seed";

const TEST_DATE = "2026-05-13";
const additionalUsers: string[] = [];
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  if (!ctx) return;
  await ctx.cleanup();
  for (const uid of additionalUsers) {
    await ctx.admin.auth.admin.deleteUser(uid);
  }
});

describe("piano-giorno/trips — blocker server-side", () => {
  it("blocca la creazione di un giro se la disponibilita non e confermata", async () => {
    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel No Confirmation" });
    const driverId = await seedDriver(ctx.admin, ctx.tenantId, additionalUsers);
    const vehicleId = await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van No Confirmation", capacity: 8 });
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "08:30",
      direction: "arrival",
      pax: 4,
    });

    const req = makeNextRequest("POST", {
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [serviceId],
      driver_user_id: driverId,
      vehicle_id: vehicleId,
      vehicle_capacity: 8,
      vehicle_label: "Van No Confirmation",
    }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; error?: string }>(res);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Disponibilita");
  });

  it("blocca la creazione di un giro senza autista", async () => {
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, TEST_DATE, ctx.userId);
    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel No Driver" });
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "09:00",
      direction: "arrival",
      pax: 4,
    });

    const req = makeNextRequest("POST", {
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [serviceId],
      driver_user_id: null,
    }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; error?: string }>(res);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("autista");
  });

  it("blocca l'overbooking del mezzo in creazione manuale", async () => {
    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Overbooking" });
    const driverId = await seedDriver(ctx.admin, ctx.tenantId, additionalUsers);
    const vehicleId = await seedVehicle(ctx.admin, ctx.tenantId, { label: "City Car", capacity: 4 });
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "10:00",
      direction: "arrival",
      pax: 6,
    });

    const req = makeNextRequest("POST", {
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [serviceId],
      driver_user_id: driverId,
      vehicle_id: vehicleId,
      vehicle_capacity: 4,
      vehicle_label: "City Car",
    }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; error?: string }>(res);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("Overbooking");
  });

  it("blocca la creazione se l'autista e fuori fascia disponibilita", async () => {
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, TEST_DATE, ctx.userId);
    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Driver Window" });
    const driverId = await seedDriver(ctx.admin, ctx.tenantId, additionalUsers);
    const vehicleId = await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van Driver Window", capacity: 8 });
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: TEST_DATE,
      time: "14:50",
      direction: "arrival",
      pax: 1,
    });
    await ctx.admin.from("driver_daily_availability").insert({
      tenant_id: ctx.tenantId,
      date: TEST_DATE,
      driver_user_id: driverId,
      available: true,
      available_from: "16:00",
      available_to: "23:00",
    });

    const req = makeNextRequest("POST", {
      action: "create_trip",
      date: TEST_DATE,
      service_ids: [serviceId],
      driver_user_id: driverId,
      vehicle_id: vehicleId,
      vehicle_capacity: 8,
      vehicle_label: "Van Driver Window",
    }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; error?: string }>(res);

    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Autista non disponibile in questa fascia oraria.");
  });
});
