import { describe, it, expect } from "vitest";
import { MAIN_NAV_BY_ROLE, canSeeNavItem } from "@/lib/app-shell-nav";
import { isAllowed } from "@/lib/rbac";
import type { UserRole } from "@/lib/types";

const MARIO_ASSISTANT_HREF = "/mario-assistant";

function findMarioItem(role: UserRole) {
  return MAIN_NAV_BY_ROLE[role].find((item) => item.href === MARIO_ASSISTANT_HREF);
}

describe("Sidebar 'Assistente Mario' — visibilità per ruolo (spec TEST MINIMI 1-5)", () => {
  it("1. presente per admin", () => {
    const item = findMarioItem("admin");
    expect(item).toBeDefined();
    expect(item?.label).toBe("Assistente Mario");
    expect(canSeeNavItem(item!, "admin", false)).toBe(true);
  });

  it("2. presente per supervisor", () => {
    const item = findMarioItem("supervisor");
    expect(item).toBeDefined();
    expect(canSeeNavItem(item!, "supervisor", false)).toBe(true);
  });

  it("3. presente per operator", () => {
    const item = findMarioItem("operator");
    expect(item).toBeDefined();
    expect(canSeeNavItem(item!, "operator", false)).toBe(true);
  });

  it("4. assente per driver (l'array nav di driver non contiene nemmeno la voce)", () => {
    expect(findMarioItem("driver")).toBeUndefined();
    expect(findMarioItem("autista")).toBeUndefined();
  });

  it("5. assente per agency (l'array nav di agency non contiene nemmeno la voce)", () => {
    expect(findMarioItem("agency")).toBeUndefined();
  });

  it("nessuna altra voce e' stata spostata: Piano del Giorno e Control Room restano al loro posto relativo", () => {
    const hrefs = MAIN_NAV_BY_ROLE.admin.map((item) => item.href);
    expect(hrefs).toContain("/piano-giorno");
    expect(hrefs).toContain("/mappa-live");
    expect(hrefs.indexOf("/piano-giorno")).toBeLessThan(hrefs.indexOf("/mario-assistant"));
  });

  it("protezione pagina: routeRoleMap nega /mario-assistant a driver/agency (riuso del sistema RBAC esistente, non solo assenza dal menu)", () => {
    expect(isAllowed(MARIO_ASSISTANT_HREF, "driver")).toBe(false);
    expect(isAllowed(MARIO_ASSISTANT_HREF, "agency")).toBe(false);
    expect(isAllowed(MARIO_ASSISTANT_HREF, "admin")).toBe(true);
    expect(isAllowed(MARIO_ASSISTANT_HREF, "operator")).toBe(true);
    expect(isAllowed(MARIO_ASSISTANT_HREF, "supervisor")).toBe(true);
  });
});
