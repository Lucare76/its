import { describe, it, expect } from "vitest";
import {
  getServiceTimelinePage,
  dedupeTimelineEvents,
  encodeCursor,
  decodeCursor,
  isValidUuid,
  type TimelineEvent,
} from "@/lib/server/service-timeline";

/**
 * Timeline per-servizio — aggregatore in lettura. Fake admin client generico
 * (stesso pattern delle altre suite di questa sessione): ogni tabella ha un
 * seed array, i filtri (.eq/.in/.or/.lte/.order/.limit) sono applicati in
 * memoria. Nessuna scrittura reale, nessun DB. Ogni riga porta sempre
 * tenant_id: TENANT (salvo dove il test di isolamento tenant lo varia
 * deliberatamente) perché sia i fetch principali sia i resolver di nomi
 * (memberships/driver_profiles/tenant_bus_*) filtrano SEMPRE per tenant_id.
 */

type Row = Record<string, unknown>;

function applyOr(rows: Row[], expr: string): Row[] {
  const clauses = expr.split(",").map((c) => {
    const [col, , val] = c.split(".");
    return (r: Row) => r[col] === val;
  });
  return rows.filter((r) => clauses.some((fn) => fn(r)));
}

function createFakeAdmin(seed: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = [...(seed[table] ?? [])];
      let orderCol: string | null = null;
      let orderAsc = true;
      let limitN: number | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          const set = new Set(vals);
          rows = rows.filter((r) => set.has(r[col]));
          return builder;
        },
        or(expr: string) {
          rows = applyOr(rows, expr);
          return builder;
        },
        lte(col: string, val: unknown) {
          rows = rows.filter((r) => (r[col] as string) <= (val as string));
          return builder;
        },
        order(col: string, opts: { ascending: boolean }) {
          orderCol = col;
          orderAsc = opts.ascending;
          return builder;
        },
        limit(n: number) {
          limitN = n;
          return builder;
        },
        then(resolve: (v: { data: Row[]; error: null }) => void) {
          let result = rows;
          if (orderCol) {
            const col = orderCol;
            result = [...result].sort((a, b) => {
              const av = String(a[col]);
              const bv = String(b[col]);
              if (av === bv) return 0;
              return orderAsc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
            });
          }
          if (limitN != null) result = result.slice(0, limitN);
          resolve({ data: result, error: null });
        },
      };
      return builder;
    },
  } as any;
}

const TENANT = "11111111-1111-1111-1111-111111111111";
const SERVICE = "22222222-2222-2222-2222-222222222222";
const USER_A = "33333333-3333-3333-3333-333333333333";

const membershipRow = { tenant_id: TENANT, user_id: USER_A, full_name: "Mario Rossi" };
const driverProfileRow = { tenant_id: TENANT, id: "drv-1", full_name: "Luigi Bianchi" };
const busUnitRow = { tenant_id: TENANT, id: "bus-1", label: "BUS 1" };
const stopRows = [
  { tenant_id: TENANT, id: "stop-a", stop_name: "ROMA" },
  { tenant_id: TENANT, id: "stop-b", stop_name: "TERNI" },
];

describe("service-timeline — isValidUuid / cursor encode-decode", () => {
  it("isValidUuid accetta solo UUID validi", () => {
    expect(isValidUuid(SERVICE)).toBe(true);
    expect(isValidUuid("not-a-uuid")).toBe(false);
    expect(isValidUuid("'; drop table services; --")).toBe(false);
  });

  it("encodeCursor/decodeCursor sono simmetrici", () => {
    const cursor = { ts: "2026-01-01T10:00:00.000Z", id: "status_events:abc" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("decodeCursor su input corrotto ritorna null (mai un crash)", () => {
    expect(decodeCursor("not-base64-json")).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});

describe("getServiceTimelinePage — ID non valido", () => {
  it("un serviceId non-UUID ritorna pagina vuota senza interrogare nessuna tabella", async () => {
    const admin = createFakeAdmin({});
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: "not-a-uuid" });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("getServiceTimelinePage — 1. timeline multi-fonte ordinata", () => {
  it("unisce service_change_logs, status_events, bus_assignment_feedback, driver_assignment_history, service_deletion_log, whatsapp_events, service_audit_events e ordina per timestamp desc", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["pax"],
          before_data: { pax: 2 },
          after_data: { pax: 3 },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: "mario@example.com",
          created_at: "2026-01-05T10:00:00.000Z",
        },
      ],
      status_events: [
        { id: "se1", tenant_id: TENANT, service_id: SERVICE, status: "assigned", at: "2026-01-04T10:00:00.000Z", by_user_id: USER_A, notes: null },
      ],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [
        { id: "we1", tenant_id: TENANT, service_id: SERVICE, status: "sent", template: "reminder_24h", happened_at: "2026-01-03T10:00:00.000Z" },
      ],
      service_audit_events: [],
      memberships: [membershipRow],
    });

    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events.map((e) => e.originalSource)).toEqual(["service_change_logs", "status_events", "whatsapp_events"]);
    // desc: il più recente (2026-01-05) prima di tutti
    expect(page.events[0]!.timestamp).toBe("2026-01-05T10:00:00.000Z");
    expect(page.events[2]!.timestamp).toBe("2026-01-03T10:00:00.000Z");
  });
});

describe("getServiceTimelinePage — 2. stesso timestamp su più fonti", () => {
  it("due eventi con lo STESSO created_at da fonti diverse restano entrambi, ordine deterministico (per id)", async () => {
    const sameTs = "2026-02-01T09:00:00.000Z";
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [{ id: "se1", tenant_id: TENANT, service_id: SERVICE, status: "partito", at: sameTs, by_user_id: USER_A, notes: null }],
      bus_assignment_feedback: [
        {
          id: "bf1",
          tenant_id: TENANT,
          service_id: SERVICE,
          action_type: "initial_allocation",
          source: "manual",
          old_bus_unit_id: null,
          new_bus_unit_id: "bus-1",
          old_bus_line_id: null,
          new_bus_line_id: null,
          old_stop_id: null,
          new_stop_id: null,
          reason: null,
          created_by_user_id: USER_A,
          created_at: sameTs,
        },
      ],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
      tenant_bus_units: [busUnitRow],
    });

    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(2);
    expect(new Set(page.events.map((e) => e.timestamp))).toEqual(new Set([sameTs]));
    // Ordine deterministico: stabile a ripetute chiamate
    const page2 = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page2.events.map((e) => e.id)).toEqual(page.events.map((e) => e.id));
  });
});

describe("getServiceTimelinePage — 3. cursor pagination senza duplicati/perdite", () => {
  it("pagina 1 + pagina 2 = insieme completo, nessun duplicato, nessuna perdita", async () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({
      id: `se${i}`,
      tenant_id: TENANT,
      service_id: SERVICE,
      status: "assigned",
      at: new Date(2026, 0, 1, 0, i).toISOString(),
      by_user_id: USER_A,
      notes: null,
    }));
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: rows,
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
    });

    const page1 = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE, pageSize: 20 });
    expect(page1.events).toHaveLength(20);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE, pageSize: 20, cursor: page1.nextCursor });
    expect(page2.events).toHaveLength(20);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE, pageSize: 20, cursor: page2.nextCursor });
    expect(page3.events).toHaveLength(5);
    expect(page3.nextCursor).toBeNull();

    const allIds = [...page1.events, ...page2.events, ...page3.events].map((e) => e.id);
    expect(new Set(allIds).size).toBe(45); // nessun duplicato
    expect(allIds).toHaveLength(45); // nessuna perdita

    // ordine globale desc rispettato attraverso le pagine
    const timestamps = [...page1.events, ...page2.events, ...page3.events].map((e) => e.timestamp);
    const sorted = [...timestamps].sort().reverse();
    expect(timestamps).toEqual(sorted);
  });
});

describe("getServiceTimelinePage — 4/5/6/7. dedupe con precedenza esplicita (mai per testo)", () => {
  it("4. status: service_change_logs (ricco) sopprime lo status_events corrispondente entro la finestra", async () => {
    const t1 = "2026-03-01T10:00:00.000Z";
    const t2 = "2026-03-01T10:00:02.000Z"; // entro 5s
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["status"],
          before_data: { status: "new" },
          after_data: { status: "assigned" },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: t1,
        },
      ],
      status_events: [{ id: "se1", tenant_id: TENANT, service_id: SERVICE, status: "assigned", at: t2, by_user_id: USER_A, notes: null }],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.originalSource).toBe("service_change_logs");
  });

  it("status_events NON viene soppresso se il valore di stato non coincide (falso positivo evitato)", async () => {
    const t1 = "2026-03-01T10:00:00.000Z";
    const t2 = "2026-03-01T10:00:02.000Z";
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["status"],
          before_data: { status: "new" },
          after_data: { status: "assigned" },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: t1,
        },
      ],
      status_events: [{ id: "se1", tenant_id: TENANT, service_id: SERVICE, status: "partito", at: t2, by_user_id: USER_A, notes: null }],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(2);
  });

  it("5. cancellazione: service_change_logs CANCELLED sopresso quando esiste service_deletion_log corrispondente", async () => {
    const t1 = "2026-04-01T10:00:00.000Z";
    const t2 = "2026-04-01T10:00:01.000Z";
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "CANCELLED",
          changed_fields: ["status"],
          before_data: { status: "new" },
          after_data: { status: "cancelled" },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: t1,
        },
      ],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [
        { id: "dl1", tenant_id: TENANT, original_service_id: SERVICE, deleted_by_user_id: USER_A, deleted_by_name: "Mario Rossi", deleted_at: t2, notes: "richiesta cliente" },
      ],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.originalSource).toBe("service_deletion_log");
  });

  it("6. bus: service_change_logs con campo bus soppresso da bus_assignment_feedback corrispondente", async () => {
    const t1 = "2026-05-01T10:00:00.000Z";
    const t2 = "2026-05-01T10:00:03.000Z";
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["bus_unit_id"],
          before_data: { bus_unit_id: null },
          after_data: { bus_unit_id: "bus-1" },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: t1,
        },
      ],
      status_events: [],
      bus_assignment_feedback: [
        {
          id: "bf1",
          tenant_id: TENANT,
          service_id: SERVICE,
          action_type: "initial_allocation",
          source: "manual",
          old_bus_unit_id: null,
          new_bus_unit_id: "bus-1",
          old_bus_line_id: null,
          new_bus_line_id: null,
          old_stop_id: null,
          new_stop_id: null,
          reason: null,
          created_by_user_id: USER_A,
          created_at: t2,
        },
      ],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
      tenant_bus_units: [busUnitRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.originalSource).toBe("bus_assignment_feedback");
  });

  it("7. driver: service_change_logs con campo driver soppresso da driver_assignment_history corrispondente", async () => {
    const t1 = "2026-06-01T10:00:00.000Z";
    const t2 = "2026-06-01T10:00:04.000Z";
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["driver_user_id"],
          before_data: { driver_user_id: null },
          after_data: { driver_user_id: USER_A },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: t1,
        },
      ],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [
        {
          id: "dh1",
          tenant_id: TENANT,
          service_id: SERVICE,
          change_type: "driver_swap",
          from_driver_profile_id: null,
          to_driver_profile_id: "drv-1",
          from_vehicle_label: null,
          to_vehicle_label: null,
          operator_id: USER_A,
          created_at: t2,
        },
      ],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
      driver_profiles: [driverProfileRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.originalSource).toBe("driver_assignment_history");
  });
});

describe("getServiceTimelinePage — normalizzazione: bus/driver/service_change/whatsapp", () => {
  it("8. evento bus normalizzato: titolo leggibile con nomi risolti (mai raw id)", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [
        {
          id: "bf1",
          tenant_id: TENANT,
          service_id: SERVICE,
          action_type: "stop_change",
          source: "manual",
          old_bus_unit_id: null,
          new_bus_unit_id: null,
          old_bus_line_id: null,
          new_bus_line_id: null,
          old_stop_id: "stop-a",
          new_stop_id: "stop-b",
          reason: null,
          created_by_user_id: USER_A,
          created_at: "2026-07-01T10:00:00.000Z",
        },
      ],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
      tenant_bus_line_stops: stopRows,
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Mario Rossi ha spostato la fermata da ROMA a TERNI");
    expect(page.events[0]!.title).not.toContain("stop-a");
  });

  it("9. evento driver normalizzato: nome autista risolto, non l'id profilo", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [
        {
          id: "dh1",
          tenant_id: TENANT,
          service_id: SERVICE,
          change_type: "driver_swap",
          from_driver_profile_id: null,
          to_driver_profile_id: "drv-1",
          from_vehicle_label: null,
          to_vehicle_label: null,
          operator_id: USER_A,
          created_at: "2026-07-02T10:00:00.000Z",
        },
      ],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [membershipRow],
      driver_profiles: [driverProfileRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Mario Rossi ha assegnato l'autista Luigi Bianchi");
    expect(page.events[0]!.title).not.toContain("drv-1");
  });

  it("10. evento service_change normalizzato: CREATED/CANCELLED/updated mappati a eventType distinti", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl1",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "CREATED",
          changed_fields: ["customer_name"],
          before_data: {},
          after_data: { customer_name: "Rossi" },
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: "2026-07-03T10:00:00.000Z",
        },
      ],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.eventType).toBe("service_created");
    expect(page.events[0]!.title).toBe("Mario Rossi ha creato il servizio");
  });

  it("11. evento whatsapp minimale: actor 'provider', nessun nome umano inventato", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [{ id: "we1", tenant_id: TENANT, service_id: SERVICE, status: "failed", template: null, happened_at: "2026-07-04T10:00:00.000Z" }],
      service_audit_events: [],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.actor).toEqual({ type: "provider", name: "WhatsApp" });
    expect(page.events[0]!.severity).toBe("warning");
  });
});

describe("getServiceTimelinePage — service_audit_events (gap A-F)", () => {
  it("12a. restore normalizzato correttamente", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [
        {
          id: "ae1",
          tenant_id: TENANT,
          service_id: SERVICE,
          event_type: "service_restored",
          source: "manual",
          actor_user_id: USER_A,
          actor_name: "Mario Rossi",
          actor_email: null,
          reason: "Richiesta di cancellazione annullata",
          old_data: null,
          new_data: { status: "new" },
          metadata: null,
          created_at: "2026-08-01T10:00:00.000Z",
        },
      ],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Mario Rossi ha ripristinato il servizio");
    expect(page.events[0]!.reason).toBe("Richiesta di cancellazione annullata");
  });

  it("12a-bis. actor_name null (es. rimozione autista da assign-service-core.ts, niente query aggiuntiva in scrittura) -> risolto in lettura via memberships", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [
        {
          id: "ae2",
          tenant_id: TENANT,
          service_id: SERVICE,
          event_type: "driver_removed",
          source: "manual",
          actor_user_id: USER_A,
          actor_name: null,
          actor_email: null,
          reason: null,
          old_data: { driver_user_id: USER_A },
          new_data: null,
          metadata: null,
          created_at: "2026-08-01T11:00:00.000Z",
        },
      ],
      memberships: [membershipRow],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Mario Rossi ha rimosso l'autista");
    expect(page.events[0]!.actor.name).toBe("Mario Rossi");
  });

  it("12b-bis. import MTS Globe: titolo cita 'MTS Globe' (non lo slug import_mts_globe)", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [
        {
          id: "ae3",
          tenant_id: TENANT,
          service_id: SERVICE,
          event_type: "service_imported",
          source: "import_mts_globe",
          actor_user_id: USER_A,
          actor_name: "Mario Rossi",
          actor_email: null,
          reason: null,
          old_data: null,
          new_data: { voucher_no: "V1", source_import_id: null },
          metadata: null,
          created_at: "2026-08-04T10:00:00.000Z",
        },
      ],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Import MTS Globe ha creato il servizio");
  });

  it("12b. import strutturato: titolo cita la fonte, actor è l'operatore che ha lanciato l'import", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [
        {
          id: "ae1",
          tenant_id: TENANT,
          service_id: SERVICE,
          event_type: "service_imported",
          source: "import_excel",
          actor_user_id: USER_A,
          actor_name: null,
          actor_email: null,
          reason: null,
          old_data: null,
          new_data: { row_index: 3 },
          metadata: null,
          created_at: "2026-08-02T10:00:00.000Z",
        },
      ],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Import Excel ha creato il servizio");
    expect(page.events[0]!.actor.type).toBe("import");
  });

  it("12c. agency approval/rejection normalizzati con titoli distinti", async () => {
    const admin = createFakeAdmin({
      service_change_logs: [],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [
        {
          id: "ae1",
          tenant_id: TENANT,
          service_id: SERVICE,
          event_type: "agency_rejected",
          source: "agency_portal",
          actor_user_id: USER_A,
          actor_name: "Mario Rossi",
          actor_email: null,
          reason: "Prezzo non concordato",
          old_data: null,
          new_data: null,
          metadata: null,
          created_at: "2026-08-03T10:00:00.000Z",
        },
      ],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events[0]!.title).toBe("Mario Rossi ha rifiutato la richiesta agenzia");
    expect(page.events[0]!.reason).toBe("Prezzo non concordato");
  });
});

describe("getServiceTimelinePage — 13. tenant isolation", () => {
  it("eventi di un altro tenant non vengono mai restituiti, anche con lo stesso service_id", async () => {
    const otherTenant = "99999999-9999-9999-9999-999999999999";
    const admin = createFakeAdmin({
      service_change_logs: [
        {
          id: "cl-other-tenant",
          tenant_id: otherTenant,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["pax"],
          before_data: {},
          after_data: {},
          operator_user_id: USER_A,
          operator_name: "Estraneo",
          operator_email: null,
          created_at: "2026-09-01T10:00:00.000Z",
        },
        {
          id: "cl-my-tenant",
          tenant_id: TENANT,
          service_id: SERVICE,
          root_service_id: null,
          action: "updated",
          changed_fields: ["pax"],
          before_data: {},
          after_data: {},
          operator_user_id: USER_A,
          operator_name: "Mario Rossi",
          operator_email: null,
          created_at: "2026-09-01T09:00:00.000Z",
        },
      ],
      status_events: [],
      bus_assignment_feedback: [],
      driver_assignment_history: [],
      service_deletion_log: [],
      whatsapp_events: [],
      service_audit_events: [],
      memberships: [],
    });
    const page = await getServiceTimelinePage(admin, { tenantId: TENANT, serviceId: SERVICE });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.id).toBe("service_change_logs:cl-my-tenant");
  });
});

describe("dedupeTimelineEvents — funzione pura, testabile isolata", () => {
  it("nessun effetto su eventi senza sovrapposizione semantica", () => {
    const events: TimelineEvent[] = [
      { id: "a:1", timestamp: "2026-01-01T00:00:00.000Z", eventType: "x", source: "manual", actor: { type: "human", name: "X" }, title: "t1", originalSource: "status_events" },
      { id: "b:1", timestamp: "2026-01-01T00:00:01.000Z", eventType: "y", source: "manual", actor: { type: "human", name: "X" }, title: "t2", originalSource: "whatsapp_events" },
    ];
    expect(dedupeTimelineEvents(events)).toHaveLength(2);
  });
});
