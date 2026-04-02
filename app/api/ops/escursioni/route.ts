import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

type ExcursionLine = { id: string; name: string; description: string | null; color: string; icon: string; active: boolean; sort_order: number };
type ExcursionUnit = { id: string; excursion_line_id: string; excursion_date: string; label: string; capacity: number; departure_time: string | null; vehicle_id: string | null; driver_profile_id: string | null; notes: string | null; status: string };
type ExcursionAllocation = { id: string; excursion_unit_id: string; customer_name: string; pax: number; hotel_name: string | null; pickup_time: string | null; phone: string | null; agency_name: string | null; notes: string | null };

async function loadData(auth: Awaited<ReturnType<typeof authorizePricingRequest>>, date: string) {
  if (auth instanceof NextResponse) throw new Error("unauthorized");
  const tenantId = auth.membership.tenant_id;

  const unitIds = await auth.admin
    .from("excursion_units")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("excursion_date", date)
    .then((r) => (r.data ?? []).map((u) => u.id));

  const [linesRes, unitsRes, allocRes, vehiclesRes, driversRes] = await Promise.all([
    auth.admin.from("excursion_lines").select("*").eq("tenant_id", tenantId).eq("active", true).order("sort_order"),
    auth.admin.from("excursion_units").select("*").eq("tenant_id", tenantId).eq("excursion_date", date).order("label"),
    unitIds.length > 0
      ? auth.admin.from("excursion_allocations").select("*").in("excursion_unit_id", unitIds).order("pickup_time").order("customer_name")
      : Promise.resolve({ data: [], error: null }),
    auth.admin.from("vehicles").select("id,label,plate,capacity").eq("tenant_id", tenantId).eq("active", true).order("label"),
    auth.admin.from("driver_profiles").select("id,full_name,phone").eq("tenant_id", tenantId).eq("active", true).order("full_name"),
  ]);

  if (linesRes.error) throw new Error(linesRes.error.message);
  if (unitsRes.error) throw new Error(unitsRes.error.message);

  return {
    lines: (linesRes.data ?? []) as ExcursionLine[],
    units: (unitsRes.data ?? []) as ExcursionUnit[],
    allocations: (allocRes.data ?? []) as ExcursionAllocation[],
    vehicles: vehiclesRes.data ?? [],
    drivers: driversRes.data ?? [],
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const date = req.nextUrl.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
    return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const body = (await req.json()) as Record<string, unknown>;
    const action = body.action as string;
    const date = (body.date as string) ?? new Date().toISOString().slice(0, 10);

    // ── add_unit: aggiungi bus a un'escursione ────────────────────────────
    if (action === "add_unit") {
      const { excursion_line_id, label, capacity, departure_time } = body as {
        excursion_line_id: string; label: string; capacity: number; departure_time?: string;
      };
      const { error } = await auth.admin.from("excursion_units").insert({
        tenant_id: tenantId, excursion_line_id, excursion_date: date,
        label, capacity: capacity ?? 50,
        departure_time: departure_time || null,
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    // ── update_unit: aggiorna label/capienza/autista/mezzo/stato ──────────
    if (action === "update_unit") {
      const { unit_id, ...patch } = body as { unit_id: string; [k: string]: unknown };
      const allowed = ["label","capacity","departure_time","vehicle_id","driver_profile_id","notes","status"];
      const update = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k) && k !== "action" && k !== "date"));
      const { error } = await auth.admin.from("excursion_units").update(update).eq("id", unit_id).eq("tenant_id", tenantId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    // ── delete_unit ───────────────────────────────────────────────────────
    if (action === "delete_unit") {
      const { unit_id } = body as { unit_id: string };
      const { error } = await auth.admin.from("excursion_units").delete().eq("id", unit_id).eq("tenant_id", tenantId);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    // ── add_passenger: aggiungi passeggero a un bus ───────────────────────
    if (action === "add_passenger") {
      const { excursion_unit_id, customer_name, pax, hotel_name, pickup_time, phone, agency_name, notes } = body as {
        excursion_unit_id: string; customer_name: string; pax: number;
        hotel_name?: string; pickup_time?: string; phone?: string; agency_name?: string; notes?: string;
      };
      const { error } = await auth.admin.from("excursion_allocations").insert({
        excursion_unit_id, customer_name, pax: pax ?? 1,
        hotel_name: hotel_name?.trim() || null,
        pickup_time: pickup_time || null,
        phone: phone?.trim() || null,
        agency_name: agency_name?.trim() || null,
        notes: notes?.trim() || null,
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    // ── remove_passenger ──────────────────────────────────────────────────
    if (action === "remove_passenger") {
      const { allocation_id } = body as { allocation_id: string };
      const { error } = await auth.admin.from("excursion_allocations").delete().eq("id", allocation_id);
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    // ── add_line: nuova tipologia escursione ──────────────────────────────
    if (action === "add_line") {
      const { name, description, color, icon } = body as { name: string; description?: string; color?: string; icon?: string };
      const { error } = await auth.admin.from("excursion_lines").insert({
        tenant_id: tenantId, name, description: description || null,
        color: color || "#6366f1", icon: icon || "🚌",
      });
      if (error) throw new Error(error.message);
      return NextResponse.json({ ok: true, ...(await loadData(auth, date)) });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Errore" }, { status: 500 });
  }
}
