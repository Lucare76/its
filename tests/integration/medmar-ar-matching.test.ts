import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as getMatching, POST as postMatching } from "@/app/api/medmar-ar/matching/route";
import { POST as createTicket } from "@/app/api/medmar-ar/tickets/route";
import { makeNextRequest, json } from "./helpers/client";
import { createTestContext, seedHotel, seedService, type TestContext } from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Medmar Test" });
});

afterAll(async () => {
  if (ctx) {
    await ctx.cleanup();
  }
});

describe("medmar-ar matching", () => {
  it("trova anche le partenze salvate nel dominio departure_date", async () => {
    const bookingId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      customer_name: "Cliente Partenza",
      direction: "departure",
      date: "2026-07-01",
      departure_date: "2026-07-04",
      time: "15:10",
      departure_time: "17:00",
      return_time: "17:00",
      vessel: "MEDMAR Napoli",
      booking_service_kind: "transfer_port_hotel",
      status: "new",
      is_draft: false,
      pax: 2,
    });

    const createReq = makeNextRequest("POST", {
      voucher_number: "MED-DEP-001",
      travel_date: "2026-07-04",
      route: "napoli_ischia",
      pax_count: 2,
      ticket_mode: "single_return",
      return_time: "17:00",
      archive_for_recovery: true,
      source: "manual",
    }, ctx.token, "http://localhost:3010/api/medmar-ar/tickets");

    const createRes = await createTicket(createReq);
    expect(createRes.status).toBe(200);

    const listReq = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/medmar-ar/matching");
    const listRes = await getMatching(listReq);
    const body = await json<{
      ok: boolean;
      opportunities: Array<{
        leg: { leg_route: string; leg_time: string | null };
        matched_bookings: Array<{ id: string }>;
      }>;
    }>(listRes);

    expect(listRes.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    const opportunity = body.opportunities.find((item) => item.leg.leg_route === "ischia_napoli" && item.leg.leg_time === "17:00");
    expect(opportunity).toBeTruthy();
    expect(opportunity?.matched_bookings.map((item) => item.id)).toContain(bookingId);
  });

  it("accetta la riassegnazione quando la partenza matcha tramite departure_date", async () => {
    const bookingId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      customer_name: "Cliente Riassegnazione",
      direction: "departure",
      date: "2026-07-02",
      departure_date: "2026-07-06",
      time: "14:40",
      departure_time: "18:15",
      return_time: "18:15",
      vessel: "MEDMAR Napoli",
      booking_service_kind: "transfer_port_hotel",
      status: "new",
      is_draft: false,
      pax: 3,
    });

    const createReq = makeNextRequest("POST", {
      voucher_number: "MED-DEP-002",
      travel_date: "2026-07-06",
      route: "napoli_ischia",
      pax_count: 3,
      ticket_mode: "single_return",
      return_time: "18:15",
      archive_for_recovery: true,
      source: "manual",
    }, ctx.token, "http://localhost:3010/api/medmar-ar/tickets");

    const createRes = await createTicket(createReq);
    const createBody = await json<{ ok: boolean; ticket: { id: string } }>(createRes);

    expect(createRes.status).toBe(200);
    expect(createBody.ok).toBe(true);

    const { data: leg } = await ctx.admin
      .from("medmar_ar_ticket_legs")
      .select("id, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("ticket_id", createBody.ticket.id)
      .eq("leg_type", "return")
      .maybeSingle();

    expect(leg?.status).toBe("available_for_reassignment");

    const reassignReq = makeNextRequest("POST", {
      leg_id: leg!.id,
      booking_id: bookingId,
    }, ctx.token, "http://localhost:3010/api/medmar-ar/matching");

    const reassignRes = await postMatching(reassignReq);
    const reassignBody = await json<{ ok: boolean; booking_id: string }>(reassignRes);

    expect(reassignRes.status).toBe(200);
    expect(reassignBody.ok).toBe(true);
    expect(reassignBody.booking_id).toBe(bookingId);

    const { data: updatedLeg } = await ctx.admin
      .from("medmar_ar_ticket_legs")
      .select("status, reassigned_booking_id")
      .eq("id", leg!.id)
      .eq("tenant_id", ctx.tenantId)
      .maybeSingle();

    expect(updatedLeg?.status).toBe("reassigned");
    expect(updatedLeg?.reassigned_booking_id).toBe(bookingId);
  });
});
