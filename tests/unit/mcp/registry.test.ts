import { describe, it, expect, beforeAll } from "vitest";
import { z } from "zod";
import { registerTool, listTools, getTool, __resetRegistryForTests } from "@/lib/mcp/registry";

/**
 * Fase 21 — Test tool registry. Verifica che il registry MCP applichi le
 * invarianti richieste dallo sprint: nomi unici, namespace its.*, categoria
 * dichiarata, allowedRoles dichiarati, e (Fase 21/27) nessun tool WRITE
 * registrato nello Sprint 1.
 */
describe("mcp registry", () => {
  beforeAll(() => {
    __resetRegistryForTests();
    registerTool({
      name: "its.__test_tool",
      description: "tool di test",
      category: "READ",
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      allowedRoles: ["admin"],
      handler: async () => ({}),
    });
  });

  it("rifiuta un nome duplicato", () => {
    expect(() =>
      registerTool({
        name: "its.__test_tool",
        description: "duplicato",
        category: "READ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        allowedRoles: ["admin"],
        handler: async () => ({}),
      })
    ).toThrow();
  });

  it("rifiuta un nome non namespaced its.*", () => {
    expect(() =>
      registerTool({
        name: "search_services",
        description: "senza namespace",
        category: "READ",
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        allowedRoles: ["admin"],
        handler: async () => ({}),
      })
    ).toThrow();
  });

  it("getTool/listTools restituiscono il tool registrato", () => {
    expect(getTool("its.__test_tool")).toBeDefined();
    expect(listTools().some((tool) => tool.name === "its.__test_tool")).toBe(true);
  });
});

describe("mcp production tool registry (its.* reali)", () => {
  beforeAll(async () => {
    __resetRegistryForTests();
    await import("@/lib/mcp/tools/index");
  });

  it("registra esattamente i 32 tool attesi (18 pre-FASE 3 + 14 gruppi prenotazione)", () => {
    const names = listTools()
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual(
      [
        "its.get_day_plan",
        "its.get_driver_availability",
        "its.get_fleet_status",
        "its.get_service",
        "its.search_services",
        "its.preview_assign_driver",
        "its.preview_update_service_status",
        "its.assign_driver",
        "its.update_service_status",
        // Sprint 5 — READ-only, riusano gli helper Health/Operational Health Sprint 1-4.
        "its.get_operational_brief",
        "its.get_health_status",
        "its.get_operational_alerts",
        "its.get_unassigned_services",
        // Assegnazione Intelligente — motore di scheduling operativo.
        "its.get_assignment_plan",
        "its.get_assignment_exceptions",
        "its.explain_assignment",
        "its.recalculate_assignment_plan",
        "its.lock_assignment",
        // FASE 3 — Mario / MCP per i gruppi prenotazione (3 READ + 5 PREVIEW + 6 WRITE).
        "its.find_booking_group",
        "its.get_booking_group_detail",
        "its.preview_booking_group_operationalization",
        "its.preview_create_booking_group",
        "its.preview_add_booking_group_stop",
        "its.preview_add_booking_group_passengers",
        "its.preview_reserve_booking_group_bus",
        "its.preview_update_booking_group_ferry",
        "its.create_booking_group",
        "its.add_booking_group_stop",
        "its.add_booking_group_passengers",
        "its.reserve_booking_group_bus",
        "its.update_booking_group_ferry",
        "its.operationalize_booking_group",
      ].sort()
    );
  });

  it("ogni tool ha nome unico, categoria, schema e allowedRoles", () => {
    const seen = new Set<string>();
    for (const tool of listTools()) {
      expect(seen.has(tool.name)).toBe(false);
      seen.add(tool.name);
      expect(tool.name.startsWith("its.")).toBe(true);
      expect(["READ", "WRITE", "DESTRUCTIVE", "EXTERNAL_ACTION"]).toContain(tool.category);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema).toBeDefined();
      expect(tool.allowedRoles.length).toBeGreaterThan(0);
    }
  });

  it("dieci tool WRITE (4 pre-FASE 3 + 6 gruppi prenotazione), nessun DESTRUCTIVE/EXTERNAL_ACTION", () => {
    const nonReadTools = listTools()
      .filter((tool) => tool.category !== "READ")
      .map((tool) => ({ name: tool.name, category: tool.category }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(nonReadTools).toEqual(
      [
        { name: "its.assign_driver", category: "WRITE" },
        { name: "its.update_service_status", category: "WRITE" },
        { name: "its.recalculate_assignment_plan", category: "WRITE" },
        { name: "its.lock_assignment", category: "WRITE" },
        { name: "its.create_booking_group", category: "WRITE" },
        { name: "its.add_booking_group_stop", category: "WRITE" },
        { name: "its.add_booking_group_passengers", category: "WRITE" },
        { name: "its.reserve_booking_group_bus", category: "WRITE" },
        { name: "its.update_booking_group_ferry", category: "WRITE" },
        { name: "its.operationalize_booking_group", category: "WRITE" },
      ].sort((a, b) => a.name.localeCompare(b.name))
    );
  });

  it("nessun tool espone nomi di query/CRUD generico o SQL diretto", () => {
    const forbiddenNames = ["execute_sql", "query_database", "run_supabase_query", "get_table", "update_record", "create_entity", "update_entity", "delete_entity"];
    const names = listTools().map((tool) => tool.name.replace("its.", ""));
    for (const forbidden of forbiddenNames) {
      expect(names).not.toContain(forbidden);
    }
  });
});
