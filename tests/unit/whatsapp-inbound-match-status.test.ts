import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for a bug found 2026-08-18: two fallback branches in
 * processMessage() (reply-target reuse, and reuse-existing-thread-for-wa_id)
 * hardcoded match_status: "matched" regardless of whether a bookingId was
 * actually resolved. Verified live: 1305/1305 threads with match_status
 * "matched" had booking_id NULL. Fix: status must be derived from whether
 * bookingId/transferId is actually present.
 */

const mocks = vi.hoisted(() => ({
  logWhatsAppEvent: vi.fn().mockResolvedValue(undefined),
  sendWhatsAppTextMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendPushToTenantRoles: vi.fn().mockResolvedValue(undefined),
  upsertWhatsAppCostEvent: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/server/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp")>();
  return {
    ...actual,
    logWhatsAppEvent: mocks.logWhatsAppEvent,
    sendWhatsAppTextMessage: mocks.sendWhatsAppTextMessage
  };
});

vi.mock("@/lib/server/web-push", () => ({
  sendPushToTenantRoles: mocks.sendPushToTenantRoles
}));

vi.mock("@/lib/server/whatsapp/costs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp/costs")>();
  return { ...actual, upsertWhatsAppCostEvent: mocks.upsertWhatsAppCostEvent };
});

import { processWhatsAppWebhook } from "@/lib/server/whatsapp/webhook-processing";

// Wednesday, well within WhatsApp office hours (Europe/Rome) — keeps the
// office-closed auto-reply path out of these tests entirely.
const OPEN_HOURS_TIMESTAMP = String(Math.floor(new Date("2026-08-19T09:00:00Z").getTime() / 1000));

type ThreadRow = { tenant_id: string; wa_id: string; booking_id: string | null; transfer_id: string | null; match_status?: string };

function makeAdmin(options: {
  tenants?: Array<{ id: string }>;
  existingThreads?: ThreadRow[];
  replyTargetMessage?: { id: string; tenant_id: string; booking_id: string | null; transfer_id: string | null; customer_id: string | null } | null;
}) {
  const threadUpserts: Array<Record<string, unknown>> = [];
  return {
    threadUpserts,
    from: vi.fn((table: string) => {
      if (table === "services") {
        // Generic chainable stub covering every filter matchWhatsAppInboundMessage
        // may call (in/gte/lte/order), always resolving to no rows — these tests
        // only exercise the reply-target and reuse-existing-thread fallbacks.
        const servicesBuilder: Record<string, unknown> = {};
        servicesBuilder.select = vi.fn(() => servicesBuilder);
        servicesBuilder.eq = vi.fn(() => servicesBuilder);
        servicesBuilder.in = vi.fn(() => servicesBuilder);
        servicesBuilder.gte = vi.fn(() => servicesBuilder);
        servicesBuilder.lte = vi.fn(() => servicesBuilder);
        servicesBuilder.order = vi.fn(() => servicesBuilder);
        servicesBuilder.limit = vi.fn(() => Promise.resolve({ data: [], error: null }));
        return servicesBuilder;
      }
      if (table === "tenants") {
        return { select: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: options.tenants ?? [], error: null })) })) };
      }
      if (table === "whatsapp_contacts") {
        return {
          select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })), is: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })) })) })),
          insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: "contact-1" }, error: null })) })) }))
        };
      }
      if (table === "whatsapp_threads") {
        const existingForWaId = (waId: string) => (options.existingThreads ?? []).find((t) => t.wa_id === waId) ?? null;
        return {
          select: vi.fn(() => ({
            eq: vi.fn((_field: string, waIdOrTenant: string) => ({
              eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })),
              not: vi.fn(() => ({
                order: vi.fn(() => ({
                  limit: vi.fn(() => ({
                    maybeSingle: vi.fn(() => {
                      const existing = existingForWaId(waIdOrTenant);
                      return Promise.resolve({
                        data: existing
                          ? { tenant_id: existing.tenant_id, booking_id: existing.booking_id, transfer_id: existing.transfer_id, customer_id: null }
                          : null,
                        error: null
                      });
                    })
                  }))
                }))
              }))
            })),
            is: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })) }))
          })),
          upsert: vi.fn((row: Record<string, unknown>) => {
            threadUpserts.push(row);
            return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: "thread-1" }, error: null })) })) };
          })
        };
      }
      if (table === "whatsapp_messages") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() => ({
                  maybeSingle: vi.fn(() => Promise.resolve({ data: options.replyTargetMessage ?? null, error: null }))
                }))
              }))
            })),
            is: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) })) }))
          })),
          upsert: vi.fn(() => Promise.resolve({ data: null, error: null })),
          insert: vi.fn(() => Promise.resolve({ data: null, error: null }))
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    })
  };
}

function messagePayload(input: { waId: string; text: string; msgId: string; replyToWaMessageId?: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: input.waId, profile: { name: "Test" } }],
              messages: [
                {
                  id: input.msgId,
                  from: input.waId,
                  timestamp: OPEN_HOURS_TIMESTAMP,
                  type: "text",
                  text: { body: input.text },
                  ...(input.replyToWaMessageId ? { context: { id: input.replyToWaMessageId } } : {})
                }
              ]
            }
          }
        ]
      }
    ]
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processMessage — match_status must reflect whether a booking was actually found", () => {
  it("reply-target with a real booking_id -> matched", async () => {
    const admin = makeAdmin({
      tenants: [{ id: "tenant-a" }, { id: "tenant-b" }], // >1 tenant: resolveSingleTenant() would return null
      replyTargetMessage: { id: "wamid.original", tenant_id: "tenant-a", booking_id: "svc-1", transfer_id: null, customer_id: null }
    });

    await processWhatsAppWebhook(
      admin as never,
      messagePayload({ waId: "393271152378", text: "Va bene grazie", msgId: "wamid.reply", replyToWaMessageId: "wamid.original" })
    );

    expect(admin.threadUpserts).toHaveLength(1);
    expect(admin.threadUpserts[0].match_status).toBe("matched");
    expect(admin.threadUpserts[0].booking_id).toBe("svc-1");
  });

  it("reply-target whose original message has NO booking_id -> unmatched, not matched", async () => {
    const admin = makeAdmin({
      tenants: [{ id: "tenant-a" }, { id: "tenant-b" }],
      replyTargetMessage: { id: "wamid.original", tenant_id: "tenant-a", booking_id: null, transfer_id: null, customer_id: null }
    });

    await processWhatsAppWebhook(
      admin as never,
      messagePayload({ waId: "393271152378", text: "Va bene grazie mille", msgId: "wamid.reply", replyToWaMessageId: "wamid.original" })
    );

    expect(admin.threadUpserts).toHaveLength(1);
    expect(admin.threadUpserts[0].match_status).toBe("unmatched");
    expect(admin.threadUpserts[0].booking_id).toBeNull();
  });

  it("no reply context, no phone match, but a prior thread exists for this wa_id with no booking -> unmatched, not matched", async () => {
    const admin = makeAdmin({
      tenants: [{ id: "tenant-a" }, { id: "tenant-b" }], // resolveSingleTenant() returns null -> triggers the reuse-existing-thread fallback
      existingThreads: [{ tenant_id: "tenant-a", wa_id: "393271152378", booking_id: null, transfer_id: null }]
    });

    await processWhatsAppWebhook(admin as never, messagePayload({ waId: "393271152378", text: "Buongiorno", msgId: "wamid.new" }));

    expect(admin.threadUpserts).toHaveLength(1);
    expect(admin.threadUpserts[0].match_status).toBe("unmatched");
    expect(admin.threadUpserts[0].booking_id).toBeNull();
  });

  it("no reply context, but a prior thread for this wa_id DOES have a booking -> matched", async () => {
    const admin = makeAdmin({
      tenants: [{ id: "tenant-a" }, { id: "tenant-b" }],
      existingThreads: [{ tenant_id: "tenant-a", wa_id: "393271152378", booking_id: "svc-42", transfer_id: null }]
    });

    await processWhatsAppWebhook(admin as never, messagePayload({ waId: "393271152378", text: "Buongiorno", msgId: "wamid.new2" }));

    expect(admin.threadUpserts).toHaveLength(1);
    expect(admin.threadUpserts[0].match_status).toBe("matched");
    expect(admin.threadUpserts[0].booking_id).toBe("svc-42");
  });
});
