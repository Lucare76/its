/**
 * FASE A — catalogo compatto dei tool MCP esposti al router LLM di Mario.
 *
 * Espone SOLO tool categoria READ: i tool WRITE reali (its.assign_driver,
 * its.create_booking_group, its.operationalize_booking_group, ecc.) hanno
 * inputSchema { confirmationToken } e sono invocabili SOLO dall'orchestratore
 * dopo conferma esplicita dell'utente, mai scelti direttamente dall'LLM (il
 * modello non possiede mai un token — §11/§19). Filtrato anche per ruolo
 * (tool.allowedRoles): un supervisor non vede nemmeno le preview write che la
 * policy comunque negherebbe (es. its.preview_create_booking_group, il cui
 * allowedRoles esclude supervisor — §5/§17).
 *
 * NON invia mai al modello lo schema Zod completo: solo nome campo -> tipo
 * breve, best-effort, mai un'eccezione (introspezione difensiva).
 */
import { ZodEffects, ZodObject, ZodOptional, ZodNullable, ZodDefault, type ZodTypeAny } from "zod";
import { listTools } from "@/lib/mcp/registry";
import type { McpContext } from "@/lib/mcp/context";

export type MarioToolCatalogEntry = {
  name: string;
  description: string;
  category: string;
  input_schema_summary: Record<string, string>;
  write_requires_confirmation: boolean;
};

// Cost control (§16): tetto difensivo. Oggi i tool READ sono ~20: questo
// limite non dovrebbe mai scattare, ma evita che una crescita futura del
// registry gonfi silenziosamente il prompt.
const MAX_CATALOG_SIZE = 40;
const MAX_DESCRIPTION_CHARS = 240;

function unwrap(schema: ZodTypeAny): ZodTypeAny {
  if (schema instanceof ZodEffects) return unwrap(schema._def.schema as ZodTypeAny);
  if (schema instanceof ZodOptional) return unwrap(schema._def.innerType as ZodTypeAny);
  if (schema instanceof ZodNullable) return unwrap(schema._def.innerType as ZodTypeAny);
  if (schema instanceof ZodDefault) return unwrap(schema._def.innerType as ZodTypeAny);
  return schema;
}

function fieldLabel(fieldSchema: ZodTypeAny): string {
  const inner = unwrap(fieldSchema);
  let optional = false;
  try {
    optional = fieldSchema.isOptional() || fieldSchema.isNullable();
  } catch {
    optional = false;
  }
  const typeName = (inner as { _def?: { typeName?: string; values?: string[] } })._def?.typeName;
  const base =
    typeName === "ZodString" ? "string" :
    typeName === "ZodNumber" ? "number" :
    typeName === "ZodBoolean" ? "boolean" :
    typeName === "ZodEnum" ? `enum(${((inner as { _def: { values: string[] } })._def.values ?? []).join("|")})` :
    typeName === "ZodArray" ? "array" :
    "value";
  return optional ? `${base}?` : base;
}

/** Introspezione Zod best-effort: mai lancia, al massimo produce {}. */
function summarizeInputSchema(schema: ZodTypeAny): Record<string, string> {
  try {
    const obj = unwrap(schema);
    if (!(obj instanceof ZodObject)) return {};
    const shape = obj.shape as Record<string, ZodTypeAny>;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(shape)) out[key] = fieldLabel(value);
    return out;
  } catch {
    return {};
  }
}

/** Tool con schema { confirmationToken } soltanto: esecutori WRITE reali —
 *  difesa aggiuntiva anche se oggi questi tool sono già categoria WRITE
 *  (esclusi sotto a monte). Un tool così non deve MAI finire nel catalogo. */
function isTokenOnlyExecuteTool(schema: ZodTypeAny): boolean {
  const obj = unwrap(schema);
  if (!(obj instanceof ZodObject)) return false;
  const keys = Object.keys(obj.shape as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "confirmationToken";
}

export function buildMarioToolCatalog(context: Pick<McpContext, "role">): MarioToolCatalogEntry[] {
  const entries: MarioToolCatalogEntry[] = [];
  for (const tool of listTools()) {
    if (tool.category !== "READ") continue;
    if (!tool.allowedRoles.includes(context.role)) continue;
    const schema = tool.inputSchema as unknown as ZodTypeAny;
    if (isTokenOnlyExecuteTool(schema)) continue;
    entries.push({
      name: tool.name,
      description: tool.description.slice(0, MAX_DESCRIPTION_CHARS),
      category: tool.category,
      input_schema_summary: summarizeInputSchema(schema),
      write_requires_confirmation: tool.name.startsWith("its.preview_"),
    });
    if (entries.length >= MAX_CATALOG_SIZE) break;
  }
  return entries;
}

export function isToolInCatalog(catalog: MarioToolCatalogEntry[], toolName: string): boolean {
  return catalog.some((t) => t.name === toolName);
}
