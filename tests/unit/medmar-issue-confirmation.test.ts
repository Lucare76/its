// NOTA: questo file usa un mock in-memory del client Supabase (nessun
// ambiente Supabase locale disponibile in questa sessione). Verifica la
// logica applicativa di issue-confirmation.ts (single-use, scope,
// scadenza) ma NON esercita realmente il vincolo UNIQUE(token) ne' la RLS
// della migration 0231 — quelli richiedono un test di integrazione contro
// Postgres reale, non presente in questa fase.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createConfirmationToken,
  consumeConfirmationToken,
  MedmarConfirmationInvalidError,
} from "@/lib/server/medmar-booking/issue-confirmation";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TENANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SVC_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SVC_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeFakeAdmin() {
  const rows: Array<Record<string, unknown>> = [];
  let seq = 0;

  const client = {
    from(table: string) {
      if (table !== "medmar_issue_confirmations") throw new Error(`unexpected table ${table}`);
      return {
        insert(values: Record<string, unknown>) {
          seq += 1;
          const now = Date.now();
          const row: Record<string, unknown> = {
            id: `conf-${seq}`,
            token: `token-${seq}`,
            expires_at: new Date(now + 5 * 60 * 1000).toISOString(),
            used_at: null,
            created_at: new Date(now).toISOString(),
            ...values,
          };
          rows.push(row);
          return {
            select: () => ({ single: async () => ({ data: row, error: null }) }),
          };
        },
        update(patch: Record<string, unknown>) {
          const filters: Array<(row: Record<string, unknown>) => boolean> = [];
          const builder = {
            eq(field: string, value: unknown) {
              filters.push((row) => row[field] === value);
              return builder;
            },
            is(field: string, value: unknown) {
              filters.push((row) => row[field] === value);
              return builder;
            },
            gt(field: string, value: unknown) {
              filters.push((row) => String(row[field]) > String(value));
              return builder;
            },
            select: () => ({
              maybeSingle: async () => {
                const match = rows.find((row) => filters.every((f) => f(row)));
                if (!match) return { data: null, error: null };
                Object.assign(match, patch);
                return { data: { ...match }, error: null };
              },
            }),
          };
          return builder;
        },
      };
    },
  };

  return { client: client as unknown as SupabaseClient, rows };
}

describe("medmar issue confirmation token (mock Supabase, no ambiente Postgres reale)", () => {
  it("crea un token e lo consuma una volta con successo", async () => {
    const { client } = makeFakeAdmin();
    const created = await createConfirmationToken(client, {
      tenantId: TENANT,
      serviceIds: [SVC_B, SVC_A],
      expectedTotalCents: 1150,
      routeSnapshot: { outward_id_corsa: 1 },
      createdBy: USER,
    });
    expect(created.confirmation_token).toBeTruthy();

    const consumed = await consumeConfirmationToken(client, {
      tenantId: TENANT,
      token: created.confirmation_token,
      serviceIds: [SVC_A, SVC_B],
    });
    expect(consumed.expected_total_cents).toBe(1150);
    expect(consumed.service_ids).toEqual([SVC_A, SVC_B].sort());
  });

  it("token riusato -> seconda consume fallisce (single-use)", async () => {
    const { client } = makeFakeAdmin();
    const created = await createConfirmationToken(client, {
      tenantId: TENANT,
      serviceIds: [SVC_A],
      expectedTotalCents: 500,
      routeSnapshot: {},
      createdBy: USER,
    });
    await consumeConfirmationToken(client, { tenantId: TENANT, token: created.confirmation_token, serviceIds: [SVC_A] });
    await expect(
      consumeConfirmationToken(client, { tenantId: TENANT, token: created.confirmation_token, serviceIds: [SVC_A] })
    ).rejects.toBeInstanceOf(MedmarConfirmationInvalidError);
  });

  it("token sconosciuto -> consume fallisce", async () => {
    const { client } = makeFakeAdmin();
    await expect(
      consumeConfirmationToken(client, { tenantId: TENANT, token: "does-not-exist", serviceIds: [SVC_A] })
    ).rejects.toBeInstanceOf(MedmarConfirmationInvalidError);
  });

  it("token di un altro tenant -> consume fallisce (isolamento tenant)", async () => {
    const { client } = makeFakeAdmin();
    const created = await createConfirmationToken(client, {
      tenantId: TENANT,
      serviceIds: [SVC_A],
      expectedTotalCents: 500,
      routeSnapshot: {},
      createdBy: USER,
    });
    await expect(
      consumeConfirmationToken(client, { tenantId: OTHER_TENANT, token: created.confirmation_token, serviceIds: [SVC_A] })
    ).rejects.toBeInstanceOf(MedmarConfirmationInvalidError);
  });

  it("service_ids diversi da quelli del token -> consume fallisce (scope mismatch)", async () => {
    const { client } = makeFakeAdmin();
    const created = await createConfirmationToken(client, {
      tenantId: TENANT,
      serviceIds: [SVC_A],
      expectedTotalCents: 500,
      routeSnapshot: {},
      createdBy: USER,
    });
    await expect(
      consumeConfirmationToken(client, { tenantId: TENANT, token: created.confirmation_token, serviceIds: [SVC_B] })
    ).rejects.toBeInstanceOf(MedmarConfirmationInvalidError);
  });

  it("token scaduto -> consume fallisce", async () => {
    const { client, rows } = makeFakeAdmin();
    const created = await createConfirmationToken(client, {
      tenantId: TENANT,
      serviceIds: [SVC_A],
      expectedTotalCents: 500,
      routeSnapshot: {},
      createdBy: USER,
    });
    const row = rows.find((r) => r.token === created.confirmation_token)!;
    row.expires_at = new Date(Date.now() - 60_000).toISOString();
    await expect(
      consumeConfirmationToken(client, { tenantId: TENANT, token: created.confirmation_token, serviceIds: [SVC_A] })
    ).rejects.toBeInstanceOf(MedmarConfirmationInvalidError);
  });
});
