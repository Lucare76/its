/**
 * FASE A.5.1 §A/§E/§F — idempotenza a livello di GRUPPO nell'orchestratore
 * Mario: prima di creare un nuovo `booking_group`, il gate deterministico
 * (`applyCreatePreviewPolicyGate` -> `checkGroupIdempotency`) verifica se ne
 * esiste già uno non cancellato con lo stesso nome (+ stessa data se nota) e,
 * se sì, riprende il workflow dal punto esatto in cui si trova NEL DB
 * (§20 `inspectOperationalBusGroupState`) invece di duplicarlo — sia per un
 * comando ripetuto nella stessa sessione (§1/§F) sia per una sessione nuova
 * dopo scadenza Redis (§19/§E, qui simulata seminando lo stato solo nel DB
 * fake, mai in sessione).
 *
 * Router LLM/runTool mockati come nelle altre suite mario-*-e2e; qui il
 * client `admin` è un vero fake DB in-memory (non `{}`), per esercitare
 * `findBookingGroups`/`inspectOperationalBusGroupState` realmente.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import type { McpContext } from "@/lib/mcp/context";
import { FakeUpstashRedis } from "./mario-fake-redis";

const mockGetTool = vi.fn();
const mockRunTool = vi.fn();
const mockRoute = vi.fn();

vi.mock("@/lib/mcp/registry", () => ({ getTool: (...a: unknown[]) => mockGetTool(...a), listTools: () => [] }));
vi.mock("@/lib/mcp/server", () => ({ runTool: (...a: unknown[]) => mockRunTool(...a) }));
vi.mock("@/lib/server/mario-assistant/llm-router", () => ({ routeMarioWithLlm: (...a: unknown[]) => mockRoute(...a) }));

const TENANT = "tenant-a";
const NOW = new Date("2026-09-01T09:00:00Z");
const ok = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }] });
const toolCall = (tool_name: string, args: Record<string, unknown>) => ({
  decision: { action: "tool_call" as const, tool_name, arguments: args, confidence: 0.95 },
  usage: { inputTokens: 1000, outputTokens: 60 },
  fallbackUsed: false,
  latencyMs: 10,
});

type Row = Record<string, unknown>;

/** Fake admin minimale (stesso pattern di booking-groups-service-a51.test.ts). */
function makeAdmin(seed: Record<string, Row[]> = {}) {
  function builder(table: string) {
    const filters: Row = {};
    const inFilters: Array<{ col: string; vals: unknown[] }> = [];
    const rowsForFilters = () =>
      (seed[table] ?? []).filter(
        (r) => Object.entries(filters).every(([k, v]) => r[k] === v) && inFilters.every(({ col, vals }) => vals.includes(r[col])),
      );
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.limit = () => b;
    b.eq = (col: string, val: unknown) => { filters[col] = val; return b; };
    b.in = (col: string, vals: unknown[]) => { inFilters.push({ col, vals }); return b; };
    b.maybeSingle = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
    b.single = async () => ({ data: rowsForFilters()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rowsForFilters(), error: null }).then(resolve);
    return b;
  }
  return { from: (t: string) => builder(t) } as unknown as McpContext["admin"];
}

let fake: FakeUpstashRedis;

beforeEach(async () => {
  vi.stubEnv("MARIO_LLM_ENABLED", "true");
  vi.spyOn(console, "info").mockImplementation(() => {});
  fake = new FakeUpstashRedis();
  const { __setSharedRedisForTests } = await import("@/lib/server/redis");
  __setSharedRedisForTests(fake as unknown as Redis);
  mockGetTool.mockReset().mockImplementation((name: string) => ({ name }));
  mockRunTool.mockReset();
  mockRoute.mockReset();
});
afterEach(async () => {
  const { __setSharedRedisForTests } = await import("@/lib/server/redis");
  __setSharedRedisForTests(undefined);
  const { __resetMarioSessionsForTests } = await import("@/lib/server/mario-assistant/session-context");
  __resetMarioSessionsForTests();
  vi.unstubAllEnvs();
});

async function run(ctx: McpContext, message: string) {
  const { runMarioAssistant } = await import("@/lib/server/mario-assistant/orchestrator");
  return runMarioAssistant(ctx, message, NOW);
}

describe("FASE A.5.1 §A/§F — idempotenza gruppo: comando ripetuto riusa, mai un secondo create", () => {
  it("gruppo esistente (andata completa, senza ritorno) -> resume diretto ad add_outbound_service, its.create_booking_group MAI chiamato", async () => {
    const admin = makeAdmin({
      booking_groups: [{ id: "BG1", tenant_id: TENANT, name: "La Marra", status: "draft", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50 }],
      booking_group_stops: [{ id: "STOP-OUT", tenant_id: TENANT, booking_group_id: "BG1", city: "Rimini", direction: "arrival", expected_pax: 50 }],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };

    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", kind: "bus_exclusive" }));
    // unica chiamata attesa a runTool: la preview del passo di resume (pax andata), MAI its.create_booking_group
    mockRunTool.mockResolvedValueOnce(ok({
      booking_group_id: "BG1", booking_group_stop_id: "STOP-OUT", group_name: "La Marra", stop_city: "Rimini",
      service_date: "2026-09-13", service_date_label: "13/09/2026", passenger_count: 1, total_pax: 50,
      stop_expected_pax: 50, stop_remaining_after: 0, warnings: [],
      confirmationToken: "TOK-PAX-OUT", expiresAt: "2026-09-01T09:03:00Z",
    }));

    const r = await run(ctx, "Caricami La Marra, 50 persone, Rimini, 13 settembre");

    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(mockRunTool.mock.calls[0]![1]).toMatchObject({ name: "its.preview_add_booking_group_passengers" });
    expect(r.intent).toBe("mario_operational_chain_pending");
  });

  it("più gruppi non cancellati con lo stesso nome -> clarification, nessun create automatico", async () => {
    const admin = makeAdmin({
      booking_groups: [
        { id: "BG1", tenant_id: TENANT, name: "La Marra", status: "draft", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50 },
        { id: "BG2", tenant_id: TENANT, name: "La Marra", status: "passengers_defined", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50 },
      ],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", kind: "bus_exclusive" }));

    const r = await run(ctx, "Caricami La Marra, 50 persone, Rimini, 13 settembre");

    expect(mockRunTool).not.toHaveBeenCalled();
    expect(r.intent).toBe("mario_llm_clarification");
    expect(r.answer).toMatch(/più gruppi/i);
  });

  it("gruppo cancellato con lo stesso nome -> NON blocca, procede a creare normalmente", async () => {
    const admin = makeAdmin({
      booking_groups: [{ id: "BG1", tenant_id: TENANT, name: "La Marra", status: "cancelled", kind: "bus_exclusive", service_date: "2026-09-13", expected_pax: 50 }],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", kind: "bus_exclusive" }));
    mockRunTool.mockResolvedValueOnce(ok({ name: "La Marra", expected_pax: 50, service_date: "2026-09-13", confirmationToken: "T1", expiresAt: "2026-09-01T09:03:00Z" }));

    const r = await run(ctx, "Caricami La Marra, 50 persone, Rimini, 13 settembre");

    expect(mockRunTool).toHaveBeenCalledTimes(1);
    expect(mockRunTool.mock.calls[0]![1]).toMatchObject({ name: "its.preview_create_booking_group" });
    expect(r.intent).toBe("mario_llm_pending_confirmation");
  });
});

describe("FASE A.5.1 §E — resume dopo Redis scaduto: stato ricostruito SOLO dal DB", () => {
  it("sessione nuova (Redis vuoto), gruppo già completo nel DB -> risposta di riuso, nessuna nuova operazione", async () => {
    const admin = makeAdmin({
      booking_groups: [{ id: "BG1", tenant_id: TENANT, name: "La Marra", status: "operational", kind: "bus_group", service_date: "2026-09-13", expected_pax: 50 }],
      booking_group_stops: [{ id: "STOP-OUT", tenant_id: TENANT, booking_group_id: "BG1", city: "Rimini", direction: "arrival", expected_pax: 50, stop_id: null, pickup_point: null }],
      services: [{ id: "SVC-1", tenant_id: TENANT, booking_group_id: "BG1", booking_group_stop_id: "STOP-OUT", pax: 50, direction: "arrival", is_draft: false, status: "confirmed", customer_name: "Gruppo La Marra", date: "2026-09-13", time: "05:10", bus_city_origin: "Rimini", booking_service_kind: "bus_city_hotel" }],
    });
    const ctx: McpContext = { requestId: "req-1", userId: "user-1", userEmail: "op@example.com", tenantId: TENANT, role: "operator", admin };
    // sessione (Redis) vuota per costruzione: nessun draft/pendingConfirmation seminato.
    mockRoute.mockResolvedValueOnce(toolCall("its.preview_create_booking_group", { name: "La Marra", expectedPax: 50, serviceDate: "2026-09-13", origin: "Rimini", kind: "bus_group" }));

    const r = await run(ctx, "Completa La Marra");

    expect(mockRunTool).not.toHaveBeenCalled();
    expect(r.intent).toBe("mario_operational_chain_reused");
    expect(r.answer).toMatch(/La Marra/);
    const { readMarioDraftOperation } = await import("@/lib/server/mario-assistant/session-context");
    expect(await readMarioDraftOperation(TENANT, "user-1")).toBeNull();
  });
});
