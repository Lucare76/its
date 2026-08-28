// Centralized registry of the OFFICIAL ITS Excel templates.
//
// Single source of truth: the /excel-templates page, the per-module download
// cards, the sidebar entry and the tests all read from EXCEL_TEMPLATES here —
// nothing about a template is hardcoded anywhere else. Adding a new official
// template = one entry in this array + dropping the .xlsx into
// public/templates/ (served statically by Next.js, no API, no storage).
//
// The .xlsx files themselves are never generated or transformed by the app —
// they are committed as-is under public/templates/.

export type ExcelTemplate = {
  /** Stable slug, also used as React key. */
  id: string;
  /** Human name shown on the card / button context. */
  name: string;
  /** One-line explanation of what the template is for. */
  description: string;
  /** Exact file name as committed under public/templates/. */
  fileName: string;
  /** Public static URL — always `/templates/<fileName>`. */
  href: string;
  /** Optional in-app module this template feeds; renders an "Apri modulo" link. */
  moduleHref?: string;
  /** Grouping label for the central page. */
  category: string;
  /** Optional — only set when a real published version exists. Never invent one. */
  version?: string;
  /** Optional ISO date of the last real update. Never invent one. */
  updatedAt?: string;
};

export const EXCEL_TEMPLATES: ExcelTemplate[] = [
  {
    id: "medmar-convocations",
    name: "Convocazioni MEDMAR",
    description:
      "Modello ufficiale per l’invio massivo delle convocazioni MEDMAR tramite WhatsApp.",
    fileName: "Template_Convocazioni_MEDMAR.xlsx",
    href: "/templates/Template_Convocazioni_MEDMAR.xlsx",
    moduleHref: "/medmar-convocations",
    category: "Convocazioni",
  },
  {
    id: "snav-convocations",
    name: "Convocazioni SNAV",
    description:
      "Modello ufficiale per l’invio massivo delle convocazioni SNAV tramite WhatsApp.",
    fileName: "Template_Convocazioni_SNAV.xlsx",
    href: "/templates/Template_Convocazioni_SNAV.xlsx",
    moduleHref: "/snav-convocations",
    category: "Convocazioni",
  },
];

/** Lookup by id — returns undefined when not registered. */
export function getExcelTemplate(id: string): ExcelTemplate | undefined {
  return EXCEL_TEMPLATES.find((t) => t.id === id);
}

/** Templates grouped by their `category`, preserving array order. */
export function excelTemplatesByCategory(): Array<{ category: string; templates: ExcelTemplate[] }> {
  const groups: Array<{ category: string; templates: ExcelTemplate[] }> = [];
  for (const template of EXCEL_TEMPLATES) {
    let group = groups.find((g) => g.category === template.category);
    if (!group) {
      group = { category: template.category, templates: [] };
      groups.push(group);
    }
    group.templates.push(template);
  }
  return groups;
}
