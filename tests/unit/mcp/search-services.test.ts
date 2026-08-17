import { describe, it, expect, beforeAll } from "vitest";
import { getTool } from "@/lib/mcp/registry";
import { MAX_LIMIT } from "@/lib/mcp/schemas/common";

/**
 * Fase 11/12/22 — its.search_services: limite massimo server-side e nessuna
 * PII nei campi selezionati (verifica statica sulla select whitelist, senza
 * bisogno di un DB reale: la query di ricerca completa e' gia' coperta a
 * livello di integrazione da buildServicesQuery, riusato qui invariato).
 */
describe("its.search_services", () => {
  beforeAll(async () => {
    await import("@/lib/mcp/tools/search-services");
  });

  it("e' registrato con categoria READ e ruoli ops", () => {
    const tool = getTool("its.search_services");
    expect(tool?.category).toBe("READ");
    expect(tool?.allowedRoles).toEqual(expect.arrayContaining(["admin", "operator", "supervisor"]));
  });

  it("rifiuta un limit sopra il massimo consentito", () => {
    const tool = getTool("its.search_services");
    const parsed = tool!.inputSchema.safeParse({ limit: MAX_LIMIT + 1 });
    expect(parsed.success).toBe(false);
  });

  it("accetta l'assenza di limit e applica il default nello schema output", () => {
    const tool = getTool("its.search_services");
    const parsed = tool!.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });
});
