import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { validateBusBookingQr } from "@/lib/server/bus-booking-qr";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTWARD_ID = "11111111-1111-4111-8111-111111111111"; // root/ANDATA, direction 'arrival'
const RETURN_ID = "22222222-2222-4222-8222-222222222222"; // RITORNO, direction 'departure'
const TOKEN_OUTBOUND = "outbound-token";
const TOKEN_RETURN = "return-token";

type ServiceFixture = {
  id: string;
  tenant_id: string;
  date: string;
  time: string | null;
  direction: "arrival" | "departure";
  linked_service_id: string | null;
  booking_service_kind: string | null;
  service_type_code: string | null;
  customer_name: string | null;
  phone: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  bus_city_origin: string | null;
  vessel: string | null;
  hotel_id: string | null;
  notes: string | null;
  status: string;
};

function makeService(overrides: Partial<ServiceFixture>): ServiceFixture {
  return {
    id: OUTWARD_ID,
    tenant_id: TENANT,
    date: "2026-08-25",
    time: "10:00",
    direction: "arrival",
    linked_service_id: RETURN_ID,
    booking_service_kind: "bus_city_hotel",
    service_type_code: null,
    customer_name: "Mario Rossi",
    phone: "3331234567",
    customer_first_name: null,
    customer_last_name: null,
    arrival_date: "2026-08-25",
    arrival_time: "10:00",
    departure_date: "2026-08-28",
    departure_time: "16:00",
    bus_city_origin: "Napoli",
    vessel: "Bus",
    hotel_id: null,
    notes: null,
    status: "new",
    ...overrides,
  };
}

function makeQrRow(overrides: Partial<{ id: string; booking_id: string; direction: "outbound" | "return"; qr_token: string; status: string }>) {
  return {
    id: overrides.id ?? "qr-1",
    tenant_id: TENANT,
    booking_id: OUTWARD_ID,
    direction: "outbound" as const,
    service_date: "2026-08-25",
    qr_token: TOKEN_OUTBOUND,
    qr_payload: "payload",
    qr_image_url: "https://example.test/qr.png",
    qr_file_path: null,
    status: "active",
    used_at: null,
    used_by: null,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Fake admin minimale: solo "services" e "booking_qr_codes", le due tabelle lette da validateBusBookingQr. */
function makeAdmin(services: Record<string, ServiceFixture | null>, qrRows: ReturnType<typeof makeQrRow>[]): SupabaseClient {
  return {
    from(table: string) {
      if (table === "services") {
        let idFilter: string | null = null;
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = (col: string, val: string) => {
          if (col === "id") idFilter = val;
          return builder;
        };
        builder.maybeSingle = async () => ({ data: idFilter ? services[idFilter] ?? null : null, error: null });
        return builder;
      }
      if (table === "booking_qr_codes") {
        const filters: Record<string, string> = {};
        const builder: Record<string, unknown> = {};
        builder.select = () => builder;
        builder.eq = (col: string, val: string) => {
          filters[col] = val;
          return builder;
        };
        builder.order = () => builder;
        builder.maybeSingle = async () => {
          const row = qrRows.find((r) => Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
          return { data: row ?? null, error: null };
        };
        builder.then = (resolve: (v: unknown) => unknown) => {
          const matching = qrRows.filter((r) => Object.entries(filters).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v));
          return Promise.resolve({ data: matching, error: null }).then(resolve);
        };
        return builder;
      }
      throw new Error(`tabella inattesa: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("validateBusBookingQr — cancellazione per singola tratta (ANDATA/RITORNO indipendenti)", () => {
  const qrRows = [
    makeQrRow({ id: "qr-out", direction: "outbound", qr_token: TOKEN_OUTBOUND, status: "active" }),
    makeQrRow({ id: "qr-ret", direction: "return", qr_token: TOKEN_RETURN, status: "active" }),
  ];

  it("10. QR della tratta ANDATA viene rifiutato quando solo ANDATA e' cancelled", async () => {
    const services = {
      [OUTWARD_ID]: makeService({ id: OUTWARD_ID, direction: "arrival", status: "cancelled" }),
      [RETURN_ID]: makeService({ id: RETURN_ID, direction: "departure", linked_service_id: OUTWARD_ID, status: "confirmed" }),
    };
    const result = await validateBusBookingQr(makeAdmin(services, qrRows), OUTWARD_ID, "outbound", TOKEN_OUTBOUND);
    expect(result.state).toBe("cancelled");
  });

  it("11. QR della tratta RITORNO continua a funzionare quando solo ANDATA e' cancelled", async () => {
    const services = {
      [OUTWARD_ID]: makeService({ id: OUTWARD_ID, direction: "arrival", status: "cancelled" }),
      [RETURN_ID]: makeService({ id: RETURN_ID, direction: "departure", linked_service_id: OUTWARD_ID, status: "confirmed" }),
    };
    const result = await validateBusBookingQr(makeAdmin(services, qrRows), OUTWARD_ID, "return", TOKEN_RETURN);
    expect(result.state).toBe("valid");
  });

  it("12. cancellazione completa A/R -> ENTRAMBI i QR vengono rifiutati", async () => {
    const services = {
      [OUTWARD_ID]: makeService({ id: OUTWARD_ID, direction: "arrival", status: "cancelled" }),
      [RETURN_ID]: makeService({ id: RETURN_ID, direction: "departure", linked_service_id: OUTWARD_ID, status: "cancelled" }),
    };
    const admin = makeAdmin(services, qrRows);
    const outboundResult = await validateBusBookingQr(admin, OUTWARD_ID, "outbound", TOKEN_OUTBOUND);
    const returnResult = await validateBusBookingQr(admin, OUTWARD_ID, "return", TOKEN_RETURN);
    expect(outboundResult.state).toBe("cancelled");
    expect(returnResult.state).toBe("cancelled");
  });

  it("entrambe le tratte confermate -> entrambi i QR restano validi (nessuna falsa anomalia)", async () => {
    const services = {
      [OUTWARD_ID]: makeService({ id: OUTWARD_ID, direction: "arrival", status: "confirmed" }),
      [RETURN_ID]: makeService({ id: RETURN_ID, direction: "departure", linked_service_id: OUTWARD_ID, status: "confirmed" }),
    };
    const admin = makeAdmin(services, qrRows);
    expect((await validateBusBookingQr(admin, OUTWARD_ID, "outbound", TOKEN_OUTBOUND)).state).toBe("valid");
    expect((await validateBusBookingQr(admin, OUTWARD_ID, "return", TOKEN_RETURN)).state).toBe("valid");
  });
});
