import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestContext,
  seedDriver,
  seedHotel,
  seedService,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;
const extraUserIds: string[] = [];

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
    name: "Hotel Cancellation Test",
    zone: "Ischia Porto",
  });
});

afterAll(async () => {
  await ctx.admin.from("ops_audit_events").delete().eq("tenant_id", ctx.tenantId);
  await ctx.cleanup();
  for (const userId of extraUserIds) {
    await ctx.admin.auth.admin.deleteUser(userId);
  }
});

describe("cancellation requests", () => {
  it("approvazione cancellazione elimina gli assignments del servizio e registra audit", async () => {
    const driverUserId = await seedDriver(ctx.admin, ctx.tenantId, extraUserIds);
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-08-01",
      time: "10:00",
      status: "assigned",
      customer_name: "Ghost Assignment Test",
    });

    const { error: assignmentError } = await ctx.admin.from("assignments").insert({
      id: randomUUID(),
      tenant_id: ctx.tenantId,
      service_id: serviceId,
      driver_user_id: driverUserId,
      vehicle_label: "Van Test",
    });
    expect(assignmentError).toBeNull();

    const cancellationId = randomUUID();
    const { error: cancellationError } = await ctx.admin.from("cancellation_requests").insert({
      id: cancellationId,
      tenant_id: ctx.tenantId,
      service_id: serviceId,
      requested_by_role: "admin",
      requested_by_user_id: ctx.userId,
      cancel_legs: "both",
      penalty_cents: 0,
      status: "pending_agency_approval",
    });
    expect(cancellationError).toBeNull();

    const { data: result, error: finalizeError } = await ctx.admin.rpc("finalize_cancellation_request", {
      p_request_id: cancellationId,
      p_tenant_id: ctx.tenantId,
      p_user_id: ctx.userId,
      p_status: "approved",
      p_agency_response: "accept",
      p_agency_response_note: null,
      p_agency_counter_cents: null,
      p_penalty_cents: 0,
      p_penalty_note: null,
    });

    expect(finalizeError).toBeNull();
    expect(result?.[0]?.assignments_cleared).toBe(1);

    const { count } = await ctx.admin
      .from("assignments")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId)
      .eq("service_id", serviceId);
    expect(count).toBe(0);

    const { data: request } = await ctx.admin
      .from("cancellation_requests")
      .select("status")
      .eq("id", cancellationId)
      .maybeSingle();
    expect(request?.status).toBe("approved");

    const { data: audit } = await ctx.admin
      .from("ops_audit_events")
      .select("event, service_id, details")
      .eq("tenant_id", ctx.tenantId)
      .eq("service_id", serviceId)
      .eq("event", "assignment_cleared_on_cancellation")
      .maybeSingle();
    expect(audit?.details).toMatchObject({ assignments_cleared: 1 });
  });
});
