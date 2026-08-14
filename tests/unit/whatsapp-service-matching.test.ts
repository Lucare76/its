import { beforeEach, describe, expect, it, vi } from "vitest";
import { matchWhatsAppInboundMessage } from "@/lib/server/whatsapp/matching";

type ServiceFixture = {
  id: string;
  tenant_id: string;
  customer_name: string | null;
  phone: string | null;
  date: string | null;
  time: string | null;
  notes?: string | null;
  source_quote_id?: string | null;
  booking_service_kind?: string | null;
  hotel_id?: string | null;
};

const capturedColumns: string[] = [];

beforeEach(() => {
  capturedColumns.length = 0;
});

function makeServicesBuilder(rows: ServiceFixture[]) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn((columns: string) => {
    capturedColumns.push(columns);
    return builder;
  });
  builder.in = vi.fn(() => builder);
  builder.gte = vi.fn(() => builder);
  builder.order = vi.fn(() => builder);
  builder.limit = vi.fn(() => Promise.resolve({ data: rows, error: null }));
  return builder;
}

/**
 * Fake admin client. `queueByCallOrder` returns the rows for the Nth call to
 * `.from("services")` (exact phone lookup is always first, normalized phone
 * lookup second, practice-token lookup third) so tests can control each stage
 * independently without depending on real Postgres chaining semantics.
 */
function makeAdmin(queueByCallOrder: ServiceFixture[][], tenantRows: Array<{ id: string }> = []) {
  let servicesCallIndex = 0;
  return {
    from: vi.fn((table: string) => {
      if (table === "services") {
        const rows = queueByCallOrder[servicesCallIndex] ?? [];
        servicesCallIndex += 1;
        return makeServicesBuilder(rows);
      }
      if (table === "tenants") {
        return { select: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: tenantRows, error: null })) })) };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    })
  };
}

describe("matchWhatsAppInboundMessage", () => {
  it("matches by exact phone", async () => {
    const admin = makeAdmin([[
      { id: "svc-1", tenant_id: "tenant-a", customer_name: "Mario", phone: "+393331234567", date: "2026-08-20", time: "10:00" }
    ]]);

    const result = await matchWhatsAppInboundMessage(admin as never, {
      waId: "393331234567",
      phoneE164: "+393331234567"
    });

    expect(result.status).toBe("matched");
    expect(result.bookingId).toBe("svc-1");
    expect(result.tenantId).toBe("tenant-a");
  });

  it("falls back to normalized phone when exact phone finds nothing", async () => {
    const admin = makeAdmin([
      [], // exact phone: no rows
      [{ id: "svc-2", tenant_id: "tenant-b", customer_name: "Luigi", phone: "0039 333 123 4567", date: "2026-08-21", time: "09:00" }]
    ]);

    const result = await matchWhatsAppInboundMessage(admin as never, {
      waId: "393331234567",
      phoneE164: "+393331234567"
    });

    expect(result.status).toBe("matched");
    expect(result.bookingId).toBe("svc-2");
  });

  it("returns unmatched without error when no service corresponds, and preserves the inbound message", async () => {
    const admin = makeAdmin([[], [], []], [{ id: "tenant-only" }]);

    const result = await matchWhatsAppInboundMessage(admin as never, {
      waId: "393339999999",
      phoneE164: "+393339999999",
      textBody: "Nessuna corrispondenza"
    });

    expect(result.status).toBe("unmatched");
    expect(result.bookingId).toBeNull();
    expect(result.suggestions).toEqual([]);
    // unmatched still resolves a tenant when unambiguous, so the inbound
    // thread/message can be stored rather than dropped.
    expect(result.tenantId).toBe("tenant-only");
  });

  it("never selects the non-existent services.message_id column", async () => {
    const admin = makeAdmin([
      [],
      [],
      [{ id: "svc-3", tenant_id: "tenant-a", customer_name: null, phone: null, date: "2026-08-22", time: "11:00", notes: "pratica ABC1234" }]
    ]);

    await matchWhatsAppInboundMessage(admin as never, {
      waId: "393330000000",
      phoneE164: "+393330000000",
      textBody: "rif ABC1234"
    });

    expect(capturedColumns.length).toBeGreaterThan(0);
    for (const columns of capturedColumns) {
      expect(columns).not.toMatch(/\bmessage_id\b/);
      expect(columns).not.toMatch(/\bexternal_code\b/);
    }
  });

  it("keeps tenant isolation: ambiguous matches across tenants do not resolve a single tenant", async () => {
    const admin = makeAdmin([[
      { id: "svc-4", tenant_id: "tenant-a", customer_name: "A", phone: "+393331111111", date: "2026-08-23", time: "08:00" },
      { id: "svc-5", tenant_id: "tenant-b", customer_name: "B", phone: "+393331111111", date: "2026-08-24", time: "09:00" }
    ]]);

    const result = await matchWhatsAppInboundMessage(admin as never, {
      waId: "393331111111",
      phoneE164: "+393331111111"
    });

    expect(result.status).toBe("ambiguous");
    expect(result.tenantId).toBeNull();
    expect(result.bookingId).toBeNull();
  });
});
