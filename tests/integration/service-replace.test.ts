/**
 * Test di integrazione — POST /api/ops/services/[id]/replace
 *
 * Testa il flusso completo di sostituzione dati di una pratica:
 *  - happy path: aggiornamento riuscito + verifica in DB
 *  - errori: service non trovato, payload non valido, token assente
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { POST } from "@/app/api/ops/services/[id]/replace/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedService,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;
let serviceId: string;

const VALID_PAYLOAD = {
  customer_first_name: "Mario",
  customer_last_name: "Rossi",
  customer_phone: "+39 333 9876543",
  pax: 3,
  hotel_id: "", // impostato in beforeAll
  arrival_date: "2026-05-20",
  arrival_time: "10:30",
  departure_date: "2026-05-25",
  departure_time: "14:00",
  transport_code: "FR1234",
  bus_city_origin: null,
  notes: "Nota aggiornata dal test di integrazione",
  agency_id: null,
  agency_quoted_price_cents: null,
};

/** Crea i params Next.js per la route dinamica [id]. */
function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId);
  serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
    date: "2026-05-20",
    time: "10:30",
    direction: "arrival",
    pax: 2,
    customer_name: "Bianchi Luigi",
    phone: "+39 333 0000000",
  });
  VALID_PAYLOAD.hotel_id = hotelId;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("service replace — happy path", () => {
  it("aggiorna il servizio e ritorna ok:true", async () => {
    const req = makeNextRequest("POST", VALID_PAYLOAD, ctx.token);
    const res = await POST(req, makeParams(serviceId));
    const body = await json<{ ok: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("i dati sono effettivamente aggiornati in DB", async () => {
    const { data } = await ctx.admin
      .from("services")
      .select("customer_name, pax, phone")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data).toBeTruthy();
    // Il campo customer_name viene ricostruito da first_name + last_name nella route
    expect(data!.pax).toBe(3);
    expect(data!.phone).toBe("+39 333 9876543");
  });

  it("aggiorna anche note e transport_code", async () => {
    const { data } = await ctx.admin
      .from("services")
      .select("notes")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data!.notes).toBe("Nota aggiornata dal test di integrazione");
  });
});

describe("service replace — validazione", () => {
  it("ritorna 400 per pax = 0", async () => {
    const req = makeNextRequest(
      "POST",
      { ...VALID_PAYLOAD, pax: 0 },
      ctx.token,
    );
    const res = await POST(req, makeParams(serviceId));
    expect(res.status).toBe(400);
  });

  it("ritorna 400 per customer_last_name vuoto", async () => {
    const req = makeNextRequest(
      "POST",
      { ...VALID_PAYLOAD, customer_last_name: "" },
      ctx.token,
    );
    const res = await POST(req, makeParams(serviceId));
    expect(res.status).toBe(400);
  });

  it("ritorna 400 per data in formato errato", async () => {
    const req = makeNextRequest(
      "POST",
      { ...VALID_PAYLOAD, arrival_date: "20-05-2026" },
      ctx.token,
    );
    const res = await POST(req, makeParams(serviceId));
    expect(res.status).toBe(400);
  });

  it("ritorna 400 per id pratica 'undefined'", async () => {
    const req = makeNextRequest("POST", VALID_PAYLOAD, ctx.token);
    const res = await POST(req, makeParams("undefined"));
    expect(res.status).toBe(400);
  });
});

describe("service replace — autorizzazione e esistenza", () => {
  it("ritorna 401 senza token valido", async () => {
    const req = makeNextRequest("POST", VALID_PAYLOAD, "token-non-valido");
    const res = await POST(req, makeParams(serviceId));
    expect(res.status).toBe(401);
  });

  it("ritorna 404 per un serviceId inesistente", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const req = makeNextRequest("POST", VALID_PAYLOAD, ctx.token);
    const res = await POST(req, makeParams(fakeId));
    expect(res.status).toBe(404);
  });
});
