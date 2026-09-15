import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Fix P2 (audit pre-go-live) — Storage RLS bucket vehicle-documents:
 * supabase/migrations/0283_vehicle_documents_storage_tenant_role_isolation.sql.
 *
 * Verifica statica (source-contract) che le 4 policy select/insert/update/
 * delete su storage.objects deriveranno il tenant dal path
 * "${vehicleId}/..." via JOIN su public.vehicles (mai dal primo segmento
 * del path trattato come tenant_id diretto), restringano il ruolo ad
 * admin/operator/supervisor, TO authenticated (mai anon), e che l'helper
 * public.vehicle_document_object_authorized() sia usato in modo
 * consistente da tutte e 4. Same pattern di
 * tests/unit/bus-network-rls-role-hardening.test.ts.
 *
 * Scenari coperti (per costruzione della condizione, source-contract, non
 * esecuzione live contro Postgres):
 *  1. tenant A, proprio vehicle -> consentito
 *  2. tenant A, vehicle di tenant B -> negato
 *  3. admin/operator/supervisor -> consentiti
 *  4. driver/agency -> negati
 *  5. DELETE cross-tenant -> negato
 *  6. UPDATE/upsert stesso tenant -> consentito
 */

const sql = readFileSync(
  join(process.cwd(), "supabase/migrations/0283_vehicle_documents_storage_tenant_role_isolation.sql"),
  "utf8"
);

const CMDS = ["select", "insert", "update", "delete"] as const;

function extractPolicyBlock(cmd: string): string {
  const marker = `create policy vehicle_documents_${cmd}\n  on storage.objects for ${cmd}`;
  const start = sql.indexOf(marker);
  expect(start, `policy vehicle_documents_${cmd} non trovata`).toBeGreaterThan(-1);
  const end = sql.indexOf(");", start);
  return sql.slice(start, end + 2);
}

function extractFunctionBody(): string {
  const start = sql.indexOf("create or replace function public.vehicle_document_object_authorized");
  expect(start, "funzione vehicle_document_object_authorized non trovata").toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + 3);
}

describe("0283 — helper public.vehicle_document_object_authorized: tenant derivato dal vehicleId nel path", () => {
  const fn = extractFunctionBody();

  it("scenario 1/2 — join su public.vehicles per derivare tenant_id dal primo segmento del path (mai tenant_id diretto dal client)", () => {
    expect(fn).toMatch(/from public\.vehicles v/);
    expect(fn).toMatch(/v\.id\s*=/);
    expect(fn).toMatch(/storage\.foldername\(object_name\)\)\[1\]/);
    expect(fn).toMatch(/v\.tenant_id = public\.current_tenant_id\(\)/);
  });

  it("scenario 3/4 — solo admin/operator/supervisor; driver/agency mai citati nella funzione", () => {
    expect(fn).toMatch(/current_user_role\(\) in \('admin', 'operator', 'supervisor'\)/);
    expect(fn).not.toMatch(/'driver'/);
    expect(fn).not.toMatch(/'agency'/);
  });

  it("path con primo segmento non-UUID non solleva un errore di cast, viene semplicemente negato (CASE prima del ::uuid)", () => {
    expect(fn).toMatch(/case\s+when \(storage\.foldername\(object_name\)\)\[1\]/);
    expect(fn).toMatch(/then \(\(storage\.foldername\(object_name\)\)\[1\]\)::uuid/);
    expect(fn).toMatch(/else null/);
  });

  it("stable, non security definer (query solo public.vehicles, non public.memberships: nessun rischio di ricorsione RLS da evitare come in current_tenant_id/current_user_role)", () => {
    expect(fn).toMatch(/language sql\nstable/);
    expect(fn).not.toMatch(/security definer/);
  });
});

describe("0283 — 4 policy distinte su storage.objects, TO authenticated, bucket_id vehicle-documents, stesso helper", () => {
  it("drop idempotente + create per tutte e 4 le policy", () => {
    for (const cmd of CMDS) {
      expect(sql).toMatch(new RegExp(`drop policy if exists vehicle_documents_${cmd} on storage\\.objects;`));
      expect(sql).toMatch(new RegExp(`create policy vehicle_documents_${cmd}\\s*\\n  on storage\\.objects for ${cmd}`));
    }
  });

  it.each(CMDS)("%s: TO authenticated (mai anon/public), bucket_id = 'vehicle-documents', usa l'helper condiviso", (cmd) => {
    const block = extractPolicyBlock(cmd);
    expect(block).toMatch(/to authenticated/);
    expect(block).not.toMatch(/to (anon|public)\b/);
    expect(block).toMatch(/bucket_id = 'vehicle-documents'/);
    expect(block).toMatch(/public\.vehicle_document_object_authorized\(name\)/);
  });

  it("scenario 5 — DELETE: USING presente (nessun WITH CHECK, coerente con Postgres), stesso helper -> nega cross-tenant come le altre", () => {
    const block = extractPolicyBlock("delete");
    expect(block).toMatch(/using \(/);
    expect(block).not.toMatch(/with check/);
  });

  it("scenario 6 — UPDATE: sia USING che WITH CHECK presenti, necessari per upsert:true (overwrite reale su path esistente)", () => {
    const block = extractPolicyBlock("update");
    expect(block).toMatch(/using \(/);
    expect(block).toMatch(/with check \(/);
  });

  it("SELECT: solo USING, nessun WITH CHECK", () => {
    const block = extractPolicyBlock("select");
    expect(block).toMatch(/using \(/);
    expect(block).not.toMatch(/with check/);
  });

  it("INSERT: solo WITH CHECK, nessun USING", () => {
    const block = extractPolicyBlock("insert");
    expect(block).not.toMatch(/\busing\s*\(/);
    expect(block).toMatch(/with check \(/);
  });
});

describe("0283 — nessuna modifica a bucket config, altri bucket, tabella vehicle_documents, o service_role", () => {
  // Il file ha commenti esplicativi legittimi che citano altri bucket/tabelle/
  // service_role per dire "NON li tocco" (stesso stile di 0280) — qui
  // verifichiamo l'assenza di istruzioni SQL eseguibili, non l'assenza della
  // sola parola nei commenti: righe che iniziano con "--" vengono escluse.
  const codeOnly = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("nessun insert/update su storage.buckets (file_size_limit/allowed_mime_types restano quelli live, gia' corretti)", () => {
    expect(codeOnly).not.toMatch(/insert into storage\.buckets/i);
    expect(codeOnly).not.toMatch(/update storage\.buckets/i);
  });

  it("nessuna istruzione eseguibile riferita ad altri bucket (vehicle-damage-photos, bus-qr-codes, service-photos, backups)", () => {
    expect(codeOnly).not.toMatch(/vehicle-damage-photos/);
    expect(codeOnly).not.toMatch(/bus-qr-codes/);
    expect(codeOnly).not.toMatch(/service-photos/);
    expect(codeOnly).not.toMatch(/'backups'/);
  });

  it("nessuna istruzione eseguibile su public.vehicle_documents (tabella, RLS gia' corretta in 0191) o su service_role", () => {
    expect(codeOnly).not.toMatch(/alter table public\.vehicle_documents/i);
    expect(codeOnly).not.toMatch(/create table/i);
    expect(codeOnly).not.toMatch(/service_role/);
  });
});
