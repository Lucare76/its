import { describe, it, expect } from "vitest";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXCEL_TEMPLATES,
  getExcelTemplate,
  excelTemplatesByCategory,
  type ExcelTemplate,
} from "@/lib/excel-templates";
import { routeRoleMap } from "@/lib/rbac";

const REPO_ROOT = process.cwd();
const byId = (id: string) => EXCEL_TEMPLATES.find((t) => t.id === id);

describe("EXCEL_TEMPLATES — centralized registry", () => {
  it("1. registers the MEDMAR convocations template", () => {
    const t = byId("medmar-convocations");
    expect(t).toMatchObject<Partial<ExcelTemplate>>({
      id: "medmar-convocations",
      name: "Convocazioni MEDMAR",
      fileName: "Template_Convocazioni_MEDMAR.xlsx",
      category: "Convocazioni",
      moduleHref: "/medmar-convocations",
    });
    expect(t?.description).toContain("MEDMAR");
  });

  it("2. registers the SNAV convocations template", () => {
    const t = byId("snav-convocations");
    expect(t).toMatchObject<Partial<ExcelTemplate>>({
      id: "snav-convocations",
      name: "Convocazioni SNAV",
      fileName: "Template_Convocazioni_SNAV.xlsx",
      category: "Convocazioni",
      moduleHref: "/snav-convocations",
    });
    expect(t?.description).toContain("SNAV");
  });

  it("3. MEDMAR static URL is /templates/Template_Convocazioni_MEDMAR.xlsx", () => {
    expect(byId("medmar-convocations")?.href).toBe("/templates/Template_Convocazioni_MEDMAR.xlsx");
  });

  it("4. SNAV static URL is /templates/Template_Convocazioni_SNAV.xlsx", () => {
    expect(byId("snav-convocations")?.href).toBe("/templates/Template_Convocazioni_SNAV.xlsx");
  });

  it("8. every href is a static /templates/<fileName>.xlsx path (no API endpoint)", () => {
    for (const t of EXCEL_TEMPLATES) {
      expect(t.href).toBe(`/templates/${t.fileName}`);
      expect(t.href.startsWith("/templates/")).toBe(true);
      expect(t.href.endsWith(".xlsx")).toBe(true);
      expect(t.href).not.toMatch(/\/api\//);
    }
  });

  it("9. moduleHref points at the matching in-app module", () => {
    expect(byId("medmar-convocations")?.moduleHref).toBe("/medmar-convocations");
    expect(byId("snav-convocations")?.moduleHref).toBe("/snav-convocations");
  });

  it("ids are unique", () => {
    expect(new Set(EXCEL_TEMPLATES.map((t) => t.id)).size).toBe(EXCEL_TEMPLATES.length);
  });

  it("does not invent version / updatedAt", () => {
    for (const t of EXCEL_TEMPLATES) {
      expect(t.version).toBeUndefined();
      expect(t.updatedAt).toBeUndefined();
    }
  });

  it("getExcelTemplate resolves by id and returns undefined otherwise", () => {
    expect(getExcelTemplate("medmar-convocations")?.name).toBe("Convocazioni MEDMAR");
    expect(getExcelTemplate("does-not-exist")).toBeUndefined();
  });

  it("excelTemplatesByCategory groups both convocation templates together", () => {
    const groups = excelTemplatesByCategory();
    const conv = groups.find((g) => g.category === "Convocazioni");
    expect(conv?.templates.map((t) => t.id)).toEqual(["medmar-convocations", "snav-convocations"]);
  });
});

describe("official template files exist as static assets", () => {
  it("public/templates/Template_Convocazioni_MEDMAR.xlsx is present and non-empty", () => {
    const p = join(REPO_ROOT, "public", "templates", "Template_Convocazioni_MEDMAR.xlsx");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  it("public/templates/Template_Convocazioni_SNAV.xlsx is present and non-empty", () => {
    const p = join(REPO_ROOT, "public", "templates", "Template_Convocazioni_SNAV.xlsx");
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).size).toBeGreaterThan(0);
  });

  it("every registered template href maps to a real file under public/", () => {
    for (const t of EXCEL_TEMPLATES) {
      const p = join(REPO_ROOT, "public", ...t.href.split("/").filter(Boolean));
      expect(existsSync(p), `missing ${t.href}`).toBe(true);
    }
  });
});

describe("RBAC — /excel-templates follows the convocations policy", () => {
  const entry = routeRoleMap.find((r) => r.prefix === "/excel-templates");

  it("5. is registered for admin / operator / supervisor", () => {
    expect(entry).toBeDefined();
    expect(entry?.roles).toEqual(expect.arrayContaining(["admin", "operator", "supervisor"]));
  });

  it("does not grant agency or driver", () => {
    expect(entry?.roles).not.toContain("agency");
    expect(entry?.roles).not.toContain("driver");
  });

  it("matches the convocations modules' role set exactly", () => {
    const medmar = routeRoleMap.find((r) => r.prefix === "/medmar-convocations");
    expect([...(entry?.roles ?? [])].sort()).toEqual([...(medmar?.roles ?? [])].sort());
  });
});

describe("module pages — regression: still present and wired", () => {
  it("10/11. /medmar-convocations and /snav-convocations pages exist and embed the download card", () => {
    for (const [file, id] of [
      ["app/(app)/medmar-convocations/page.tsx", "medmar-convocations"],
      ["app/(app)/snav-convocations/page.tsx", "snav-convocations"],
    ] as const) {
      const p = join(REPO_ROOT, ...file.split("/"));
      expect(existsSync(p)).toBe(true);
      const src = readFileSync(p, "utf8");
      expect(src).toContain("ExcelTemplateDownloadCard");
      expect(src).toContain(`getExcelTemplate("${id}")`);
    }
  });

  it("12. /bus-convocations page exists and was not given a (non-existent) bus template", () => {
    const p = join(REPO_ROOT, "app", "(app)", "bus-convocations", "page.tsx");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).not.toContain("ExcelTemplateDownloadCard");
    expect(EXCEL_TEMPLATES.some((t) => t.moduleHref === "/bus-convocations")).toBe(false);
  });

  it("6/7. the central page renders from EXCEL_TEMPLATES (no hardcoded cards)", () => {
    const p = join(REPO_ROOT, "app", "(app)", "excel-templates", "page.tsx");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toContain("excelTemplatesByCategory");
    expect(src).not.toContain("Template_Convocazioni_MEDMAR.xlsx"); // filename only lives in the registry
    expect(src).not.toContain("Template_Convocazioni_SNAV.xlsx");
  });
});
