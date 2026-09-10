import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestContext, seedHotel, seedService, type TestContext } from "./helpers/seed";

/**
 * P1 — atomicità PATCH/DELETE shuttle schedules (migration 0276).
 *
 * Questi test chiamano le RPC direttamente (public.patch_shuttle_schedule /
 * public.delete_shuttle_schedule) contro un vero Postgres — un test unitario
 * con un mock JS di `.rpc()` può provare che la rotta chiami la funzione con
 * i parametri giusti, ma NON può provare che una transazione Postgres faccia
 * davvero rollback: per quello serve un DB reale (vedi FASE 7 del task — "non
 * simulare l'atomicità solo a livello mock se è possibile testarla
 * davvero"). Richiede l'infrastruttura di tests/integration/ (vedi
 * tests/integration/helpers/env.ts): NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY (o INTEGRATION_SUPABASE_URL / _SERVICE_ROLE_KEY
 * per un'istanza locale via `supabase start`).
 *
 * Ogni test opera in un tenant dedicato, creato ed eliminato da
 * createTestContext(); non tocca mai dati di altri tenant.
 */

const SCHEDULE_KEY = {
  direction: "departure",
  departure_time: "09:30",
  customer_name: "Hotel Integration Test",
  vessel: "Navetta",
  hotel_id: null as string | null,
  meeting_point: null as string | null,
  booking_service_kind: "navetta",
};

function isoDate(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function newRow(tenantId: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: tenantId,
    date,
    time: SCHEDULE_KEY.departure_time,
    service_type: "transfer",
    direction: SCHEDULE_KEY.direction,
    customer_name: SCHEDULE_KEY.customer_name,
    pax: 1,
    hotel_id: SCHEDULE_KEY.hotel_id,
    vessel: SCHEDULE_KEY.vessel,
    booking_service_kind: SCHEDULE_KEY.booking_service_kind,
    meeting_point: SCHEDULE_KEY.meeting_point,
    notes: "",
    phone: "",
    status: "new",
    is_draft: false,
    ...overrides,
  };
}

function patchArgs(ctx: TestContext, newRows: Array<Record<string, unknown>>) {
  return {
    p_tenant_id: ctx.tenantId,
    p_today: isoDate(0),
    p_old_direction: SCHEDULE_KEY.direction,
    p_old_departure_time: SCHEDULE_KEY.departure_time,
    p_old_customer_name: SCHEDULE_KEY.customer_name,
    p_old_vessel: SCHEDULE_KEY.vessel,
    p_old_hotel_id: SCHEDULE_KEY.hotel_id,
    p_old_meeting_point: SCHEDULE_KEY.meeting_point,
    p_old_booking_service_kind: SCHEDULE_KEY.booking_service_kind,
    p_new_rows: newRows,
  };
}

function deleteArgs(ctx: TestContext) {
  return {
    p_tenant_id: ctx.tenantId,
    p_today: isoDate(0),
    p_old_direction: SCHEDULE_KEY.direction,
    p_old_departure_time: SCHEDULE_KEY.departure_time,
    p_old_customer_name: SCHEDULE_KEY.customer_name,
    p_old_vessel: SCHEDULE_KEY.vessel,
    p_old_hotel_id: SCHEDULE_KEY.hotel_id,
    p_old_meeting_point: SCHEDULE_KEY.meeting_point,
    p_old_booking_service_kind: SCHEDULE_KEY.booking_service_kind,
  };
}

describe("RPC public.patch_shuttle_schedule / public.delete_shuttle_schedule — atomicità (migration 0276)", () => {
  let ctx: TestContext;
  let otherCtx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    otherCtx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
    await otherCtx.cleanup();
  });

  it("1. PATCH completo riuscito: righe future cancellate e rigenerate in un'unica chiamata", async () => {
    const oldId = await seedService(ctx.admin, ctx.tenantId, await seedHotel(ctx.admin, ctx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });

    const { data, error } = await ctx.admin.rpc("patch_shuttle_schedule", patchArgs(ctx, [newRow(ctx.tenantId, isoDate(3))]));
    expect(error).toBeNull();
    const result = data?.[0];
    expect(result.deleted_count).toBe(1);
    expect(result.inserted_count).toBe(1);

    const { data: remaining } = await ctx.admin
      .from("services")
      .select("id, date")
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_name", SCHEDULE_KEY.customer_name);
    expect(remaining?.some((r) => r.id === oldId)).toBe(false);
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.date).toBe(isoDate(3));
  });

  it("2. DELETE completo riuscito: righe future cancellate", async () => {
    await seedService(ctx.admin, ctx.tenantId, await seedHotel(ctx.admin, ctx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });

    const { data, error } = await ctx.admin.rpc("delete_shuttle_schedule", deleteArgs(ctx));
    expect(error).toBeNull();
    expect(data?.[0]?.deleted_count).toBe(1);

    const { data: remaining } = await ctx.admin
      .from("services")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_name", SCHEDULE_KEY.customer_name);
    expect(remaining).toHaveLength(0);
  });

  it("3. PATCH con input non valido a metà (riga senza 'date') → rollback totale: la riga esistente resta intatta", async () => {
    const existingId = await seedService(ctx.admin, ctx.tenantId, await seedHotel(ctx.admin, ctx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });

    const malformedRows = [newRow(ctx.tenantId, isoDate(3)), { ...newRow(ctx.tenantId, isoDate(4)), date: undefined }];
    const { error } = await ctx.admin.rpc("patch_shuttle_schedule", patchArgs(ctx, malformedRows));
    expect(error).not.toBeNull();

    // Rollback totale: né la delete né alcun insert devono essere rimasti.
    const { data: remaining } = await ctx.admin
      .from("services")
      .select("id, date")
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_name", SCHEDULE_KEY.customer_name);
    expect(remaining).toHaveLength(1);
    expect(remaining?.[0]?.id).toBe(existingId);
  });

  it("4. DELETE con corsa già assegnata → guard bloccante, nessuna cancellazione (rollback totale)", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, await seedHotel(ctx.admin, ctx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });
    const { error: assignErr } = await ctx.admin
      .from("assignments")
      .insert({ id: randomUUID(), tenant_id: ctx.tenantId, service_id: serviceId, driver_user_id: ctx.userId, vehicle_label: "Test Vehicle" });
    if (assignErr) throw new Error(`seed assignment: ${assignErr.message}`);

    const { error } = await ctx.admin.rpc("delete_shuttle_schedule", deleteArgs(ctx));
    expect(error?.message).toBe("SHUTTLE_HAS_OPERATIONAL_SERVICES");

    const { data: remaining } = await ctx.admin.from("services").select("id").eq("id", serviceId);
    expect(remaining).toHaveLength(1);

    await ctx.admin.from("assignments").delete().eq("service_id", serviceId);
  });

  it("5. Tenant isolation: PATCH di un tenant non tocca la riga identica di un altro tenant", async () => {
    await seedService(ctx.admin, ctx.tenantId, await seedHotel(ctx.admin, ctx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });
    const otherServiceId = await seedService(otherCtx.admin, otherCtx.tenantId, await seedHotel(otherCtx.admin, otherCtx.tenantId), {
      date: isoDate(2),
      direction: SCHEDULE_KEY.direction,
      time: SCHEDULE_KEY.departure_time,
      customer_name: SCHEDULE_KEY.customer_name,
      vessel: SCHEDULE_KEY.vessel,
      hotel_id: null,
      meeting_point: null,
      booking_service_kind: "navetta",
      status: "new",
    });

    const { error } = await ctx.admin.rpc("delete_shuttle_schedule", deleteArgs(ctx));
    expect(error).toBeNull();

    const { data: otherRemaining } = await otherCtx.admin.from("services").select("id").eq("id", otherServiceId);
    expect(otherRemaining).toHaveLength(1);
  });

  it("6. Il tenant di un altro tenant non compare mai nella risposta della RPC (p_tenant_id sempre esplicito)", async () => {
    const { data, error } = await ctx.admin.rpc("patch_shuttle_schedule", patchArgs(ctx, [newRow(ctx.tenantId, isoDate(5))]));
    expect(error).toBeNull();
    expect(JSON.stringify(data)).not.toContain(otherCtx.tenantId);
  });
});
