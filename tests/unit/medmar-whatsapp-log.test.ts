import { describe, it, expect } from "vitest";
import {
  filterMedmarRowsByDate,
  classifyRowState,
  extractMetaErrorCode,
  buildMedmarWhatsAppLog,
  type MedmarLogRowSource,
  type MedmarSendLogSource,
  type MedmarBatchSource,
  type MedmarOperatorSource,
} from "@/lib/server/medmar-whatsapp-log";
import { resolveOperationalDate } from "@/lib/medmar-date";
import type { MessageStatusSource } from "@/lib/server/whatsapp-log-shared";

function row(partial: Partial<MedmarLogRowSource> & { id: string }): MedmarLogRowSource {
  return {
    batch_id: "batch-1",
    customer_name: "Cliente",
    travel_date: "LUNEDÌ 07 SETTEMBRE",
    travel_date_iso: "2026-09-07",
    route: "Ischia → Napoli",
    departure_time: "11:10",
    passengers: "2",
    phone_raw: "3331234567",
    phone_e164: "+393331234567",
    status: "inviato",
    error_message: null,
    provider_message_id: null,
    sent_at: "2026-09-06T08:00:00.000Z",
    ...partial,
  };
}

function sendLog(partial: Partial<MedmarSendLogSource> & { row_id: string }): MedmarSendLogSource {
  return {
    id: `log-${Math.random().toString(36).slice(2)}`,
    operator_user_id: "op-1",
    template_name: "partenze_medmar",
    language_code: "it",
    variables_json: { "1": "Cliente", "2": "LUN 07 SET", "3": "Hotel X", "4": "2", "5": "10:00", "6": "11:10" },
    status: "sent",
    provider_message_id: null,
    error_message: null,
    api_response_json: null,
    attempt_number: 1,
    attempted_at: "2026-09-06T08:00:00.000Z",
    ...partial,
  };
}

const BATCHES: MedmarBatchSource[] = [{ id: "batch-1", file_name: "partenze_07-09.xlsx", label: "Partenze 07/09" }];
const OPERATORS: MedmarOperatorSource[] = [
  { user_id: "op-1", full_name: "Mario Rossi", email: "mario@example.test" },
  { user_id: "op-2", full_name: null, email: "anna@example.test" },
];

describe("filterMedmarRowsByDate — per-day filtering on the canonical DATE column", () => {
  it("keeps only rows whose travel_date_iso is an exact match for the requested day", () => {
    const rows = [
      row({ id: "a", travel_date_iso: "2026-09-07" }),
      row({ id: "b", travel_date_iso: "2026-09-08" }),
      row({ id: "c", travel_date_iso: null }),
    ];
    expect(filterMedmarRowsByDate(rows, "2026-09-07").map((r) => r.id)).toEqual(["a"]);
  });

  it("does not match on a fragile prefix / substring", () => {
    const rows = [row({ id: "a", travel_date_iso: "2026-09-07" })];
    expect(filterMedmarRowsByDate(rows, "2026-09-7")).toEqual([]);
    expect(filterMedmarRowsByDate(rows, "2026-09")).toEqual([]);
  });
});

describe("resolveOperationalDate — timezone-coherent day selection", () => {
  it("defaults to today in Europe/Rome when no date param is given", () => {
    const res = resolveOperationalDate(null, new Date("2026-08-28T00:30:00.000Z"));
    expect(res).toEqual({ ok: true, date: "2026-08-28" });
  });

  it("rejects a non-ISO date param instead of doing a fragile string compare", () => {
    expect(resolveOperationalDate("28/08/2026").ok).toBe(false);
    expect(resolveOperationalDate("2026-8-1").ok).toBe(false);
  });
});

describe("classifyRowState", () => {
  it("maps convocation row statuses to send states", () => {
    expect(classifyRowState("inviato")).toBe("sent");
    expect(classifyRowState("errore")).toBe("failed");
    expect(classifyRowState("numero_non_valido")).toBe("failed");
    expect(classifyRowState("pronto")).toBe("not_sent");
    expect(classifyRowState("da_inviare")).toBe("not_sent");
    expect(classifyRowState("da_reinviare")).toBe("not_sent");
    expect(classifyRowState("escluso")).toBe("not_sent");
  });
});

describe("extractMetaErrorCode", () => {
  it("reads the code from a bracketed Meta error string", () => {
    expect(extractMetaErrorCode("[#131049] This message was not delivered", null)).toBe("131049");
  });
  it("reads the code from a ' - code NNN' formatted string", () => {
    expect(extractMetaErrorCode("Template paused - details here - code 132000", null)).toBe("132000");
  });
  it("prefers a structured api_response_json payload", () => {
    expect(extractMetaErrorCode("whatever", { error: { code: 190 } })).toBe("190");
  });
  it("returns null when there is nothing parseable", () => {
    expect(extractMetaErrorCode("generic failure", null)).toBeNull();
    expect(extractMetaErrorCode(null, null)).toBeNull();
  });
});

describe("buildMedmarWhatsAppLog — daily aggregation", () => {
  const noStatuses: MessageStatusSource[] = [];

  it("includes every row of the day and reports the summary counts", () => {
    const rows = [
      row({ id: "a", status: "inviato", customer_name: "Ada" }),
      row({ id: "b", status: "errore", customer_name: "Bea", error_message: "[#131049] blocked" }),
      row({ id: "c", status: "da_inviare", customer_name: "Cid" }),
      row({ id: "d", status: "inviato", customer_name: "Deo" }),
    ];
    const logs = [
      sendLog({ row_id: "a", status: "sent" }),
      sendLog({ row_id: "b", status: "failed", error_message: "[#131049] blocked" }),
      sendLog({ row_id: "d", status: "sent" }),
    ];

    const out = buildMedmarWhatsAppLog(rows, noStatuses, BATCHES, logs, OPERATORS);

    expect(out.summary).toMatchObject({ total: 4, sent: 2, failed: 1, notSent: 1 });
    expect(out.summary.successRate).toBe(50); // 2 sent / 4 total
    expect(out.rows).toHaveLength(4);
    expect(out.failedRows.map((r) => r.customer_name)).toEqual(["Bea"]);
    expect(out.notSentRows.map((r) => r.customer_name)).toEqual(["Cid"]);
  });

  it("enriches rows with template, ordered params, operator name and batch label from the send log", () => {
    const rows = [row({ id: "a", status: "inviato" })];
    const logs = [sendLog({ row_id: "a", operator_user_id: "op-1" })];

    const [r] = buildMedmarWhatsAppLog(rows, noStatuses, BATCHES, logs, OPERATORS).rows;

    expect(r.template).toBe("partenze_medmar");
    expect(r.language_code).toBe("it");
    expect(r.params).toEqual(["Cliente", "LUN 07 SET", "Hotel X", "2", "10:00", "11:10"]);
    expect(r.operator_name).toBe("Mario Rossi");
    expect(r.batch_label).toBe("Partenze 07/09");
    expect(r.file_name).toBe("partenze_07-09.xlsx");
    expect(r.error_message).toBeNull();
    expect(r.error_code).toBeNull();
  });

  it("falls back to the operator email when full_name is missing", () => {
    const rows = [row({ id: "a" })];
    const logs = [sendLog({ row_id: "a", operator_user_id: "op-2" })];
    const [r] = buildMedmarWhatsAppLog(rows, noStatuses, BATCHES, logs, OPERATORS).rows;
    expect(r.operator_name).toBe("anna@example.test");
  });

  it("uses the most recent attempt when a row was resent", () => {
    const rows = [row({ id: "a", status: "inviato" })];
    const logs = [
      sendLog({ row_id: "a", attempt_number: 1, status: "failed", error_message: "[#131049] first try", template_name: "old_template" }),
      sendLog({ row_id: "a", attempt_number: 2, status: "sent", error_message: null, template_name: "partenze_medmar" }),
    ];
    const [r] = buildMedmarWhatsAppLog(rows, noStatuses, BATCHES, logs, OPERATORS).rows;
    expect(r.attempt_number).toBe(2);
    expect(r.template).toBe("partenze_medmar");
    // row.status is 'inviato' → send_state sent → error fields cleared
    expect(r.error_message).toBeNull();
  });

  it("surfaces the Meta error code and message for a failed row", () => {
    const rows = [row({ id: "a", status: "errore", error_message: "[#131049] not delivered" })];
    const logs = [sendLog({ row_id: "a", status: "failed", error_message: "[#131049] not delivered", api_response_json: { error: { code: 131049, message: "not delivered" } } })];
    const [r] = buildMedmarWhatsAppLog(rows, noStatuses, BATCHES, logs, OPERATORS).rows;
    expect(r.send_state).toBe("failed");
    expect(r.error_code).toBe("131049");
    expect(r.error_message).toContain("not delivered");
    expect(r.error_raw).toEqual({ error: { code: 131049, message: "not delivered" } });
    expect(r.status_group).toBe("failed");
  });

  it("lets a real webhook 'read' status override the row status in the KPI", () => {
    const rows = [row({ id: "a", status: "inviato", provider_message_id: "wamid.AAA" })];
    const logs = [sendLog({ row_id: "a", status: "sent", provider_message_id: "wamid.AAA" })];
    const statuses: MessageStatusSource[] = [
      { wa_message_id: "wamid.AAA", status: "delivered", timestamp: "2026-09-06T08:05:00.000Z", created_at: "2026-09-06T08:05:00.000Z" },
      { wa_message_id: "wamid.AAA", status: "read", timestamp: "2026-09-06T08:10:00.000Z", created_at: "2026-09-06T08:10:00.000Z" },
    ];
    const out = buildMedmarWhatsAppLog(rows, statuses, BATCHES, logs, OPERATORS);
    expect(out.rows[0].status_group).toBe("read");
    expect(out.summary.read).toBe(1);
    expect(out.summary.sent).toBe(1); // send_state is still 'sent'
  });

  it("reports a 0% success rate and no rows for an empty day", () => {
    const out = buildMedmarWhatsAppLog([], noStatuses, BATCHES, [], OPERATORS);
    expect(out.summary).toEqual({ total: 0, sent: 0, failed: 0, notSent: 0, delivered: 0, read: 0, successRate: 0 });
    expect(out.rows).toEqual([]);
  });
});
