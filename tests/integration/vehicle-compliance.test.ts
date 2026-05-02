import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { GET as getComplianceSummary } from "@/app/api/vehicles/compliance/summary/route";
import { GET as getComplianceBadge } from "@/app/api/vehicles/compliance/badge/route";
import {
  GET as listInsurances,
  POST as createInsurance,
  PUT as updateInsurance,
} from "@/app/api/vehicles/[vehicleId]/compliance/insurances/route";
import { POST as setOverride } from "@/app/api/vehicles/[vehicleId]/compliance/override/route";
import { makeNextRequest, json } from "./helpers/client";
import { createTestContext, seedVehicle, type TestContext } from "./helpers/seed";

// ─── Date helpers ─────────────────────────────────────────────────────────────

function isoAddDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);
const expiredDate = isoAddDays(today, -10);   // 10 giorni fa → expired
const criticalDate = isoAddDays(today, 5);    // 5 giorni → critical
const okDate = isoAddDays(today, 90);         // 90 giorni → ok
const futureOverride = isoAddDays(today, 30); // data futura per override

// ─── Shared state ─────────────────────────────────────────────────────────────

let ctx: TestContext;
let vehicleId: string;

function vehicleParams(vid: string) {
  return { params: Promise.resolve({ vehicleId: vid }) };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  ctx = await createTestContext();
  vehicleId = await seedVehicle(ctx.admin, ctx.tenantId, {
    label: "Van Compliance Test",
    capacity: 9,
  });
});

afterAll(async () => {
  await ctx.admin.from("vehicle_compliance_history").delete().eq("tenant_id", ctx.tenantId);
  await ctx.admin.from("vehicle_insurances").delete().eq("tenant_id", ctx.tenantId);
  await ctx.admin.from("vehicle_inspections").delete().eq("tenant_id", ctx.tenantId);
  await ctx.admin.from("vehicle_extinguishers").delete().eq("tenant_id", ctx.tenantId);
  await ctx.cleanup();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Compliance Summary
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/vehicles/compliance/summary", () => {
  it("restituisce 200 con items array per il tenant", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/summary");
    const res = await getComplianceSummary(req);
    const body = await json<{ items: Array<{ vehicle_id: string }> }>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.some((i) => i.vehicle_id === vehicleId)).toBe(true);
  });

  it("veicolo senza documenti ha insurance null e today nel payload", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/summary");
    const res = await getComplianceSummary(req);
    const body = await json<{
      today: string;
      items: Array<{ vehicle_id: string; insurance: null; worst_status: string }>;
    }>(res);

    const item = body.items.find((i) => i.vehicle_id === vehicleId);
    expect(item?.insurance).toBeNull();
    expect(body.today).toBe(today);
  });

  it("401 senza token", async () => {
    const req = makeNextRequest("GET", undefined, "", "http://localhost:3010/api/vehicles/compliance/summary");
    const res = await getComplianceSummary(req);
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Compliance Badge
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/vehicles/compliance/badge", () => {
  it("restituisce expired, critical, total numerici", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/badge");
    const res = await getComplianceBadge(req);
    const body = await json<{ expired: number; critical: number; total: number }>(res);

    expect(res.status).toBe(200);
    expect(typeof body.expired).toBe("number");
    expect(typeof body.critical).toBe("number");
    expect(body.total).toBe(body.expired + body.critical);
  });

  it("incrementa expired dopo inserimento assicurazione scaduta", async () => {
    const reqBefore = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/badge");
    const before = await json<{ expired: number }>((await getComplianceBadge(reqBefore)));

    // Secondo veicolo con assicurazione scaduta
    const expiredVehicleId = await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van Scaduto Badge" });
    await ctx.admin.from("vehicle_insurances").insert({
      tenant_id: ctx.tenantId,
      vehicle_id: expiredVehicleId,
      company: "TestSPA",
      expiry_date: expiredDate,
      is_current: true,
    });

    const reqAfter = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/badge");
    const after = await json<{ expired: number }>((await getComplianceBadge(reqAfter)));

    expect(after.expired).toBe(before.expired + 1);
  });

  it("incrementa critical dopo inserimento assicurazione in scadenza tra 5 giorni", async () => {
    const reqBefore = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/badge");
    const before = await json<{ critical: number }>((await getComplianceBadge(reqBefore)));

    const critVehicleId = await seedVehicle(ctx.admin, ctx.tenantId, { label: "Van Critical Badge" });
    await ctx.admin.from("vehicle_insurances").insert({
      tenant_id: ctx.tenantId,
      vehicle_id: critVehicleId,
      company: "CritSPA",
      expiry_date: criticalDate,
      is_current: true,
    });

    const reqAfter = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/badge");
    const after = await json<{ critical: number }>((await getComplianceBadge(reqAfter)));

    expect(after.critical).toBe(before.critical + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Insurance CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe("insurance CRUD — /api/vehicles/[vehicleId]/compliance/insurances", () => {
  let firstInsuranceId: string;
  let secondInsuranceId: string;

  it("POST crea assicurazione e restituisce 201", async () => {
    const req = makeNextRequest(
      "POST",
      { company: "Assitalia", expiry_date: okDate, policy_number: "POL-2026-001" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await createInsurance(req, vehicleParams(vehicleId));
    const body = await json<{ item: { id: string; company: string; is_current: boolean; policy_number: string } }>(res);

    expect(res.status).toBe(201);
    expect(body.item.company).toBe("Assitalia");
    expect(body.item.is_current).toBe(true);
    expect(body.item.policy_number).toBe("POL-2026-001");
    firstInsuranceId = body.item.id;
  });

  it("POST rinnovo archivia il record precedente (is_current → false)", async () => {
    const req = makeNextRequest(
      "POST",
      { company: "AXA", expiry_date: isoAddDays(okDate, 365) },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await createInsurance(req, vehicleParams(vehicleId));
    const body = await json<{ item: { id: string } }>(res);

    expect(res.status).toBe(201);
    secondInsuranceId = body.item.id;

    const { data } = await ctx.admin
      .from("vehicle_insurances")
      .select("is_current")
      .eq("id", firstInsuranceId);

    expect(data?.[0]?.is_current).toBe(false);
  });

  it("POST registra compliance_history con action 'renewed'", async () => {
    const { data } = await ctx.admin
      .from("vehicle_compliance_history")
      .select("action, compliance_type")
      .eq("tenant_id", ctx.tenantId)
      .eq("vehicle_id", vehicleId)
      .eq("action", "renewed");

    expect(data?.length).toBeGreaterThanOrEqual(1);
    expect(data![0].compliance_type).toBe("insurance");
  });

  it("POST 400 se manca company", async () => {
    const req = makeNextRequest(
      "POST",
      { expiry_date: okDate },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await createInsurance(req, vehicleParams(vehicleId));
    expect(res.status).toBe(400);
  });

  it("POST 400 se manca expiry_date", async () => {
    const req = makeNextRequest(
      "POST",
      { company: "Qualcuno" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await createInsurance(req, vehicleParams(vehicleId));
    expect(res.status).toBe(400);
  });

  it("GET restituisce lista con almeno 2 record per il veicolo", async () => {
    const req = makeNextRequest(
      "GET",
      undefined,
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await listInsurances(req, vehicleParams(vehicleId));
    const body = await json<{ items: Array<{ id: string }> }>(res);

    expect(res.status).toBe(200);
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  it("PUT aggiorna il primo record (archiviato)", async () => {
    const req = makeNextRequest(
      "PUT",
      { id: firstInsuranceId, company: "Allianz", expiry_date: okDate },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await updateInsurance(req, vehicleParams(vehicleId));
    const body = await json<{ item: { company: string } }>(res);

    expect(res.status).toBe(200);
    expect(body.item.company).toBe("Allianz");
  });

  it("PUT 400 se manca id nel body", async () => {
    const req = makeNextRequest(
      "PUT",
      { company: "Qualcuno" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/insurances`,
    );
    const res = await updateInsurance(req, vehicleParams(vehicleId));
    expect(res.status).toBe(400);
  });

  it("summary riflette l'assicurazione attiva con days_left e status", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/summary");
    const res = await getComplianceSummary(req);
    const body = await json<{
      items: Array<{
        vehicle_id: string;
        insurance: { expiry_date: string; days_left: number; status: string } | null;
      }>;
    }>(res);

    const item = body.items.find((i) => i.vehicle_id === vehicleId);
    expect(item?.insurance).not.toBeNull();
    expect(item!.insurance!.days_left).toBeGreaterThan(30);
    expect(item!.insurance!.status).toBe("ok");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Compliance Override
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/vehicles/[vehicleId]/compliance/override", () => {
  it("imposta un override con data futura valida", async () => {
    const req = makeNextRequest(
      "POST",
      { until: `${futureOverride}T23:59:59Z`, reason: "Rinnovo polizza in corso" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/override`,
    );
    const res = await setOverride(req, vehicleParams(vehicleId));
    const body = await json<{ ok: boolean; override: { reason: string } }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.override.reason).toBe("Rinnovo polizza in corso");
  });

  it("summary mostra worst_status 'ok' quando override attivo", async () => {
    const req = makeNextRequest("GET", undefined, ctx.token, "http://localhost:3010/api/vehicles/compliance/summary");
    const res = await getComplianceSummary(req);
    const body = await json<{
      items: Array<{ vehicle_id: string; worst_status: string; compliance_override: { reason: string } | null }>;
    }>(res);

    const item = body.items.find((i) => i.vehicle_id === vehicleId);
    expect(item?.compliance_override).not.toBeNull();
    expect(item!.worst_status).toBe("ok");
  });

  it("rimuove l'override con {clear: true}", async () => {
    const req = makeNextRequest(
      "POST",
      { clear: true },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/override`,
    );
    const res = await setOverride(req, vehicleParams(vehicleId));
    const body = await json<{ ok: boolean; override: null }>(res);

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.override).toBeNull();
  });

  it("400 se until è nel passato", async () => {
    const req = makeNextRequest(
      "POST",
      { until: `${expiredDate}T00:00:00Z`, reason: "Test passato" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/override`,
    );
    const res = await setOverride(req, vehicleParams(vehicleId));
    expect(res.status).toBe(400);
  });

  it("400 se manca reason", async () => {
    const req = makeNextRequest(
      "POST",
      { until: `${futureOverride}T23:59:59Z` },
      ctx.token,
      `http://localhost:3010/api/vehicles/${vehicleId}/compliance/override`,
    );
    const res = await setOverride(req, vehicleParams(vehicleId));
    expect(res.status).toBe(400);
  });

  it("404 per vehicleId inesistente", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000099";
    const req = makeNextRequest(
      "POST",
      { until: `${futureOverride}T23:59:59Z`, reason: "Test" },
      ctx.token,
      `http://localhost:3010/api/vehicles/${fakeId}/compliance/override`,
    );
    const res = await setOverride(req, { params: Promise.resolve({ vehicleId: fakeId }) });
    expect(res.status).toBe(404);
  });
});
