import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Fix P0-1 (audit pre-go-live) — supabase/migrations/0279_whatsapp_rls_role_hardening.sql.
 * Verifica statica (source-contract) che le 4 tabelle whatsapp_* abbiano
 * 4 policy distinte (select/insert/update/delete), TO authenticated,
 * tenant-scoped, ristrette a admin/operator/supervisor, mai driver/agency,
 * mai una policy "for all".
 */

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0279_whatsapp_rls_role_hardening.sql"), "utf8");

const TABLES = ["whatsapp_contacts", "whatsapp_threads", "whatsapp_messages", "whatsapp_message_statuses"];
const CMDS = ["select", "insert", "update", "delete"] as const;

function extractPolicyBlock(table: string, cmd: string): string {
  const marker = `create policy ${table}_${cmd} on public.${table}`;
  const start = sql.indexOf(marker);
  expect(start, `policy ${table}_${cmd} non trovata`).toBeGreaterThan(-1);
  const end = sql.indexOf(");", start);
  return sql.slice(start, end + 2);
}

describe("0279 — nessuna policy 'for all' rimasta per le tabelle whatsapp", () => {
  it("non contiene 'for all' per nessuna delle 4 tabelle (solo drop dei vecchi nomi _tenant_all)", () => {
    for (const table of TABLES) {
      // Il vecchio nome deve solo comparire in un DROP, mai in un CREATE POLICY ... FOR ALL.
      expect(sql).toMatch(new RegExp(`drop policy if exists ${table}_tenant_all`));
      expect(sql).not.toMatch(new RegExp(`create policy ${table}_tenant_all[\\s\\S]{0,40}for all`));
    }
    expect(sql).not.toMatch(/create policy [a-z_]+\s*\nfor all/);
  });
});

describe.each(TABLES)("0279 — %s: 4 policy distinte, TO authenticated, admin/operator/supervisor", (table) => {
  it("esistono esattamente le 4 policy select/insert/update/delete (drop idempotente + create)", () => {
    for (const cmd of CMDS) {
      expect(sql).toMatch(new RegExp(`drop policy if exists ${table}_${cmd} on public\\.${table};`));
      expect(sql).toMatch(new RegExp(`create policy ${table}_${cmd} on public\\.${table}`));
    }
  });

  it.each(CMDS)("%s: TO authenticated, tenant-scoped, admin/operator/supervisor consentiti", (cmd) => {
    const block = extractPolicyBlock(table, cmd);
    expect(block).toMatch(new RegExp(`for ${cmd} to authenticated`));
    expect(block).toMatch(/tenant_id = public\.current_tenant_id\(\)/);
    expect(block).toMatch(/current_user_role\(\) in \('admin', 'operator', 'supervisor'\)/);
  });

  it.each(CMDS)("%s: driver/agency non compaiono mai nella clausola di ruolo", (cmd) => {
    const block = extractPolicyBlock(table, cmd);
    expect(block).not.toMatch(/'driver'/);
    expect(block).not.toMatch(/'agency'/);
  });

  it("insert/update hanno WITH CHECK oltre a USING dove previsto", () => {
    const insertBlock = extractPolicyBlock(table, "insert");
    expect(insertBlock).toMatch(/with check \(/);
    expect(insertBlock).not.toMatch(/\busing\s*\(/); // insert non ha mai USING

    const updateBlock = extractPolicyBlock(table, "update");
    expect(updateBlock).toMatch(/using \(/);
    expect(updateBlock).toMatch(/with check \(/);

    const selectBlock = extractPolicyBlock(table, "select");
    expect(selectBlock).toMatch(/using \(/);
    expect(selectBlock).not.toMatch(/with check/);

    const deleteBlock = extractPolicyBlock(table, "delete");
    expect(deleteBlock).toMatch(/using \(/);
    expect(deleteBlock).not.toMatch(/with check/);
  });
});

describe("0279 — nessuna modifica a struttura tabelle, GRANT, o service role", () => {
  it("nessuna istruzione ALTER TABLE ... ADD/DROP COLUMN, nessun CREATE TABLE, nessuna istruzione GRANT/REVOKE eseguibile", () => {
    expect(sql).not.toMatch(/alter table[\s\S]{0,60}(add column|drop column)/i);
    expect(sql).not.toMatch(/create table/i);
    // "grant"/"revoke" compaiono solo nel commento esplicativo (per dire che
    // NON vengono toccati) — qui verifichiamo l'assenza di istruzioni SQL
    // reali (che inizierebbero a inizio riga, non dentro un commento "--").
    expect(sql).not.toMatch(/^\s*grant\s|^\s*revoke\s/im);
  });

  it("nessun riferimento a service_role (bypassa RLS per definizione, non deve comparire come ruolo di policy)", () => {
    expect(sql).not.toMatch(/service_role/);
  });
});
