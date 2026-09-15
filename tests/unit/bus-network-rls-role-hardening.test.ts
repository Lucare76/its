import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Fix P0-2 (audit pre-go-live) — supabase/migrations/0280_bus_network_rls_role_hardening.sql.
 * Verifica statica (source-contract) che le 5 tabelle bus-network abbiano
 * 4 policy distinte (select/insert/update/delete), TO authenticated,
 * tenant-scoped: SELECT ad admin/operator/supervisor, INSERT/UPDATE/DELETE
 * SOLO ad admin/operator (supervisor legge, non modifica), mai driver/
 * agency, mai una policy "for all".
 */

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0280_bus_network_rls_role_hardening.sql"), "utf8");

const TABLES = [
  "tenant_bus_lines",
  "tenant_bus_line_stops",
  "tenant_bus_units",
  "tenant_bus_allocations",
  "tenant_bus_allocation_moves",
];
const CMDS = ["select", "insert", "update", "delete"] as const;
const WRITE_CMDS = ["insert", "update", "delete"] as const;

function extractPolicyBlock(table: string, cmd: string): string {
  const marker = `create policy ${table}_${cmd} on public.${table}`;
  const start = sql.indexOf(marker);
  expect(start, `policy ${table}_${cmd} non trovata`).toBeGreaterThan(-1);
  const end = sql.indexOf(");", start);
  return sql.slice(start, end + 2);
}

describe("0280 — nessuna policy 'for all' rimasta per le tabelle bus-network", () => {
  it("non contiene 'for all' per nessuna delle 5 tabelle (solo drop dei vecchi nomi _tenant_all)", () => {
    for (const table of TABLES) {
      expect(sql).toMatch(new RegExp(`drop policy if exists ${table}_tenant_all`));
      expect(sql).not.toMatch(new RegExp(`create policy ${table}_tenant_all[\\s\\S]{0,40}for all`));
    }
    expect(sql).not.toMatch(/create policy [a-z_]+\s*\nfor all/);
  });
});

describe("0280 — drop idempotente delle policy legacy admin_only_* (root cause del leak cross-tenant)", () => {
  it.each(TABLES)("elimina admin_only_select/insert/update/delete su %s prima di creare le nuove policy", (table) => {
    for (const cmd of CMDS) {
      const dropRe = new RegExp(`drop policy if exists admin_only_${cmd} on public\\.${table};`);
      expect(sql, `manca il drop di admin_only_${cmd} su ${table}`).toMatch(dropRe);
      const dropIdx = sql.search(dropRe);
      const createIdx = sql.indexOf(`create policy ${table}_${cmd} on public.${table}`);
      expect(dropIdx, `drop di admin_only_${cmd} deve precedere la create della nuova policy su ${table}`).toBeLessThan(createIdx);
    }
  });
});

describe.each(TABLES)("0280 — %s: 4 policy distinte, SELECT letto da supervisor, scrittura solo admin/operator", (table) => {
  it("esistono esattamente le 4 policy select/insert/update/delete (drop idempotente + create)", () => {
    for (const cmd of CMDS) {
      expect(sql).toMatch(new RegExp(`drop policy if exists ${table}_${cmd} on public\\.${table};`));
      expect(sql).toMatch(new RegExp(`create policy ${table}_${cmd} on public\\.${table}`));
    }
  });

  it("SELECT: TO authenticated, tenant-scoped, admin/operator/supervisor consentiti", () => {
    const block = extractPolicyBlock(table, "select");
    expect(block).toMatch(/for select to authenticated/);
    expect(block).toMatch(/tenant_id = public\.current_tenant_id\(\)/);
    expect(block).toMatch(/current_user_role\(\) in \('admin', 'operator', 'supervisor'\)/);
  });

  it.each(WRITE_CMDS)("%s: TO authenticated, tenant-scoped, SOLO admin/operator (supervisor escluso)", (cmd) => {
    const block = extractPolicyBlock(table, cmd);
    expect(block).toMatch(new RegExp(`for ${cmd} to authenticated`));
    expect(block).toMatch(/tenant_id = public\.current_tenant_id\(\)/);
    expect(block).toMatch(/current_user_role\(\) in \('admin', 'operator'\)/);
    // Deve essere ESATTAMENTE ('admin', 'operator') — non deve contenere 'supervisor' in questa clausola.
    expect(block).not.toMatch(/'supervisor'/);
  });

  it.each(CMDS)("%s: driver/agency non compaiono mai nella clausola di ruolo", (cmd) => {
    const block = extractPolicyBlock(table, cmd);
    expect(block).not.toMatch(/'driver'/);
    expect(block).not.toMatch(/'agency'/);
  });

  it("USING presente su select/update/delete, assente su insert; WITH CHECK presente su insert/update, assente su select/delete", () => {
    const selectBlock = extractPolicyBlock(table, "select");
    expect(selectBlock).toMatch(/using \(/);
    expect(selectBlock).not.toMatch(/with check/);

    const insertBlock = extractPolicyBlock(table, "insert");
    expect(insertBlock).not.toMatch(/\busing\s*\(/);
    expect(insertBlock).toMatch(/with check \(/);

    const updateBlock = extractPolicyBlock(table, "update");
    expect(updateBlock).toMatch(/using \(/);
    expect(updateBlock).toMatch(/with check \(/);

    const deleteBlock = extractPolicyBlock(table, "delete");
    expect(deleteBlock).toMatch(/using \(/);
    expect(deleteBlock).not.toMatch(/with check/);
  });
});

describe("0280 — nessuna modifica a struttura tabelle, RPC, GRANT, o service role", () => {
  it("nessuna istruzione ALTER TABLE ... ADD/DROP COLUMN, nessun CREATE TABLE, nessuna istruzione GRANT/REVOKE eseguibile", () => {
    expect(sql).not.toMatch(/alter table[\s\S]{0,60}(add column|drop column)/i);
    expect(sql).not.toMatch(/create table/i);
    // "grant"/"revoke" compaiono solo nel commento esplicativo (per dire che
    // NON vengono toccati) — qui verifichiamo l'assenza di istruzioni SQL
    // reali (che inizierebbero a inizio riga, non dentro un commento "--").
    expect(sql).not.toMatch(/^\s*grant\s|^\s*revoke\s/im);
  });

  it("nessun riferimento a service_role, nessuna ridefinizione delle RPC allocate_bus_service/move_bus_allocation", () => {
    expect(sql).not.toMatch(/service_role/);
    // Le RPC sono citate solo nel commento esplicativo ("NON modifica...
    // le RPC allocate_bus_service/move_bus_allocation") — qui verifichiamo
    // che non vengano MAI ridefinite (nessun CREATE [OR REPLACE] FUNCTION),
    // non che il loro nome sia assente dal file.
    expect(sql).not.toMatch(/create\s+(or replace\s+)?function/i);
  });
});
