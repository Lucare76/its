/**
 * GET  /api/ops/vehicle-records?vehicle_id=xxx  — lista manutenzioni/fuel/ricambi
 * POST /api/ops/vehicle-records                 — aggiunge/cancella un record
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type RecordType = "maintenance" | "fuel" | "spare_parts" | "qr_reports" | "commitments";

const TABLE_MAP: Record<RecordType, string> = {
  maintenance:  "vehicle_maintenance",
  fuel:         "vehicle_fuel",
  spare_parts:  "vehicle_spare_parts",
  qr_reports:   "vehicle_qr_reports",
  commitments:  "vehicle_commitments",
};

const ORDER_MAP: Record<RecordType, string> = {
  maintenance: "maintenance_date",
  fuel:        "fuel_date",
  spare_parts: "order_date",
  qr_reports:  "created_at",
  commitments: "commitment_date",
};

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const vehicleId  = searchParams.get("vehicle_id");
  const recordType = (searchParams.get("type") ?? "maintenance") as RecordType;

  if (!vehicleId) return NextResponse.json({ error: "vehicle_id richiesto." }, { status: 400 });
  if (!TABLE_MAP[recordType]) return NextResponse.json({ error: "Tipo non valido." }, { status: 400 });

  const { data, error } = await auth.admin
    .from(TABLE_MAP[recordType])
    .select("*")
    .eq("vehicle_id", vehicleId)
    .order(ORDER_MAP[recordType], { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, records: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as {
    action: "insert" | "delete" | "update";
    type: RecordType;
    vehicle_id?: string;
    id?: string;
    data?: Record<string, unknown>;
  } | null;

  if (!body?.action || !body?.type) {
    return NextResponse.json({ error: "action e type richiesti." }, { status: 400 });
  }

  const table = TABLE_MAP[body.type];
  if (!table) return NextResponse.json({ error: "Tipo non valido." }, { status: 400 });

  if (body.action === "delete") {
    if (!body.id) return NextResponse.json({ error: "id richiesto." }, { status: 400 });
    const { error } = await auth.admin.from(table).delete().eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "insert") {
    if (!body.vehicle_id || !body.data) return NextResponse.json({ error: "vehicle_id e data richiesti." }, { status: 400 });
    const { error } = await auth.admin.from(table).insert({
      ...body.data,
      vehicle_id: body.vehicle_id,
      tenant_id:  auth.membership.tenant_id,
      created_by: auth.user.id,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.action === "update") {
    if (!body.id || !body.data) return NextResponse.json({ error: "id e data richiesti." }, { status: 400 });
    const { error } = await auth.admin.from(table).update(body.data).eq("id", body.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Azione non valida." }, { status: 400 });
}
