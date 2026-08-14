import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertWhatsAppCostEvent: vi.fn().mockResolvedValue(undefined),
  logWhatsAppEvent: vi.fn().mockResolvedValue(undefined),
  mapWebhookStatus: vi.fn((status: string) => (status === "read" ? "read" : status === "sent" ? "sent" : null)),
}));

vi.mock("@/lib/server/whatsapp/costs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp/costs")>();
  return { ...actual, upsertWhatsAppCostEvent: mocks.upsertWhatsAppCostEvent };
});

vi.mock("@/lib/server/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp")>();
  return {
    ...actual,
    logWhatsAppEvent: mocks.logWhatsAppEvent,
    mapWebhookStatus: mocks.mapWebhookStatus
  };
});

import { processWhatsAppWebhook } from "@/lib/server/whatsapp/webhook-processing";

/**
 * Minimal Supabase admin mock covering only the tables the status-processing
 * path is allowed to touch. `services` is intentionally NOT registered here:
 * if the code under test ever queries `services` again for status
 * resolution (the old, invalid `services.message_id` lookup), this mock
 * throws instead of silently succeeding.
 */
function makeAdmin(options: {
  whatsappMessage?: { tenant_id: string; booking_id: string | null } | null;
  whatsappEvent?: { tenant_id: string; service_id: string | null } | null;
  tenants?: Array<{ id: string }>;
}) {
  const fromCalls: string[] = [];
  return {
    fromCalls,
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      if (table === "services") {
        throw new Error("services table must not be queried during WhatsApp status resolution");
      }
      if (table === "whatsapp_messages") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(() => Promise.resolve({ data: options.whatsappMessage ?? null, error: null }))
            }))
          }))
        };
      }
      if (table === "whatsapp_events") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn(() => Promise.resolve({ data: options.whatsappEvent ?? null, error: null }))
              }))
            }))
          }))
        };
      }
      if (table === "tenants") {
        return {
          select: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve({ data: options.tenants ?? [], error: null }))
          }))
        };
      }
      if (table === "whatsapp_message_statuses") {
        return { upsert: vi.fn(() => Promise.resolve({ data: null, error: null })) };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    })
  };
}

function statusPayload(id: string, status: string) {
  return {
    object: "whatsapp_business_account",
    entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: "1770000000", recipient_id: "393331234567" }] } }] }]
  };
}

describe("processWhatsAppWebhook — status resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mapWebhookStatus.mockImplementation((status: string) => (status === "read" ? "read" : status === "sent" ? "sent" : null));
  });

  it("resolves the tenant via whatsapp_messages without ever querying services.message_id", async () => {
    const admin = makeAdmin({ whatsappMessage: { tenant_id: "tenant-a", booking_id: "svc-1" } });

    const result = await processWhatsAppWebhook(admin as never, statusPayload("wamid.1", "read"));

    expect(result.errors).toEqual([]);
    expect(result.statuses).toBe(1);
    expect(admin.fromCalls).not.toContain("services");
    expect(admin.fromCalls).toContain("whatsapp_messages");
  });

  it("falls back to whatsapp_events (legacy) when whatsapp_messages has no match, still without touching services", async () => {
    const admin = makeAdmin({
      whatsappMessage: null,
      whatsappEvent: { tenant_id: "tenant-b", service_id: null },
    });

    const result = await processWhatsAppWebhook(admin as never, statusPayload("wamid.2", "sent"));

    expect(result.errors).toEqual([]);
    expect(admin.fromCalls).not.toContain("services");
  });

  it("does not fail the webhook when no tenant can be resolved for the status (single-tenant fallback also empty)", async () => {
    const admin = makeAdmin({ whatsappMessage: null, whatsappEvent: null, tenants: [] });

    const result = await processWhatsAppWebhook(admin as never, statusPayload("wamid.3", "read"));

    // resolveStatusTenant throws when no tenant resolves; processWhatsAppWebhook
    // must swallow that into result.errors rather than throwing to the caller.
    expect(result.errors.length).toBe(1);
    expect(result.statuses).toBe(0);
  });
});
