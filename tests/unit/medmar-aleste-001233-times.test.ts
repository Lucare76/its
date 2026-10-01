import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as medmarClient from "@/lib/server/medmar-booking/client";
import * as routeMapping from "@/lib/server/medmar-booking/route-mapping";

// Regressione orari: PDF Aleste MEDMAR reale 001233 (26/002905, Pozzuoli A/R)
// -> import -> preflight. Separato da medmar-preflight.test.ts perché lì i
// timer finti globali bloccano il parsing PDF (pdfjs).

type Row = Record<string, unknown>;

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SVC_ARR = "s1111111-1111-4111-8111-111111111111";

vi.mock("@/lib/server/medmar-booking/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/medmar-booking/client")>();
  return { ...actual, fetchCorseReadOnly: vi.fn().mockResolvedValue([]), fetchBigliettiVendibiliReadOnly: vi.fn() };
});

vi.mock("@/lib/server/medmar-booking/route-mapping", () => ({
  getIdTrattaForRouteCode: vi.fn(),
  getExpectedPortsForRouteCode: vi.fn().mockReturnValue(null),
  isMirrorRouteCode: vi.fn().mockReturnValue(true),
}));

const { runMedmarPreflight } = await import("@/lib/server/medmar-booking/preflight");
const { parseAgencyPdfUpload } = await import("@/lib/server/agency-pdf-import");

function fakeAdmin(services: Row[], ferrySchedules: Row[]) {
  return {
    from(table: string) {
      let filtered = [...(table === "services" ? services : table === "ferry_schedules" ? ferrySchedules : [])];
      const builder = {
        select() { return builder; },
        eq(field: string, value: unknown) { filtered = filtered.filter((r) => r[field] === value); return builder; },
        in(field: string, values: unknown[]) { filtered = filtered.filter((r) => values.includes(r[field])); return builder; },
        then(done: (v: { data: Row[]; error: null }) => void) { done({ data: filtered, error: null }); },
      };
      return builder;
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

// Righe Medmar Pozzuoli del seed supabase/migrations/0089_ferry_schedules.sql.
const POZZUOLI_SCHEDULES: Row[] = [
  { company: "medmar", departure_port: "pozzuoli", arrival_port: "ischia_porto", departure_time: "09:40:00", direction: "mainland_to_ischia", days_of_week: null, valid_from: null, valid_to: null },
  { company: "medmar", departure_port: "ischia_porto", arrival_port: "pozzuoli", departure_time: "11:10:00", direction: "ischia_to_mainland", days_of_week: null, valid_from: null, valid_to: null },
];

describe("PDF Aleste MEDMAR 001233 — orari nave fino al preflight", () => {
  it("andata 09:40 -> dopoLe 09:40:00 su Pozzuoli->Ischia; ritorno 11:10 -> dopoLe 11:10:00 su Ischia->Pozzuoli", async () => {
    vi.mocked(routeMapping.getIdTrattaForRouteCode).mockImplementation((route) =>
      route === "pozzuoli_ischia" ? 56 : route === "ischia_pozzuoli" ? 14 : null
    );
    const parsed = await parseAgencyPdfUpload({
      senderEmail: "booking@aleste-viaggi.it",
      subject: "Conferma d'ordine Aleste",
      filename: "conferma.pdf",
      fileBytes: readFileSync(resolve(process.cwd(), "tests/pdfs/aleste-viaggi/ok/CONFERMA D'ORDINE n. 001233_N_26_002905_1_000001.pdf")),
    });
    const n = parsed.normalized;
    expect(n.outbound_time).toBe("09:40");
    expect(n.return_time).toBe("11:10");
    expect(n.arrival_place).toBe("PORTO DI POZZUOLI");
    expect(n.return_mainland_port).toBe("pozzuoli");

    // Stessa mappatura di app/api/email/inbox-approve/route.ts (servicePayload).
    const row: Row = {
      id: SVC_ARR, tenant_id: TENANT_A, status: "new", customer_name: "Cliente Aleste", pax: 2,
      notes: "[practice:26/002905]", booking_service_kind: "transfer_port_hotel", direction: "arrival",
      vessel: n.arrival_place, transport_code: "MEDMAR",
      date: n.arrival_date, time: n.outbound_time, outbound_time: n.outbound_time,
      departure_date: n.departure_date, departure_time: n.return_time, return_time: n.return_time,
      meeting_point: n.arrival_place, ferry_details: { return_mainland_port: n.return_mainland_port },
    };
    const result = await runMedmarPreflight(fakeAdmin([row], POZZUOLI_SCHEDULES), TENANT_A, [SVC_ARR]);

    expect(result.outward?.route_code).toBe("pozzuoli_ischia");
    expect(result.return?.route_code).toBe("ischia_pozzuoli");
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledWith({ idTratta: 56, partenzaDataDal: "2026-04-04", dopoLe: "09:40:00" });
    expect(medmarClient.fetchCorseReadOnly).toHaveBeenCalledWith({ idTratta: 14, partenzaDataDal: "2026-04-07", dopoLe: "11:10:00" });
  }, 30000);
});
