/**
 * Test di integrazione — DELETE /api/ops/services/[id]
 *
 * Verifica:
 *  - Eliminazione definitiva da admin con registrazione in service_deletion_log
 *  - Risposta 401 senza token valido
 *  - Risposta 403 con ruolo non admin
 *  - Risposta 404 per servizio inesistente o di altro tenant
 *
 * Prerequisiti:
 *   - Supabase in esecuzione (locale o remote via .env.local)
 *   - Migration 0174 (service_deletion_log) già applicata
 */
import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DELETE } from "@/app/api/ops/services/[id]/route";
import { makeNextRequest, json, makeAnonClient } from "./helpers/client";
import {
  createTestContext,
  seedHotel,
  seedService,
  type TestContext,
} from "./helpers/seed";

let ctx: TestContext;
let hotelId: string;

// Token di un utente operator (non admin) creato in beforeAll
let operatorToken: string | null = null;
const operatorUserIds: string[] = [];

function makeParams(id: string) {
  return { params: { id } };
}

beforeAll(async () => {
  ctx = await createTestContext();
  hotelId = await seedHotel(ctx.admin, ctx.tenantId, {
    name: "Hotel Deletion Test",
    zone: "Ischia Porto",
  });

  // Crea un utente operator per testare il rifiuto 403
  const anon = makeAnonClient();
  const opEmail = `operator-deletion-test-${Date.now()}@test.invalid`;
  const opPassword = randomUUID();

  const { data: opUser, error: opErr } = await ctx.admin.auth.admin.createUser({
    email: opEmail,
    password: opPassword,
    email_confirm: true,
  });
  if (opErr || !opUser.user) throw new Error(`seed operator: ${opErr?.message}`);
  operatorUserIds.push(opUser.user.id);

  await ctx.admin.from("memberships").insert({
    tenant_id: ctx.tenantId,
    user_id: opUser.user.id,
    role: "operator",
    full_name: "Operator Test",
  });

  const { data: opSession } = await anon.auth.signInWithPassword({
    email: opEmail,
    password: opPassword,
  });
  operatorToken = opSession?.session?.access_token ?? null;
});

afterAll(async () => {
  // Pulisce i log di eliminazione creati durante i test (non FK ai servizi → sopravvivono)
  await ctx.admin.from("service_deletion_log").delete().eq("tenant_id", ctx.tenantId);
  // Elimina utente operator aggiuntivo
  for (const uid of operatorUserIds) {
    await ctx.admin.auth.admin.deleteUser(uid);
  }
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("service-deletion — happy path", () => {
  it("elimina il servizio e restituisce ok:true", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-01",
      time: "10:00",
      direction: "arrival",
      status: "cancelled",
      customer_name: "Da Eliminare",
      pax: 2,
    });

    const req = makeNextRequest("DELETE", {}, ctx.token);
    const res = await DELETE(req, makeParams(serviceId));
    const body = await json<{ ok: boolean }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("il servizio non esiste più in DB dopo l'eliminazione", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-02",
      time: "11:00",
      direction: "departure",
      status: "cancelled",
      customer_name: "Da Eliminare 2",
      pax: 3,
    });

    const req = makeNextRequest("DELETE", {}, ctx.token);
    await DELETE(req, makeParams(serviceId));

    const { data } = await ctx.admin
      .from("services")
      .select("id")
      .eq("id", serviceId)
      .maybeSingle();

    expect(data).toBeNull();
  });

  it("crea un record in service_deletion_log con dati corretti", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-03",
      time: "09:00",
      direction: "arrival",
      status: "cancelled",
      customer_name: "Audit Trail Test",
      pax: 4,
    });

    const req = makeNextRequest("DELETE", {}, ctx.token);
    await DELETE(req, makeParams(serviceId));

    const { data: log } = await ctx.admin
      .from("service_deletion_log")
      .select("original_service_id, customer_name, deleted_by_user_id, deleted_at, tenant_id")
      .eq("original_service_id", serviceId)
      .maybeSingle();

    expect(log).not.toBeNull();
    expect(log!.original_service_id).toBe(serviceId);
    expect(log!.customer_name).toBe("Audit Trail Test");
    expect(log!.deleted_by_user_id).toBe(ctx.userId);
    expect(log!.tenant_id).toBe(ctx.tenantId);
    expect(log!.deleted_at).not.toBeNull();
  });

  it("il log sopravvive alla cancellazione del servizio (audit permanente)", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-04",
      time: "08:00",
      direction: "arrival",
      status: "cancelled",
      customer_name: "Sopravvissuto",
      pax: 1,
    });

    const req = makeNextRequest("DELETE", {}, ctx.token);
    await DELETE(req, makeParams(serviceId));

    // Il servizio è sparito
    const { data: svc } = await ctx.admin
      .from("services")
      .select("id")
      .eq("id", serviceId)
      .maybeSingle();
    expect(svc).toBeNull();

    // Il log esiste ancora
    const { data: log } = await ctx.admin
      .from("service_deletion_log")
      .select("id")
      .eq("original_service_id", serviceId)
      .maybeSingle();
    expect(log).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("service-deletion — autorizzazione", () => {
  it("risponde 401 senza token", async () => {
    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-10",
      status: "cancelled",
    });

    const req = makeNextRequest("DELETE", {}, "token-non-valido");
    const res = await DELETE(req, makeParams(serviceId));

    expect(res.status).toBe(401);

    // Il servizio NON deve essere stato eliminato
    const { data } = await ctx.admin
      .from("services")
      .select("id")
      .eq("id", serviceId)
      .maybeSingle();
    expect(data).not.toBeNull();
  });

  it("risponde 403 per utente con ruolo operator (non admin)", async () => {
    if (!operatorToken) {
      console.warn("operatorToken non disponibile, test saltato");
      return;
    }

    const serviceId = await seedService(ctx.admin, ctx.tenantId, hotelId, {
      date: "2026-07-11",
      status: "cancelled",
    });

    const req = makeNextRequest("DELETE", {}, operatorToken);
    const res = await DELETE(req, makeParams(serviceId));

    expect(res.status).toBe(403);

    // Il servizio NON deve essere stato eliminato
    const { data } = await ctx.admin
      .from("services")
      .select("id")
      .eq("id", serviceId)
      .maybeSingle();
    expect(data).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("service-deletion — servizio non trovato", () => {
  it("risponde 404 per serviceId inesistente", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const req = makeNextRequest("DELETE", {}, ctx.token);
    const res = await DELETE(req, makeParams(fakeId));

    expect(res.status).toBe(404);
  });

  it("risponde 404 per servizio di un altro tenant (isolamento dati)", async () => {
    // Crea un secondo tenant isolato per verificare l'isolamento
    const { createTestContext: createCtx2 } = await import("./helpers/seed");
    const ctx2 = await createCtx2();

    // Crea un servizio nel tenant 2 ma tenta di eliminarlo con il token del tenant 1
    const hotel2 = await seedHotel(ctx2.admin, ctx2.tenantId);
    const serviceInTenant2 = await seedService(ctx2.admin, ctx2.tenantId, hotel2, {
      date: "2026-07-20",
      status: "cancelled",
      customer_name: "Servizio Altro Tenant",
    });

    const req = makeNextRequest("DELETE", {}, ctx.token);
    const res = await DELETE(req, makeParams(serviceInTenant2));

    // Il servizio non è visibile al tenant 1 → 404
    expect(res.status).toBe(404);

    // Il servizio deve ancora esistere nel tenant 2
    const { data } = await ctx2.admin
      .from("services")
      .select("id")
      .eq("id", serviceInTenant2)
      .maybeSingle();
    expect(data).not.toBeNull();

    // Cleanup tenant 2
    await ctx2.admin.from("service_deletion_log").delete().eq("tenant_id", ctx2.tenantId);
    await ctx2.cleanup();
  });
});
