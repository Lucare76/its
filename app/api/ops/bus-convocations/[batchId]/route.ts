import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string }> }
) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { batchId } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: batch, error: batchError } = await auth.admin
    .from("bus_convocation_batches")
    .select("*")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (batchError) {
    return NextResponse.json({ error: batchError.message }, { status: 500 });
  }
  if (!batch) {
    return NextResponse.json({ error: "Batch non trovato" }, { status: 404 });
  }

  const { data: rows, error: rowsError } = await auth.admin
    .from("bus_convocation_rows")
    .select("*")
    .eq("batch_id", batchId)
    .eq("tenant_id", tenantId)
    .order("row_index", { ascending: true })
    .limit(5000);

  if (rowsError) {
    return NextResponse.json({ error: rowsError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, batch, rows: rows ?? [] });
}
