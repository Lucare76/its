import { describe, it, expect } from "vitest";
import {
  filterSnavRowsByDate,
  classifyRowState,
  isExpectedConvocation,
  extractMetaErrorCode,
  buildSnavWhatsAppLog,
  type SnavLogRowSource,
  type SnavSendLogSource,
  type SnavBatchSource,
  type SnavOperatorSource,
} from "@/lib/server/snav-whatsapp-log";
import { resolveOperationalDate } from "@/lib/medmar-date";
import type { MessageStatusSource } from "@/lib/server/whatsapp-log-shared";

function row(partial: Partial<SnavLogRowSource> & { id: string }): SnavLogRowSource {
  return {
    batch_id: "batch-1",
    inviare: true,
    customer_name: "Cliente",
    departure_date_label: "DOMENICA 30 AGOSTO",
    departure_date: "2026-08-30",
    hotel: "Hotel Park Imperial",
    passengers: "3",
    pickup_time: "16:40",
    vessel_time: "17:40",
    phone_raw: "3334372831",
    phone_e164: "+393334372831",
    status: "inviato",
    error_message: null,
    provider_message_id: null,
    sent_at: "2026-08-29T09:00:00.000Z",
    ...partial,
  };
}

function sendLog(partial: Partial<SnavSendLogSource> & { row_id: string }): SnavSendLogSource {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    operator_user_id: "op-1",
    template_name: "partenze_snav",
    language_code: "it",
    variables_json: { "1": "Luca", "2": "DOMENICA 30 AGOSTO", "3": "Hotel Park Imperial", "4": "3", "5": "16:40", "6": "17:40" },
    status: "sent",
    provider_message_id: null,
    error_message: null,
    api_response_json: null,
    attempt_number: 1,
    attempted_at: "2026-08-29T09:00:00.000Z",
    ...partial,
  };
}

const BATCHES: SnavBatchSource[] = [{ id: "batch-1", file_name: "snav_30-08.xlsx", label: "SNAV 30/08" }];
const OPERATORS: SnavOperatorSource[] = [
  { user_id: "op-1", full_name: "Mario Rossi", email: "mario@example.test" },
  { user_id: "op-2", full_name: null, email: "anna@example.test" },
];
const NO_STATUSES: MessageStatusSource[] = [];

describe("filterSnavRowsByDate — SNAV departure day, exact match", () => {
  it("keeps only rows whose departure_date equals the requested day", () => {
    const rows = [
      row({ id: "a", departure_date: "2026-08-30" }),
      row({ id: "b", departure_date: "2026-08-31" }),
      row({ id: "c", departure_date: null }),
    ];
    expect(filterSnavRowsByDate(rows, "2026-08-30").map((r) => r.id)).toEqual(["a"]);
  });

  it("does not match on a fragile prefix", () => {
    expect(filterSnavRowsByDate([row({ id: "a", departure_date: "2026-08-30" })], "2026-08-3")).toEqual([]);
  });
});

describe("resolveOperationalDate — Europe/Rome civil day", () => {
  it("defaults to today in Europe/Rome when no param is given", () => {
    expect(resolveOperationalDate(null, new Date("2026-08-30T00:30:00.000Z"))).toEqual({ ok: true, date: "2026-08-30" });
  });
  it("rejects a non-ISO date param", () => {
    expect(resolveOperationalDate("30/08/2026").ok).toBe(false);
  });
});

describe("classifyRowState / isExpectedConvocation", () => {
  it("maps statuses to send states", () => {
    expect(classifyRowState("inviato")).toBe("sent");
    expect(classifyRowState("errore")).toBe("failed");
    expect(classifyRowState("numero_non_valido")).toBe("failed");
    expect(classifyRowState("pronto")).toBe("not_sent");
    expect(classifyRowState("da_inviare")).toBe("not_sent");
  });
  it("treats inviare=true, non escluso/duplicato rows as expected", () => {
    expect(isExpectedConvocation({ inviare: true, status: "pronto" })).toBe(true);
    expect(isExpectedConvocation({ inviare: true, status: "inviato" })).toBe(true);
    expect(isExpectedConvocation({ inviare: false, status: "escluso" })).toBe(false);
    expect(isExpectedConvocation({ inviare: true, status: "duplicato" })).toBe(false);
  });
});

describe("extractMetaErrorCode", () => {
  it("reads a bracketed / worded / structured code", () => {
    expect(extractMetaErrorCode("[#131049] blocked", null)).toBe("131049");
    expect(extractMetaErrorCode("paused - code 132000", null)).toBe("132000");
    expect(extractMetaErrorCode("x", { error: { code: 190 } })).toBe("190");
    expect(extractMetaErrorCode("generic", null)).toBeNull();
  });
});

describe("buildSnavWhatsAppLog — daily aggregation", () => {
  it("counts sent / failed / notSent and previste vs inviate", () => {
    const rows = [
      row({ id: "a", status: "inviato", customer_name: "Ada" }),
      row({ id: "b", status: "inviato", customer_name: "Bea" }),
      row({ id: "c", status: "errore", customer_name: "Cid", error_message: "[#131049] blocked" }),
      row({ id: "d", status: "pronto", customer_name: "Deo" }),
      row({ id: "e", status: "escluso", customer_name: "Eva", inviare: false }),
    ];
    const logs = [sendLog({ row_id: "a" }), sendLog({ row_id: "b" }), sendLog({ row_id: "c", status: "failed", error_message: "[#131049] blocked" })];

    const out = buildSnavWhatsAppLog(rows, NO_STATUSES, BATCHES, logs, OPERATORS);

    expect(out.summary).toMatchObject({ total: 5, sent: 2, failed: 1, notSent: 2 });
    expect(out.summary.expected).toBe(4);
    expect(out.summary.missing).toBe(2);
    expect(out.summary.successRate).toBe(40);
  });

  it("enriches rows with template / params / operator / batch label", () => {
    const [r] = buildSnavWhatsAppLog([row({ id: "a" })], NO_STATUSES, BATCHES, [sendLog({ row_id: "a" })], OPERATORS).rows;
    expect(r.template).toBe("partenze_snav");
    expect(r.params).toEqual(["Luca", "DOMENICA 30 AGOSTO", "Hotel Park Imperial", "3", "16:40", "17:40"]);
    expect(r.operator_name).toBe("Mario Rossi");
    expect(r.batch_label).toBe("SNAV 30/08");
  });

  it("uses the latest attempt on a resend", () => {
    const logs = [
      sendLog({ row_id: "a", attempt_number: 1, status: "failed", error_message: "[#131049] first" }),
      sendLog({ row_id: "a", attempt_number: 2, status: "sent", error_message: null }),
    ];
    const [r] = buildSnavWhatsAppLog([row({ id: "a", status: "inviato" })], NO_STATUSES, BATCHES, logs, OPERATORS).rows;
    expect(r.attempt_number).toBe(2);
  });

  it("resolves Meta status: sent (no webhook) → pending, delivered, read, failed", () => {
    const mk = (id: string, waId: string) => row({ id, status: "inviato", provider_message_id: waId });
    const rows = [mk("s", "w.s"), mk("d", "w.d"), mk("r", "w.r"), row({ id: "f", status: "errore", provider_message_id: "w.f", error_message: "[#131] x" })];
    const logs = rows.map((rr) => sendLog({ row_id: rr.id, provider_message_id: rr.provider_message_id!, status: rr.status === "errore" ? "failed" : "sent" }));
    const statuses: MessageStatusSource[] = [
      { wa_message_id: "w.d", status: "delivered", timestamp: "2026-08-29T10:00:00Z", created_at: "2026-08-29T10:00:00Z" },
      { wa_message_id: "w.r", status: "delivered", timestamp: "2026-08-29T10:00:00Z", created_at: "2026-08-29T10:00:00Z" },
      { wa_message_id: "w.r", status: "read", timestamp: "2026-08-29T10:05:00Z", created_at: "2026-08-29T10:05:00Z" },
      { wa_message_id: "w.f", status: "failed", timestamp: "2026-08-29T10:01:00Z", created_at: "2026-08-29T10:01:00Z" },
    ];
    const out = buildSnavWhatsAppLog(rows, statuses, BATCHES, logs, OPERATORS);
    const byId = Object.fromEntries(out.rows.map((r) => [r.row_id, r.status_group]));
    expect(byId["s"]).toBe("pending");
    expect(byId["d"]).toBe("delivered");
    expect(byId["r"]).toBe("read");
    expect(byId["f"]).toBe("failed");
    expect(out.summary.delivered).toBe(1);
    expect(out.summary.read).toBe(1);
  });

  it("does not inflate KPIs when the webhook sends the same status twice", () => {
    const statuses: MessageStatusSource[] = [
      { wa_message_id: "w.1", status: "read", timestamp: "2026-08-29T10:00:00Z", created_at: "2026-08-29T10:00:00Z" },
      { wa_message_id: "w.1", status: "read", timestamp: "2026-08-29T10:00:00Z", created_at: "2026-08-29T10:00:00Z" },
    ];
    const out = buildSnavWhatsAppLog(
      [row({ id: "a", status: "inviato", provider_message_id: "w.1" })],
      statuses,
      BATCHES,
      [sendLog({ row_id: "a", provider_message_id: "w.1" })],
      OPERATORS,
    );
    expect(out.rows).toHaveLength(1);
    expect(out.summary.read).toBe(1);
  });

  it("returns an all-zero summary for a day with no convocations", () => {
    const out = buildSnavWhatsAppLog([], NO_STATUSES, BATCHES, [], OPERATORS);
    expect(out.summary).toEqual({ total: 0, expected: 0, sent: 0, failed: 0, notSent: 0, missing: 0, delivered: 0, read: 0, pending: 0, successRate: 0, readRate: 0 });
    expect(out.rows).toEqual([]);
  });
});
