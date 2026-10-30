import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

// Recover only orphaned requests with an existing approval token. Never approve a service here.
export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;
  const tenantId = auth.membership.tenant_id;
  const { data: tokens, error } = await auth.admin.from("booking_approval_tokens")
    .select("service_id,token,expires_at").eq("tenant_id", tenantId).is("used_at", null)
    .order("created_at", { ascending: false }).limit(500);
  if (error) return NextResponse.json({ ok: false, error: "Impossibile leggere le richieste da approvare." }, { status: 500 });
  const ids = [...new Set((tokens ?? []).map(row => row.service_id as string))];
  if (ids.length) {
    const { error: repairError } = await auth.admin.from("services")
      .update({ approval_status: "pending_operator" }).eq("tenant_id", tenantId)
      .in("id", ids).is("approval_status", null).neq("status", "cancelled");
    if (repairError) return NextResponse.json({ ok: false, error: "Impossibile ripristinare lo stato delle richieste." }, { status: 500 });
  }
  const tokenMap: Record<string, string> = {};
  for (const row of tokens ?? []) {
    if (!tokenMap[row.service_id] && new Date(row.expires_at).getTime() > Date.now()) tokenMap[row.service_id] = row.token;
  }
  return NextResponse.json({ ok: true, tokens: tokenMap });
}
