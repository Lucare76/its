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
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function getAuthTenantId(request: NextRequest): Promise<string | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const admin = adminClient();
  const { data } = await admin
    .from("memberships")
    .select("tenant_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data) return null;
  if (!["admin", "supervisor", "operator"].includes(data.role)) return null;
  return data.tenant_id as string;
}

export async function GET(request: NextRequest) {
  const tenantId = await getAuthTenantId(request);
  if (!tenantId) return NextResponse.json({ error: "Non autorizzato." }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status") ?? "open";
  const vehicleIdFilter = searchParams.get("vehicle_id");

  const admin = adminClient();

  // Recupera veicoli del tenant
  const { data: vehicles, error: vErr } = await admin
    .from("vehicles")
    .select("id, label, plate")
    .eq("tenant_id", tenantId);

  if (vErr || !vehicles?.length) {
    return NextResponse.json({ reports: [], vehicles: [] });
  }

  const vehicleIds = vehicles.map((v) => v.id);
  const vehicleMap = Object.fromEntries(vehicles.map((v) => [v.id, v]));

  let query = admin
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
}

export async function POST(request: NextRequest) {
  const tenantId = await getAuthTenantId(request);
  if (!tenantId) return NextResponse.json({ error: "Non autorizzato." }, { status: 401 });

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Body non valido." }, { status: 400 });

  const action = body.action as string;
  const id = body.id as string;
  if (!id) return NextResponse.json({ error: "id obbligatorio." }, { status: 400 });

  const admin = adminClient();

  // Verifica che il report appartenga a un veicolo del tenant
  const { data: report } = await admin
    .from("vehicle_qr_reports")
    .select("vehicle_id")
    .eq("id", id)
    .maybeSingle();

  if (!report) return NextResponse.json({ error: "Report non trovato." }, { status: 404 });

  const { data: vehicle } = await admin
    .from("vehicles")
    .select("tenant_id")
    .eq("id", report.vehicle_id)
    .maybeSingle();

  if (vehicle?.tenant_id !== tenantId) {
    return NextResponse.json({ error: "Non autorizzato." }, { status: 403 });
  }

  if (action === "acknowledge") {
    await admin.from("vehicle_qr_reports").update({ status: "acknowledged" }).eq("id", id);
    return NextResponse.json({ ok: true });
  }

  if (action === "resolve") {
    await admin.from("vehicle_qr_reports").update({ status: "resolved" }).eq("id", id);
    // Risolve anche l'anomalia collegata (se esiste) basandosi su descrizione + vehicle
    await admin
      .from("vehicle_anomalies")
      .update({ active: false })
      .eq("vehicle_id", report.vehicle_id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Azione non riconosciuta." }, { status: 400 });
}
