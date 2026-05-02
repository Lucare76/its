/**
 * Test di integrazione — Regole rigide di capienza veicolo in auto-assign
 *
 * Verifica che il POST /api/ops/piano-giorno/auto-assign rispetti:
 *  A) hotel_vehicle_limits.max_capacity: nessun mezzo > limite assegnato a quell'hotel
 *  B) memberships.max_vehicle_capacity: nessun mezzo > limite dell'autista assegnato
 *  C) splitting automatico del giro se i PAX totali superano il limite hotel
 *  D) limite combinato hotel + autista (il più restrittivo vince)
 *
 * Pattern: ogni describe usa una data diversa per isolamento totale tra suite.
 */
import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "@/app/api/ops/piano-giorno/auto-assign/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedVehicle,
  seedService,
  seedAvailabilityConfirmation,
  type TestContext,
} from "./helpers/seed";

// ─── Helper locale ────────────────────────────────────────────────────────────

async function seedHotelVehicleLimit(
  ctx: TestContext,
  hotelId: string,
  hotelName: string,
  maxCapacity: number,
): Promise<void> {
  const { error } = await ctx.admin.from("hotel_vehicle_limits").insert({
    tenant_id: ctx.tenantId,
    hotel_id: hotelId,
    hotel_name: hotelName,
    max_capacity: maxCapacity,
  });
  if (error) throw new Error(`seedHotelVehicleLimit: ${error.message}`);
}

async function seedDriverWithCapLimit(
  ctx: TestContext,
  additionalUserIds: string[],
  maxVehicleCapacity: number,
): Promise<string> {
  const email = `driver-caplimit-${Date.now()}-${randomUUID()}@test.invalid`;
  const password = randomUUID();
  const { data, error } = await ctx.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`seedDriverWithCapLimit user: ${error?.message}`);
  const driverUserId = data.user.id;
  additionalUserIds.push(driverUserId);

  const { error: memErr } = await ctx.admin.from("memberships").insert({
    tenant_id: ctx.tenantId,
    user_id: driverUserId,
    role: "driver",
    full_name: "Autista Limitato",
    max_vehicle_capacity: maxVehicleCapacity,
  });
  if (memErr) throw new Error(`seedDriverWithCapLimit membership: ${memErr.message}`);
  return driverUserId;
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Limite hotel: veicolo > max_capacity NON deve essere assegnato
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-assign — hotel_vehicle_limits: veicolo rispetta max_capacity", () => {
  const DATE = "2026-08-01";
  let ctx: TestContext;
  const additionalUserIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, DATE, ctx.userId);

    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel Strade Strette",
      zone: "Ischia Porto",
      lat: 40.7329,
      lng: 13.9477,
    });
    await seedHotelVehicleLimit(ctx, hotelId, "Hotel Strade Strette", 14);

    // Veicolo piccolo (entro limite) e veicolo grande (oltre limite)
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 8", capacity: 8 });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Bus 20", capacity: 20 });

    // Driver necessario per la selezione autisti
    await seedDriverWithCapLimit(ctx, additionalUserIds, 100); // nessun limite pratico

    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: DATE,
      time: "09:00",
      direction: "arrival",
      vessel: "SNAV Test",
      pax: 6,
      meeting_point: "Ischia Porto",
    });
  });

  afterAll(async () => {
    for (const uid of additionalUserIds) await ctx.admin.auth.admin.deleteUser(uid);
    await ctx.admin.from("hotel_vehicle_limits").delete().eq("tenant_id", ctx.tenantId);
    await ctx.cleanup();
  });

  it("auto-assign termina con successo", async () => {
    const req = makeNextRequest("POST", { date: DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number }>(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(1);
  });

  it("il veicolo assegnato ha capienza ≤ 14 (limite hotel)", async () => {
    const { data: groups } = await ctx.admin
      .from("trip_groups")
      .select("vehicle_label, vehicle_capacity")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", DATE)
      .eq("status", "active");

    expect(groups).not.toBeNull();
    expect(groups!.length).toBeGreaterThanOrEqual(1);

    for (const g of groups!) {
      // Il veicolo da 20 posti NON deve mai essere assegnato a questo hotel
      expect(g.vehicle_label).not.toBe("Bus 20");
      if (g.vehicle_capacity != null) {
        expect(g.vehicle_capacity).toBeLessThanOrEqual(14);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Limite hotel: gruppo PAX > limite → split in più giri
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-assign — hotel_vehicle_limits: split automatico se PAX > limite", () => {
  const DATE = "2026-08-02";
  let ctx: TestContext;
  const additionalUserIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, DATE, ctx.userId);

    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel Vicolo Stretto",
      zone: "Forio",
      lat: 40.7355,
      lng: 13.8675,
    });
    await seedHotelVehicleLimit(ctx, hotelId, "Hotel Vicolo Stretto", 14);

    // Solo un veicolo che rientra nel limite
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 14", capacity: 14 });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Bus 30", capacity: 30 });

    // Due autisti per poter assegnare giri multipli
    await seedDriverWithCapLimit(ctx, additionalUserIds, 100);
    await seedDriverWithCapLimit(ctx, additionalUserIds, 100);

    // Due servizi: pax=10 + pax=8 = 18 totale > limite 14 → devono diventare 2 giri
    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: DATE,
      time: "10:00",
      direction: "arrival",
      vessel: "Medmar",
      pax: 10,
      meeting_point: "Ischia Porto",
    });
    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: DATE,
      time: "10:10", // stessa finestra di merge (25 min)
      direction: "arrival",
      vessel: "Medmar",
      pax: 8,
      meeting_point: "Ischia Porto",
    });
  });

  afterAll(async () => {
    for (const uid of additionalUserIds) await ctx.admin.auth.admin.deleteUser(uid);
    await ctx.admin.from("hotel_vehicle_limits").delete().eq("tenant_id", ctx.tenantId);
    await ctx.cleanup();
  });

  it("crea almeno 2 giri (split per limite hotel 14)", async () => {
    const req = makeNextRequest("POST", { date: DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; trips: number; assigned: number }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBe(2);
    expect(body.trips).toBeGreaterThanOrEqual(2);
  });

  it("nessun giro usa il veicolo da 30 posti (sopra il limite hotel 14)", async () => {
    const { data: groups } = await ctx.admin
      .from("trip_groups")
      .select("vehicle_label, vehicle_capacity")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", DATE)
      .eq("status", "active");

    expect(groups!.length).toBeGreaterThanOrEqual(2);
    for (const g of groups!) {
      expect(g.vehicle_label).not.toBe("Bus 30");
    }
  });

  it("ogni giro ha pax ≤ limite hotel (14)", async () => {
    const { data: groups } = await ctx.admin
      .from("trip_groups")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", DATE)
      .eq("status", "active");

    for (const g of groups!) {
      const { data: assignments } = await ctx.admin
        .from("assignments")
        .select("service_id")
        .eq("group_id", g.id)
        .eq("tenant_id", ctx.tenantId);

      const serviceIds = assignments!.map((a) => a.service_id);
      const { data: services } = await ctx.admin
        .from("services")
        .select("pax")
        .in("id", serviceIds);

      const totalPax = services!.reduce((sum, s) => sum + (s.pax ?? 0), 0);
      expect(totalPax).toBeLessThanOrEqual(14);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Limite autista: veicolo > max_vehicle_capacity NON deve essere assegnato
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-assign — driver max_vehicle_capacity: veicolo rispetta limite autista", () => {
  const DATE = "2026-08-03";
  let ctx: TestContext;
  const additionalUserIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, DATE, ctx.userId);

    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel Normale",
      zone: "Ischia Porto",
      lat: 40.7329,
      lng: 13.9477,
    });
    // Nessun hotel_vehicle_limit → il limite viene solo dall'autista

    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 8", capacity: 8 });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Bus 25", capacity: 25 });

    // Autista con limite: può guidare massimo 8 posti
    await seedDriverWithCapLimit(ctx, additionalUserIds, 8);

    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: DATE,
      time: "11:00",
      direction: "arrival",
      vessel: "SNAV",
      pax: 5,
      meeting_point: "Ischia Porto",
    });
  });

  afterAll(async () => {
    for (const uid of additionalUserIds) await ctx.admin.auth.admin.deleteUser(uid);
    await ctx.cleanup();
  });

  it("auto-assign termina con successo", async () => {
    const req = makeNextRequest("POST", { date: DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number }>(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.assigned).toBeGreaterThanOrEqual(1);
  });

  it("il veicolo assegnato ha capienza ≤ 8 (limite autista)", async () => {
    const { data: groups } = await ctx.admin
      .from("trip_groups")
      .select("vehicle_label, vehicle_capacity")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", DATE)
      .eq("status", "active");

    expect(groups!.length).toBeGreaterThanOrEqual(1);
    for (const g of groups!) {
      expect(g.vehicle_label).not.toBe("Bus 25");
      if (g.vehicle_capacity != null) {
        expect(g.vehicle_capacity).toBeLessThanOrEqual(8);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Limite combinato hotel + autista: vince il più restrittivo
// ─────────────────────────────────────────────────────────────────────────────

describe("auto-assign — limite combinato hotel (14) + autista (10): vince il 10", () => {
  const DATE = "2026-08-04";
  let ctx: TestContext;
  const additionalUserIds: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    await seedAvailabilityConfirmation(ctx.admin, ctx.tenantId, DATE, ctx.userId);

    const hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
      name: "Hotel Misto Limite",
      zone: "Casamicciola",
      lat: 40.7507,
      lng: 13.9013,
    });
    await seedHotelVehicleLimit(ctx, hotelId, "Hotel Misto Limite", 14);

    // Tre veicoli: 8, 12, 20 posti
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 8", capacity: 8 });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van 12", capacity: 12 });
    await seedVehicle(ctx.admin, ctx.tenantId, { label: "Bus 20", capacity: 20 });

    // Autista con limite 10: hardMax = min(14, 10) = 10
    await seedDriverWithCapLimit(ctx, additionalUserIds, 10);

    await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: DATE,
      time: "14:00",
      direction: "arrival",
      vessel: "Caremar",
      pax: 7,
      meeting_point: "Casamicciola",
    });
  });

  afterAll(async () => {
    for (const uid of additionalUserIds) await ctx.admin.auth.admin.deleteUser(uid);
    await ctx.admin.from("hotel_vehicle_limits").delete().eq("tenant_id", ctx.tenantId);
    await ctx.cleanup();
  });

  it("auto-assign termina con successo", async () => {
    const req = makeNextRequest("POST", { date: DATE, mode: "unassigned_only" }, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok: boolean; assigned: number }>(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("veicolo assegnato è ≤ 10 posti (limite autista più restrittivo rispetto al limite hotel 14)", async () => {
    const { data: groups } = await ctx.admin
      .from("trip_groups")
      .select("vehicle_label, vehicle_capacity")
      .eq("tenant_id", ctx.tenantId)
      .eq("date", DATE)
      .eq("status", "active");

    expect(groups!.length).toBeGreaterThanOrEqual(1);
    for (const g of groups!) {
      // Van 12 e Bus 20 non devono essere assegnati
      expect(g.vehicle_label).not.toBe("Van 12");
      expect(g.vehicle_label).not.toBe("Bus 20");
      if (g.vehicle_capacity != null) {
        expect(g.vehicle_capacity).toBeLessThanOrEqual(10);
      }
    }
  });
});
