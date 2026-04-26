/**
 * GET  /api/admin/fleet-reports
 *   ?status=open|closed|all   (default: open)
 *   ?vehicle_id=xxx            (opzionale: filtra per veicolo)
 *
 * POST /api/admin/fleet-reports
 *   body.action = "acknowledge"  → segna come letta (status: "acknowledged")
 *   body.action = "resolve"      → segna come risolta (status: "resolved")
 *   body.id = string             → id del report
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "open";
  const vehicleIdFilter = searchParams.get("vehicle_id");

  // Recupera veicoli del tenant
  const { data: vehicles, error: vErr } = await auth.admin
    .from("vehicles")
    .select("id, label, plate")
    .eq("tenant_id", auth.membership.tenant_id);

  if (vErr || !vehicles?.length) {
    return NextResponse.json({ reports: [], vehicles: [] });
  }

  const vehicleIds = vehicles.map((v) => v.id);
  const vehicleMap = Object.fromEntries(vehicles.map((v) => [v.id, v]));

  let query = auth.admin
    .from("vehicle_qr_reports")
    .select("id, vehicle_id, reporter_name, description, severity, photo_urls, status, created_at")
    .in("vehicle_id", vehicleIdFilter ? [vehicleIdFilter] : vehicleIds)
    .order("created_at", { ascending: false });

  if (status !== "all") {
    query = query.eq("status", status);
  }

  const { data: reports, error: rErr } = await query;
  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 });

  const enriched = (reports ?? []).map((r) => ({
    ...r,
    vehicle: vehicleMap[r.vehicle_id] ?? null,
  }));

  return NextResponse.json({ reports: enriched, vehicles });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Body non valido." }, { status: 400 });

  const action = body.action as string;
  const id = body.id as string;
  if (!id) return NextResponse.json({ error: "id obbligatorio." }, { status: 400 });

  // Verifica che il report appartenga a un veicolo del tenant
  const { data: report } = await auth.admin
    .from("vehicle_qr_reports")
    .select("vehicle_id")
    .eq("id", id)
    .maybeSingle();

  if (!report) return NextResponse.json({ error: "Report non trovato." }, { status: 404 });

  const { data: vehicle } = await auth.admin
    .from("vehicles")
    .select("tenant_id")
    .eq("id", report.vehicle_id)
    .maybeSingle();

  if (vehicle?.tenant_id !== auth.membership.tenant_id) {
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  }

  if (action === "acknowledge") {
    await auth.admin.from("vehicle_qr_reports").update({ status: "acknowledged" }).eq("id", id);
    return NextResponse.json({ ok: true });
  }

  if (action === "resolve") {
    await auth.admin.from("vehicle_qr_reports").update({ status: "resolved" }).eq("id", id);
    await auth.admin
      .from("vehicle_anomalies")
      .update({ active: false })
      .eq("vehicle_id", report.vehicle_id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Azione non riconosciuta." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
