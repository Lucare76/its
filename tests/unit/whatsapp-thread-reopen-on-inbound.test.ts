import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for a bug found live 2026-08-23: a customer wrote on a
 * WhatsApp thread an operator had previously closed. The message was
 * received and archived correctly, and the "office closed" auto-reply was
 * sent successfully — but the thread never left status='closed', so it
 * never appeared in the default "Aperte" inbox tab. Root cause (two parts):
 *  1. upsertThread() (webhook-processing.ts) set `status: existing ?
 *     undefined : status` — on an existing thread the status field was
 *     omitted from the upsert entirely, so Postgres kept whatever it had
 *     before ('closed') forever.
 *  2. The auto-reply's own persistOutboundWhatsAppMessage() call
 *     (messages.ts) hardcoded unread_count:0, wiping out the "unread"
 *     signal for a message no human had actually read yet.
 * Fix: upsertThread() always includes the freshly computed status; the
 * auto-reply call site now passes preserveUnreadState:true so it doesn't
 * zero out unread_count for a message still awaiting a human reply.
 */

const mocks = vi.hoisted(() => ({
  sendWhatsAppTextMessage: vi.fn(),
  sendPushToTenantRoles: vi.fn().mockResolvedValue(undefined),
  upsertWhatsAppCostEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/server/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp")>();
  return { ...actual, sendWhatsAppTextMessage: mocks.sendWhatsAppTextMessage };
});

vi.mock("@/lib/server/web-push", () => ({
  sendPushToTenantRoles: mocks.sendPushToTenantRoles,
}));

vi.mock("@/lib/server/whatsapp/costs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/whatsapp/costs")>();
  return { ...actual, upsertWhatsAppCostEvent: mocks.upsertWhatsAppCostEvent };
});

import { processWhatsAppWebhook } from "@/lib/server/whatsapp/webhook-processing";

const TENANT = "tenant-a";
const WA_ID = "393271152378";
const BOOKING_ID = "svc-1";

// Wednesday 09:00 Europe/Rome — well within office hours, keeps the
// auto-reply path (and its extra table calls) out of the reopen-only test.
const OPEN_HOURS_TIMESTAMP = String(Math.floor(new Date("2026-08-19T09:00:00Z").getTime() / 1000));
// Sunday — always closed regardless of time, per getWhatsAppOfficeHoursStatus.
const CLOSED_HOURS_TIMESTAMP = String(Math.floor(new Date("2026-08-23T12:00:00Z").getTime() / 1000));

function messagePayload(input: { text: string; msgId: string; timestamp: string }) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: WA_ID, profile: { name: "Cliente" } }],
              messages: [
                { id: input.msgId, from: WA_ID, timestamp: input.timestamp, type: "text", text: { body: input.text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Stato in-memory di una thread GIA' CHIUSA da un operatore, con una
 * prenotazione gia' associata (match_status 'matched') — esattamente lo
 * scenario reale diagnosticato: il cliente scrive di nuovo su una
 * conversazione passata, chiusa in precedenza.
 */
function makeAdmin() {
  const threadRow: Record<string, unknown> = {
    id: "thread-1",
    tenant_id: TENANT,
    wa_id: WA_ID,
    booking_id: BOOKING_ID,
    transfer_id: BOOKING_ID,
    customer_id: null,
    match_status: "matched",
    status: "closed",
    unread_count: 0,
  };
  const threadUpserts: Array<Record<string, unknown>> = [];
  const threadUpdates: Array<Record<string, unknown>> = [];
  let usedIn = false;

  const servicesBuilder: Record<string, unknown> = {};
  servicesBuilder.select = vi.fn(() => servicesBuilder);
  servicesBuilder.eq = vi.fn(() => servicesBuilder);
  servicesBuilder.in = vi.fn(() => {
    usedIn = true;
    return servicesBuilder;
  });
  servicesBuilder.gte = vi.fn(() => {
    usedIn = false;
    return servicesBuilder;
  });
  servicesBuilder.lte = vi.fn(() => servicesBuilder);
  servicesBuilder.order = vi.fn(() => servicesBuilder);
  servicesBuilder.limit = vi.fn(() =>
    Promise.resolve({
      data: usedIn
        ? [{ id: BOOKING_ID, tenant_id: TENANT, customer_name: "Cliente Test", phone: WA_ID, date: "2026-08-25", time: "10:00" }]
        : [],
      error: null,
    })
  );

  const contactsBuilder: Record<string, unknown> = {};
  contactsBuilder.select = vi.fn(() => contactsBuilder);
  contactsBuilder.eq = vi.fn(() => contactsBuilder);
  contactsBuilder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
  contactsBuilder.insert = vi.fn(() => ({
    select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: "contact-1" }, error: null })) })),
  }));
  contactsBuilder.update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) }));

  const threadsBuilder: Record<string, unknown> = {};
  threadsBuilder.select = vi.fn(() => threadsBuilder);
  threadsBuilder.eq = vi.fn(() => threadsBuilder);
  threadsBuilder.is = vi.fn(() => threadsBuilder);
  threadsBuilder.maybeSingle = vi.fn(() => Promise.resolve({ data: { ...threadRow }, error: null }));
  threadsBuilder.upsert = vi.fn((row: Record<string, unknown>) => {
    threadUpserts.push(row);
    Object.assign(threadRow, row);
    return { select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: threadRow.id }, error: null })) })) };
  });
  threadsBuilder.update = vi.fn((row: Record<string, unknown>) => {
    threadUpdates.push(row);
    Object.assign(threadRow, row);
    return { eq: vi.fn(() => ({ eq: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: threadRow.id }, error: null })) })) })) })) };
  });

  const messagesBuilder: Record<string, unknown> = {};
  messagesBuilder.select = vi.fn(() => messagesBuilder);
  messagesBuilder.eq = vi.fn(() => messagesBuilder);
  messagesBuilder.is = vi.fn(() => messagesBuilder);
  messagesBuilder.order = vi.fn(() => messagesBuilder);
  messagesBuilder.limit = vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })) }));
  messagesBuilder.upsert = vi.fn(() => Promise.resolve({ data: null, error: null }));
  messagesBuilder.insert = vi.fn(() => Promise.resolve({ data: null, error: null }));

  const autoReplyLogsBuilder: Record<string, unknown> = {};
  autoReplyLogsBuilder.insert = vi.fn(() => ({
    select: vi.fn(() => ({ single: vi.fn(() => Promise.resolve({ data: { id: "log-1" }, error: null })) })),
  }));
  autoReplyLogsBuilder.update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: null, error: null })) }));

  return {
    threadRow,
    threadUpserts,
    threadUpdates,
    from: vi.fn((table: string) => {
      if (table === "services") return servicesBuilder;
      if (table === "whatsapp_contacts") return contactsBuilder;
      if (table === "whatsapp_threads") return threadsBuilder;
      if (table === "whatsapp_messages") return messagesBuilder;
      if (table === "whatsapp_auto_reply_logs") return autoReplyLogsBuilder;
      throw new Error(`Unexpected table in test: ${table}`);
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Thread WhatsApp chiusa in precedenza — riapertura su nuovo messaggio inbound", () => {
  it("nuovo messaggio su thread chiusa (dentro orario ufficio) -> status torna 'open', non resta 'closed'", async () => {
    const admin = makeAdmin();

    await processWhatsAppWebhook(
      admin as never,
      messagePayload({ text: "Siamo arrivati", msgId: "wamid.1", timestamp: OPEN_HOURS_TIMESTAMP })
    );

    expect(admin.threadUpserts).toHaveLength(1);
    // Prima del fix: 'status' era undefined qui, quindi il campo veniva
    // omesso dall'upsert e Postgres manteneva 'closed' per sempre.
    expect(admin.threadUpserts[0].status).toBe("open");
    expect(admin.threadRow.status).toBe("open");
  });

  it("nuovo messaggio su thread chiusa (FUORI orario ufficio) -> risponde 'ufficio chiuso' ma non nasconde il messaggio come letto", async () => {
    mocks.sendWhatsAppTextMessage.mockResolvedValue({
      ok: true,
      messageId: "wamid.auto-reply",
      phoneE164: `+${WA_ID}`,
    });
    const admin = makeAdmin();

    const result = await processWhatsAppWebhook(
      admin as never,
      messagePayload({ text: "Ci sono ancora, aiuto", msgId: "wamid.2", timestamp: CLOSED_HOURS_TIMESTAMP })
    );

    expect(result.errors).toEqual([]);
    expect(mocks.sendWhatsAppTextMessage).toHaveBeenCalledTimes(1);

    // La thread deve riaprirsi (era 'closed')...
    expect(admin.threadRow.status).not.toBe("closed");
    expect(admin.threadRow.status).toBe("open");
    // ...e il messaggio del cliente deve restare "da leggere": la risposta
    // automatica del bot non deve azzerare unread_count come farebbe un vero
    // operatore che ha appena gestito la conversazione.
    expect(Number(admin.threadRow.unread_count)).toBeGreaterThan(0);
  });
});
