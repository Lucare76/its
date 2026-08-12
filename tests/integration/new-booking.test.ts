/**
 * Test di integrazione — POST /api/ops/new-booking
 *
 * Copre il flusso reale di creazione prenotazione da backoffice:
 *  - crea un servizio andata/ritorno
 *  - verifica i due record servizi
 *  - verifica il linking reciproco
 *  - verifica gli status_events iniziali
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "@/app/api/ops/new-booking/route";
import { PATCH } from "@/app/api/ops/services/[id]/route";
import { makeNextRequest, json } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;

const VALID_PAYLOAD = {
  customer_first_name: "Mario",
  customer_last_name: "Rossi",
  customer_phone: "+39 333 9876543",
  customer_email: "mario.rossi@test.invalid",
  pax: 3,
  hotel_id: "",
  booking_service_kind: "transfer_airport_hotel",
  arrival_date: "2026-06-20",
  arrival_time: "10:30",
  departure_date: "2026-06-25",
  departure_time: "14:00",
  transport_code: "FR1234",
  transport_code_return: "FR5678",
  bus_city_origin: "",
  include_ferry_tickets: true,
  ferry_outbound_code: "OUT-001",
  ferry_return_code: "RET-001",
  excursion_title: "",
  notes: "Nota test nuova prenotazione",
  agency_id: "",
  agency_quoted_price_cents: null,
  trip_leg: "round_trip",
  pickup_time_outbound: "11:15",
  pickup_time_return: "12:45",
  hotel_dest_id: "",
};

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, { name: "Hotel Test Booking" });
  VALID_PAYLOAD.hotel_id = hotelId;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("new booking — autenticazione e validazione", () => {
  it("ritorna 401 senza token valido", async () => {
    const req = makeNextRequest("POST", VALID_PAYLOAD, "token-non-valido");
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("ritorna 400 per payload non valido", async () => {
    const req = makeNextRequest("POST", { ...VALID_PAYLOAD, customer_last_name: "" }, ctx.token);
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe("new booking — round trip", () => {
  it("crea andata e ritorno con linking reciproco", async () => {
    const req = makeNextRequest("POST", VALID_PAYLOAD, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string; round_trip?: boolean; error?: string }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBeTruthy();
    expect(body.id_return).toBeTruthy();
    expect(body.round_trip).toBe(true);

    const serviceIds = [body.id!, body.id_return!];
    const { data: services, error } = await ctx.admin
      .from("services")
      .select("id, date, time, direction, customer_name, customer_first_name, customer_last_name, phone, transport_code, pickup_time, linked_service_id, ferry_details, include_ferry_tickets, status, created_by_user_id")
      .in("id", serviceIds)
      .eq("tenant_id", ctx.tenantId);

    expect(error).toBeNull();
    expect(services).toHaveLength(2);

    const outbound = services!.find((row) => row.id === body.id);
    const inbound = services!.find((row) => row.id === body.id_return);

    expect(outbound).toBeTruthy();
    expect(inbound).toBeTruthy();

    expect(outbound!.direction).toBe("arrival");
    expect(outbound!.date).toBe(VALID_PAYLOAD.arrival_date);
    expect(String(outbound!.time).slice(0, 5)).toBe(VALID_PAYLOAD.arrival_time);
    expect(outbound!.pickup_time).toBe(VALID_PAYLOAD.pickup_time_outbound);
    expect(outbound!.linked_service_id).toBe(body.id_return);

    expect(inbound!.direction).toBe("departure");
    expect(inbound!.date).toBe(VALID_PAYLOAD.departure_date);
    expect(String(inbound!.time).slice(0, 5)).toBe(VALID_PAYLOAD.departure_time);
    expect(inbound!.pickup_time).toBe(VALID_PAYLOAD.pickup_time_return);
    expect(inbound!.linked_service_id).toBe(body.id);

    for (const service of services!) {
      expect(service.customer_name).toBe("Mario Rossi");
      expect(service.customer_first_name).toBe("Mario");
      expect(service.customer_last_name).toBe("Rossi");
      expect(service.phone).toBe(VALID_PAYLOAD.customer_phone);
      expect(service.transport_code).toBe("FR1234 / FR5678");
      expect(service.include_ferry_tickets).toBe(true);
      expect(service.status).toBe("new");
      expect(service.created_by_user_id).toBe(ctx.userId);
      expect(service.linked_service_id).toBeTruthy();
    }
  });

  it("crea lo status event iniziale per entrambe le tratte", async () => {
    const { data: services } = await ctx.admin
      .from("services")
      .select("id")
      .eq("tenant_id", ctx.tenantId)
      .eq("customer_name", "Mario Rossi");

    const ids = (services ?? []).map((row) => row.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const { data: events, error } = await ctx.admin
      .from("status_events")
      .select("service_id, status, by_user_id")
      .eq("tenant_id", ctx.tenantId)
      .in("service_id", ids)
      .eq("status", "new");

    expect(error).toBeNull();
    expect(events).toBeTruthy();
    expect(events!.length).toBeGreaterThanOrEqual(2);
    for (const event of events!) {
      expect(event.status).toBe("new");
      expect(event.by_user_id).toBe(ctx.userId);
    }
  });
});

// Fase 1.8: verifica che meeting_point sia trattato come dato PER-GAMBA nei
// booking A/R, e non ereditato dalla gamba di andata a quella di ritorno.
// Bug reale trovato e corretto in app/api/ops/new-booking/route.ts: returnInsert
// spreadava `{ ...insert }` senza mai sovrascrivere meeting_point per i kind
// traghetto (formula_snav/formula_medmar_napoli/formula_medmar_pozzuoli), quindi
// il ritorno ereditava silenziosamente il meeting_point dell'andata — con
// conseguenza diretta sul port-resolution Medmar (Fase 1.7), che legge
// meeting_point per distinguere Ischia da Casamicciola.
describe("new booking — meeting_point indipendente per gamba A/R (Fase 1.8)", () => {
  // Costruita a runtime (dentro ogni it), non a tempo di describe: VALID_PAYLOAD.hotel_id
  // viene popolato solo dentro beforeAll, che gira dopo la valutazione del corpo di describe.
  function medmarPozzuoliBase() {
    return {
      ...VALID_PAYLOAD,
      booking_service_kind: "formula_medmar_pozzuoli",
      customer_first_name: "Pozzuoli",
    };
  }

  it("one-way: meeting_point viene salvato correttamente sull'unica gamba", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "OneWay",
      trip_leg: "outbound_only",
      meeting_point: "Ischia Porto",
    };
    const req = makeNextRequest("POST", payload, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string }>(res);
    expect(res.status).toBe(200);
    expect(body.id_return).toBeFalsy();

    const { data } = await ctx.admin
      .from("services")
      .select("meeting_point, direction")
      .eq("id", body.id!)
      .single();
    expect(data?.direction).toBe("arrival");
    expect(data?.meeting_point).toBe("Ischia Porto");
  });

  it("round trip Pozzuoli->Ischia (andata) + Casamicciola->Pozzuoli (ritorno): le due gambe mantengono meeting_point indipendenti, il ritorno NON eredita quello dell'andata", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "AndataIschiaRitornoCasamicciola",
      trip_leg: "round_trip",
      meeting_point: "Ischia Porto",
      porto_partenza: "Casamicciola - Corso Garibaldi",
    };
    const req = makeNextRequest("POST", payload, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string }>(res);
    expect(res.status).toBe(200);
    expect(body.id).toBeTruthy();
    expect(body.id_return).toBeTruthy();

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, direction, meeting_point")
      .in("id", [body.id!, body.id_return!]);
    const outbound = services!.find((r) => r.id === body.id)!;
    const inbound = services!.find((r) => r.id === body.id_return)!;

    expect(outbound.direction).toBe("arrival");
    expect(outbound.meeting_point).toBe("Ischia Porto");
    expect(inbound.direction).toBe("departure");
    expect(inbound.meeting_point).toBe("Casamicciola - Corso Garibaldi");
    // Sensitivity: il ritorno NON deve mai ereditare il meeting_point dell'andata.
    expect(inbound.meeting_point).not.toBe(outbound.meeting_point);
  });

  it("round trip Pozzuoli->Casamicciola (andata) + Ischia->Pozzuoli (ritorno): copre le due direzioni mancanti, andata NON eredita dal ritorno", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "AndataCasamicciolaRitornoIschia",
      trip_leg: "round_trip",
      meeting_point: "Casamicciola - Piazza Marina",
      porto_partenza: "Ischia Porto",
    };
    const req = makeNextRequest("POST", payload, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string }>(res);
    expect(res.status).toBe(200);

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, direction, meeting_point")
      .in("id", [body.id!, body.id_return!]);
    const outbound = services!.find((r) => r.id === body.id)!;
    const inbound = services!.find((r) => r.id === body.id_return)!;

    expect(outbound.meeting_point).toBe("Casamicciola - Piazza Marina");
    expect(inbound.meeting_point).toBe("Ischia Porto");
    expect(outbound.meeting_point).not.toBe(inbound.meeting_point);
  });

  it("round trip Napoli->Ischia + Ischia->Napoli: meeting_point resta coerente per ciascuna gamba (nessuna dipendenza da copy generico)", async () => {
    const payload = {
      ...VALID_PAYLOAD,
      booking_service_kind: "formula_medmar_napoli",
      customer_first_name: "Napoli",
      customer_last_name: "AndataRitorno",
      trip_leg: "round_trip",
      meeting_point: "Ischia Porto",
      porto_partenza: "Ischia Porto",
    };
    const req = makeNextRequest("POST", payload, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string }>(res);
    expect(res.status).toBe(200);

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, meeting_point")
      .in("id", [body.id!, body.id_return!]);
    for (const row of services!) {
      expect(row.meeting_point).toBe("Ischia Porto");
    }
  });

  it("round trip senza meeting_point/porto_partenza: entrambe le gambe restano null, nessun fallback implicito (nessun porto inventato)", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "SenzaMeetingPoint",
      trip_leg: "round_trip",
      meeting_point: undefined,
      porto_partenza: undefined,
    };
    const req = makeNextRequest("POST", payload, ctx.token);
    const res = await POST(req);
    const body = await json<{ ok?: boolean; id?: string; id_return?: string }>(res);
    expect(res.status).toBe(200);

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, meeting_point")
      .in("id", [body.id!, body.id_return!]);
    for (const row of services!) {
      expect(row.meeting_point).toBeNull();
    }
  });

  it("edit della sola gamba di andata (meeting_point) non sovrascrive il meeting_point della gamba di ritorno collegata", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "EditSoloAndata",
      trip_leg: "round_trip",
      meeting_point: "Ischia Porto",
      porto_partenza: "Casamicciola - Corso Garibaldi",
    };
    const createReq = makeNextRequest("POST", payload, ctx.token);
    const createRes = await POST(createReq);
    const created = await json<{ id?: string; id_return?: string }>(createRes);

    const patchReq = makeNextRequest("PATCH", { meeting_point: "Ischia Porto - Molo Nuovo" }, ctx.token);
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: created.id! }) });
    expect(patchRes.status).toBe(200);

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, meeting_point")
      .in("id", [created.id!, created.id_return!]);
    const outbound = services!.find((r) => r.id === created.id)!;
    const inbound = services!.find((r) => r.id === created.id_return)!;

    expect(outbound.meeting_point).toBe("Ischia Porto - Molo Nuovo");
    expect(inbound.meeting_point).toBe("Casamicciola - Corso Garibaldi");
  });

  it("edit della sola gamba di ritorno (meeting_point) non sovrascrive il meeting_point della gamba di andata collegata", async () => {
    const payload = {
      ...medmarPozzuoliBase(),
      customer_last_name: "EditSoloRitorno",
      trip_leg: "round_trip",
      meeting_point: "Ischia Porto",
      porto_partenza: "Casamicciola - Corso Garibaldi",
    };
    const createReq = makeNextRequest("POST", payload, ctx.token);
    const createRes = await POST(createReq);
    const created = await json<{ id?: string; id_return?: string }>(createRes);

    const patchReq = makeNextRequest("PATCH", { meeting_point: "Casamicciola - Piazza Bagni" }, ctx.token);
    const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: created.id_return! }) });
    expect(patchRes.status).toBe(200);

    const { data: services } = await ctx.admin
      .from("services")
      .select("id, meeting_point")
      .in("id", [created.id!, created.id_return!]);
    const outbound = services!.find((r) => r.id === created.id)!;
    const inbound = services!.find((r) => r.id === created.id_return)!;

    expect(outbound.meeting_point).toBe("Ischia Porto");
    expect(inbound.meeting_point).toBe("Casamicciola - Piazza Bagni");
  });
});
