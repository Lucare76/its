import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Correzione di sicurezza richiesta: service_audit_events deve essere
 * scrivibile SOLO da service role (server-side), mai da un utente
 * autenticato con ruolo admin/operator/supervisor via client user-scoped.
 *
 * Non abbiamo un DB Postgres live in questa suite (vitest, environment
 * "node", nessun accesso a Supabase reale) — quindi non possiamo eseguire
 * RLS reale. Questo file fa due cose complementari:
 *
 * 1. Un "simulatore" di policy che rispecchia ESATTAMENTE i predicati scritti
 *    in supabase/migrations/0278_service_audit_events.sql (SELECT
 *    tenant-scoped per admin/operator/supervisor; NESSUNA policy
 *    INSERT/UPDATE/DELETE per authenticated/anon — che in Postgres/RLS
 *    significa DENY implicito, non un bypass) — per dimostrare in modo
 *    eseguibile il contratto di permessi voluto.
 * 2. Verifica a livello di source che (a) la migration non contenga più la
 *    policy INSERT rimossa, (b) ogni write site del repo verso
 *    service_audit_events passi da un client service-role (mai un client
 *    utente), (c) il write helper applicativo non esponga alcuna funzione
 *    di update/delete (l'append-only è garantito anche a livello di
 *    codice, non solo di RLS).
 */

function read(relPath: string) {
  return readFileSync(join(process.cwd(), relPath), "utf8");
}

type Role = "admin" | "operator" | "supervisor" | "driver" | "agency" | null;
type Actor = { serviceRole: boolean; authenticated: boolean; role: Role; tenantId: string | null };

// Rispecchia 1:1 le policy in 0278_service_audit_events.sql.
function canSelect(actor: Actor, rowTenantId: string): boolean {
  if (actor.serviceRole) return true; // service role bypassa RLS per definizione (Postgres), non è una policy
  if (!actor.authenticated) return false;
  if (actor.tenantId !== rowTenantId) return false;
  return actor.role === "admin" || actor.role === "operator" || actor.role === "supervisor";
}

// Nessuna policy INSERT per authenticated/anon: DENY implicito qualunque sia il ruolo.
function canInsert(actor: Actor): boolean {
  return actor.serviceRole;
}

// Nessuna policy UPDATE/DELETE per authenticated/anon: DENY implicito.
function canUpdateOrDelete(actor: Actor): boolean {
  return actor.serviceRole;
}

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

describe("simulazione RLS service_audit_events — SELECT", () => {
  it("admin/operator/supervisor autenticati del proprio tenant possono leggere", () => {
    for (const role of ["admin", "operator", "supervisor"] as const) {
      expect(canSelect({ serviceRole: false, authenticated: true, role, tenantId: TENANT_A }, TENANT_A)).toBe(true);
    }
  });

  it("un ruolo non operativo (driver/agency) autenticato NON può leggere anche nel proprio tenant", () => {
    expect(canSelect({ serviceRole: false, authenticated: true, role: "driver", tenantId: TENANT_A }, TENANT_A)).toBe(false);
    expect(canSelect({ serviceRole: false, authenticated: true, role: "agency", tenantId: TENANT_A }, TENANT_A)).toBe(false);
  });

  it("un admin autenticato di un ALTRO tenant non può leggere righe di tenant_a (isolamento tenant)", () => {
    expect(canSelect({ serviceRole: false, authenticated: true, role: "admin", tenantId: TENANT_B }, TENANT_A)).toBe(false);
  });

  it("un utente non autenticato non può mai leggere", () => {
    expect(canSelect({ serviceRole: false, authenticated: false, role: null, tenantId: null }, TENANT_A)).toBe(false);
  });
});

describe("simulazione RLS service_audit_events — INSERT (la correzione richiesta)", () => {
  it("un admin/operator/supervisor autenticato NON può inserire direttamente (nessuna policy INSERT)", () => {
    for (const role of ["admin", "operator", "supervisor"] as const) {
      expect(canInsert({ serviceRole: false, authenticated: true, role, tenantId: TENANT_A })).toBe(false);
    }
  });

  it("solo il service role può inserire", () => {
    expect(canInsert({ serviceRole: true, authenticated: true, role: null, tenantId: null })).toBe(true);
  });
});

describe("simulazione RLS service_audit_events — UPDATE/DELETE (append-only)", () => {
  it("nessun ruolo autenticato può modificare o cancellare", () => {
    for (const role of ["admin", "operator", "supervisor", "driver", "agency"] as const) {
      expect(canUpdateOrDelete({ serviceRole: false, authenticated: true, role, tenantId: TENANT_A })).toBe(false);
    }
  });
});

describe("supabase/migrations/0278_service_audit_events.sql — nessuna policy INSERT client-side", () => {
  const sql = read("supabase/migrations/0278_service_audit_events.sql");

  it("NON contiene più 'create policy service_audit_events_insert ... for insert'", () => {
    expect(sql).not.toMatch(/create policy service_audit_events_insert[\s\S]*?for insert/);
  });

  it("contiene ancora esattamente una policy SELECT tenant-scoped per admin/operator/supervisor, esplicitamente TO authenticated", () => {
    const selectMatches = sql.match(/create policy service_audit_events_select/g) ?? [];
    expect(selectMatches).toHaveLength(1);
    expect(sql).toMatch(/for select to authenticated using \(\s*tenant_id = public\.current_tenant_id\(\)\s*and public\.current_user_role\(\) in \('admin', 'operator', 'supervisor'\)/);
  });

  it("nessuna policy UPDATE/DELETE", () => {
    expect(sql).not.toMatch(/for update/);
    expect(sql).not.toMatch(/for delete/);
  });

  it("mantiene i drop-policy difensivi/idempotenti per INSERT/UPDATE/DELETE (nel caso una bozza precedente fosse stata applicata)", () => {
    expect(sql).toMatch(/drop policy if exists service_audit_events_insert/);
    expect(sql).toMatch(/drop policy if exists service_audit_events_update/);
    expect(sql).toMatch(/drop policy if exists service_audit_events_delete/);
  });

  it("hardening a livello di GRANT (difesa in profondità, non solo RLS): REVOKE ALL da anon/authenticated, GRANT SELECT solo ad authenticated", () => {
    expect(sql).toMatch(/revoke all on public\.service_audit_events from anon;/);
    expect(sql).toMatch(/revoke all on public\.service_audit_events from authenticated;/);
    expect(sql).toMatch(/grant select on public\.service_audit_events to authenticated;/);
    expect(sql).not.toMatch(/grant insert|grant update|grant delete/);
    expect(sql).not.toMatch(/grant all on public\.service_audit_events/);
  });
});

describe("write helper — nessuna funzione di update/delete esposta (append-only anche a livello applicativo)", () => {
  const source = read("lib/server/service-audit-events.ts");
  it("espone solo insert (singolo e batch), mai update/delete", () => {
    expect(source).toMatch(/export async function recordServiceAuditEvent/);
    expect(source).toMatch(/export async function recordServiceAuditEventsBatch/);
    expect(source).not.toMatch(/\.update\(/);
    expect(source).not.toMatch(/\.delete\(\)/);
  });
});

describe("write site — TUTTI usano un client server-role, mai un client utente/anon", () => {
  const sites: Array<{ file: string; via: RegExp; note: string }> = [
    { file: "app/api/ops/cancellation-requests/[id]/restore/route.ts", via: /authorizePricingRequest/, note: "gap A restore" },
    { file: "app/api/excel/import/route.ts", via: /authorizePricingRequest/, note: "gap D import excel legacy" },
    { file: "app/api/excel/operational-v2-import/route.ts", via: /authorizePricingRequest/, note: "gap D import excel v2" },
    { file: "app/api/email/confirm-pdf/route.ts", via: /authorizePricingRequest/, note: "gap D import pdf agenzia (chiama confirmPdfImport)" },
    { file: "app/api/ops/modification-requests/[id]/resolve/route.ts", via: /authorizePricingRequest/, note: "gap E agency approval/rejection" },
    { file: "app/api/ops/booking-groups/route.ts", via: /authorizePricingRequest/, note: "gap F booking group (route HTTP)" },
    { file: "app/api/ops/assign-service/route.ts", via: /authorizePricingRequest/, note: "gap B/C driver/vehicle removed (route HTTP)" },
    { file: "lib/mcp/context.ts", via: /createClient\(supabaseUrl, serviceRoleKey/, note: "gap B/C driver/vehicle removed (tool MCP assign-driver, stesso assignServiceCore)" },
  ];

  it.each(sites)("$file — usa un client costruito con SUPABASE_SERVICE_ROLE_KEY (mai anon/user-scoped)", ({ file, via }) => {
    const source = read(file);
    expect(source).toMatch(via);
  });

  it("authorizePricingRequest/authorizeServiceRoleRequest e resolveMcpContext costruiscono l'admin con la service role key, non con la anon key", () => {
    const pricingAuth = read("lib/server/pricing-auth.ts");
    expect(pricingAuth).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(pricingAuth).toMatch(/const admin = createClient\(supabaseUrl, serviceRoleKey/);

    const mcpContext = read("lib/mcp/context.ts");
    expect(mcpContext).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(mcpContext).toMatch(/const admin = createClient\(supabaseUrl, serviceRoleKey/);
  });

  it("assignServiceCore/booking-groups-service.ts/agency-pdf-import.ts non costruiscono MAI un proprio client Supabase (ricevono sempre 'admin' già service-role dal chiamante)", () => {
    for (const file of ["lib/server/assign-service-core.ts", "lib/server/booking-groups-service.ts", "lib/server/agency-pdf-import.ts"]) {
      const source = read(file);
      expect(source).not.toMatch(/createClient\(/);
    }
  });
});
