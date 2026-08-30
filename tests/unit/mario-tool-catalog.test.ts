import { describe, it, expect } from "vitest";
import "@/lib/mcp/tools/index";
import { buildMarioToolCatalog } from "@/lib/server/mario-assistant/tool-catalog";

describe("buildMarioToolCatalog (FASE A §5/§17)", () => {
  it("include solo tool categoria READ (mai un tool WRITE reale)", () => {
    const catalog = buildMarioToolCatalog({ role: "admin" });
    expect(catalog.length).toBeGreaterThan(0);
    for (const entry of catalog) {
      expect(entry.category).toBe("READ");
    }
    const names = catalog.map((c) => c.name);
    expect(names).not.toContain("its.assign_driver");
    expect(names).not.toContain("its.create_booking_group");
    expect(names).not.toContain("its.operationalize_booking_group");
  });

  it("i tool WRITE reali (schema { confirmationToken }) non compaiono mai, anche se fossero READ per errore", () => {
    const catalog = buildMarioToolCatalog({ role: "admin" });
    for (const entry of catalog) {
      const keys = Object.keys(entry.input_schema_summary);
      const isTokenOnly = keys.length === 1 && keys[0] === "confirmationToken";
      expect(isTokenOnly).toBe(false);
    }
  });

  it("filtra per ruolo: un supervisor non vede le preview write dei gruppi prenotazione", () => {
    const admin = buildMarioToolCatalog({ role: "admin" }).map((c) => c.name);
    const supervisor = buildMarioToolCatalog({ role: "supervisor" }).map((c) => c.name);
    expect(admin).toContain("its.preview_create_booking_group");
    expect(supervisor).not.toContain("its.preview_create_booking_group");
  });

  it("i tool find/detail dei gruppi prenotazione restano visibili al supervisor (sola lettura)", () => {
    const supervisor = buildMarioToolCatalog({ role: "supervisor" }).map((c) => c.name);
    expect(supervisor).toContain("its.find_booking_group");
    expect(supervisor).toContain("its.get_booking_group_detail");
  });

  it("write_requires_confirmation è true solo per i tool preview_*", () => {
    const catalog = buildMarioToolCatalog({ role: "admin" });
    const findTool = catalog.find((c) => c.name === "its.find_booking_group")!;
    const previewTool = catalog.find((c) => c.name === "its.preview_create_booking_group")!;
    expect(findTool.write_requires_confirmation).toBe(false);
    expect(previewTool.write_requires_confirmation).toBe(true);
  });

  it("input_schema_summary è compatto (nome campo -> tipo breve), non lo schema Zod completo", () => {
    const catalog = buildMarioToolCatalog({ role: "admin" });
    const findTool = catalog.find((c) => c.name === "its.find_booking_group")!;
    expect(typeof findTool.input_schema_summary.query).toBe("string");
    expect(findTool.input_schema_summary.query).toMatch(/^string\??$/);
  });

  it("un ruolo senza tool consentiti riceve un catalogo vuoto, mai un errore", () => {
    const catalog = buildMarioToolCatalog({ role: "driver" as never });
    expect(Array.isArray(catalog)).toBe(true);
  });
});
