import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createBooking } from "@/app/api/ops/new-booking/route";
import { GET as listBookingQr } from "@/app/api/bookings/[id]/qr-codes/route";
import { POST as generateBookingQr } from "@/app/api/bookings/[id]/qr-codes/generate/route";
import { GET as validateBookingQr } from "@/app/api/qr/bus/[bookingId]/[direction]/[token]/route";
import { POST as useBookingQr } from "@/app/api/qr/bus/[bookingId]/[direction]/[token]/use/route";
import { json, makeNextRequest } from "./helpers/client";
import { createTestContext, seedHotel, seedService, type TestContext } from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;
let roundTripBookingId = "";

const BUS_PAYLOAD = {
  customer_first_name: "Lucia",
  customer_last_name: "Verdi",
  customer_phone: "+39 333 1112233",
  customer_email: "lucia.verdi@test.invalid",
  pax: 2,
  hotel_id: "",
  booking_service_kind: "bus_city_hotel",
  arrival_date: "2026-06-21",
  arrival_time: "09:30",
  departure_date: "2026-06-28",
  departure_time: "17:15",
  transport_code: "LINEA_ROMA",
  transport_code_return: "LINEA_ROMA_R",
  bus_city_origin: "Roma Tiburtina",
  include_ferry_tickets: false,
  ferry_outbound_code: "",
  ferry_return_code: "",
  excursion_title: "",
  notes: "Test QR bus",
  agency_id: "",
  agency_quoted_price_cents: null,
  trip_leg: "round_trip",
  pickup_time_outbound: "10:00",
  pickup_time_return: "16:30",
  hotel_dest_id: "",
};

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel QR Bus" });
  BUS_PAYLOAD.hotel_id = hotelId;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("bus booking qr codes", () => {
  it("crea automaticamente i QR outbound e return su nuova prenotazione bus", async () => {
    const req = makeNextRequest("POST", BUS_PAYLOAD, ctx.token, "http://localhost:3010/api/ops/new-booking");
    const res = await createBooking(req);
    const body = await json<{ id?: string; id_return?: string; ok?: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();
    expect(body.id_return).toBeTruthy();

    const { data, error } = await ctx.admin
      .from("booking_qr_codes")
      .select("booking_id, direction, service_date, qr_token, status")
      .eq("tenant_id", ctx.tenantId)
      .eq("booking_id", body.id!);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    expect(data?.map((row) => row.direction).sort()).toEqual(["outbound", "return"]);
    expect(data?.every((row) => row.qr_token && row.status === "active")).toBe(true);
    roundTripBookingId = body.id!;
  });

  it("non crea il QR return se manca la tratta di ritorno", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      booking_service_kind: "bus_city_hotel",
      service_type_code: "bus_line",
      bus_city_origin: "Napoli",
      arrival_date: "2026-07-05",
      arrival_time: "08:10",
      departure_date: null,
      departure_time: null,
      transport_code: "LINEA_NAPOLI",
    });

    const req = makeNextRequest("POST", {}, ctx.token, `http://localhost:3010/api/bookings/${serviceId}/qr-codes/generate`);
    const res = await generateBookingQr(req, { params: Promise.resolve({ id: serviceId }) });
    const body = await json<{ bookingId: string; codes: Array<{ direction: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.bookingId).toBe(serviceId);
    expect(body.codes).toHaveLength(1);
    expect(body.codes[0]?.direction).toBe("outbound");
  });

  it("valida correttamente il token QR", async () => {
    const { data: row } = await ctx.admin
      .from("booking_qr_codes")
      .select("booking_id, direction, qr_token")
      .eq("tenant_id", ctx.tenantId)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect(row?.booking_id).toBeTruthy();
    expect(row?.qr_token).toBeTruthy();

    const res = await validateBookingQr(
      new NextRequest(`http://localhost:3010/api/qr/bus/${row!.booking_id}/${row!.direction}/${row!.qr_token}`),
      { params: Promise.resolve({ bookingId: row!.booking_id, direction: row!.direction, token: row!.qr_token }) }
    );
    const body = await json<{ state: string; booking?: { customerName?: string } }>(res);

    expect(res.status).toBe(200);
    expect(body.state).toBe("valid");
    expect(body.booking?.customerName).toBeTruthy();
  });

  it("non duplica i QR quando rilancio la generazione", async () => {
    // Usa la prenotazione A/R creata nel primo test (che ha outbound + return)
    // Non si usa "latest outbound by created_at" perché test precedenti creano QR
    // di servizi solo-andata, inquinando l'ordinamento temporale.
    expect(roundTripBookingId).toBeTruthy();

    const req = makeNextRequest("POST", {}, ctx.token, `http://localhost:3010/api/bookings/${roundTripBookingId}/qr-codes/generate`);
    const res = await generateBookingQr(req, { params: Promise.resolve({ id: roundTripBookingId }) });
    expect(res.status).toBe(200);

    const { data, error } = await ctx.admin
      .from("booking_qr_codes")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("booking_id", roundTripBookingId);

    expect(error).toBeNull();
    expect(data).toHaveLength(2);
  });

  it("marca il QR come usato", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      booking_service_kind: "bus_city_hotel",
      service_type_code: "bus_line",
      bus_city_origin: "Salerno",
      arrival_date: "2026-07-12",
      arrival_time: "09:00",
      departure_date: null,
      departure_time: null,
      transport_code: "LINEA_SALERNO",
    });

    await generateBookingQr(
      makeNextRequest("POST", {}, ctx.token, `http://localhost:3010/api/bookings/${serviceId}/qr-codes/generate`),
      { params: Promise.resolve({ id: serviceId }) }
    );

    const { data: qrRow } = await ctx.admin
      .from("booking_qr_codes")
      .select("booking_id, direction, qr_token")
      .eq("tenant_id", ctx.tenantId)
      .eq("booking_id", serviceId)
      .eq("direction", "outbound")
      .maybeSingle();

    const res = await useBookingQr(
      makeNextRequest("POST", undefined, ctx.token, `http://localhost:3010/api/qr/bus/${serviceId}/outbound/${qrRow!.qr_token}/use`),
      { params: Promise.resolve({ bookingId: serviceId, direction: "outbound", token: qrRow!.qr_token }) }
    );
    const body = await json<{ state: string; qrCode?: { status?: string; used_at?: string | null } }>(res);

    expect(res.status).toBe(200);
    expect(body.state).toBe("already_used");
    expect(body.qrCode?.status).toBe("used");
    expect(body.qrCode?.used_at).toBeTruthy();
  });

  it("espone l'endpoint di recupero QR della prenotazione", async () => {
    const { data: rootQr } = await ctx.admin
      .from("booking_qr_codes")
      .select("booking_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const res = await listBookingQr(
      makeNextRequest("GET", undefined, ctx.token, `http://localhost:3010/api/bookings/${rootQr!.booking_id}/qr-codes`),
      { params: Promise.resolve({ id: rootQr!.booking_id }) }
    );
    const body = await json<{ bookingId: string; codes: Array<{ direction: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.bookingId).toBe(rootQr!.booking_id);
    expect(body.codes.length).toBeGreaterThanOrEqual(1);
  });
});
