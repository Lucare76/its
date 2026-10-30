import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/server/pricing-auth", () => ({ authorizePricingRequest: mocks.authorize }));
import { POST } from "@/app/api/ops/agency-requests/reconcile/route";
let tokens: Array<Record<string, string>>; let fail: string; let calls: Array<{table:string; method:string; args:unknown[]}>;
beforeEach(() => {
 tokens = [{ service_id: "orphan", token: "active", expires_at: "2099-01-01" }]; fail = ""; calls = [];
 const admin = { from(table:string) {
   const query: Record<string, unknown> = {};
   for (const method of ["select", "eq", "is", "order", "limit", "update", "in", "neq"]) query[method] = (...args:unknown[]) => { calls.push({table, method, args}); return query; };
   query.then = (resolve:(value:unknown)=>unknown) => Promise.resolve({data: table === "booking_approval_tokens" ? tokens : null, error: fail === table ? {message:"failed"} : null}).then(resolve);
   return query;
 }};
 mocks.authorize.mockResolvedValue({admin, membership:{tenant_id:"tenant-a"}});
});
const request = () => POST(new NextRequest("https://its.test/api/ops/agency-requests/reconcile", {method:"POST"}));
it("repairs only null states with an existing approval token in the same tenant", async () => {
 const response = await request(); expect(response.status).toBe(200);
 expect(await response.json()).toEqual({ok:true,tokens:{orphan:"active"}});
 for (const table of ["services", "booking_approval_tokens"]) expect(calls).toContainEqual({table,method:"eq",args:["tenant_id","tenant-a"]});
 expect(calls).toContainEqual({table:"services",method:"is",args:["approval_status",null]});
 expect(calls).toContainEqual({table:"services",method:"neq",args:["status","cancelled"]});
 expect(calls).toContainEqual({table:"services",method:"update",args:[{approval_status:"pending_operator"}]});
});
it("does not expose expired approval links", async () => { tokens[0].expires_at="2000-01-01"; expect((await (await request()).json()).tokens).toEqual({}); });
it("does not modify services if no tokens exist", async () => { tokens=[]; await request(); expect(calls.some(call=>call.method==="update")).toBe(false); });
it.each(["services","booking_approval_tokens"])("surfaces failures from %s", async table => { fail=table; expect((await request()).status).toBe(500); });
it("requires operator authentication", async () => { mocks.authorize.mockResolvedValue(NextResponse.json({ok:false},{status:401})); expect((await request()).status).toBe(401); expect(calls).toHaveLength(0); });
