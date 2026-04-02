import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

async function hasColumn(admin: any, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

async function hasTable(admin: any, table: string) {
  const { error } = await admin.from(table).select("*").limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42P01") return false;
  throw new Error(`Schema probe failed for table ${table}: ${error.message}`);
}

type ExcursionLine = {
  id: string; name: string; description: string | null; color: string; icon: string;
  active: boolean; sort_order: number; days_of_week: number[]; excursion_type: string;
  price_agency_cents: number; price_retail_cents: number; return_time: string | null;
  min_pax: number; valid_from: string | null;
};
type ExcursionUnit = { id: string; excursion_line_id: string; excursion_date: string; label: string; capacity: number; departure_time: string | null; vehicle_id: string | null; driver_profile_id: string | null; notes: string | null; status: string };
type ExcursionAllocation = { id: string; excursion_unit_id: string; customer_name: string; pax: number; hotel_name: string | null; pickup_time: string | null; phone: string | null; agency_name: string | null; notes: string | null };
type ExcursionPickup = { id: string; excursion_line_id: string; location: string; pickup_time: string; sort_order: number };

async function loadData(auth: Awaited<ReturnType<typeof authorizePricingRequest>>, date: string) {
  if (auth instanceof NextResponse) throw new Error("unauthorized");
  const tenantId = auth.membership.tenant_id;

  // Giorno della settimana per filtrare le linee (0=Dom...6=Sab)
  const dow = new Date(date + "T12:00:00").getDay();
  const [supportsDaysOfWeek, supportsExcursionType, supportsAgencyPrice, supportsRetailPrice, supportsReturnTime, supportsMinPax, supportsValidFrom, supportsPickups] = await Promise.all([
    hasColumn(auth.admin, "excursion_lines", "days_of_week"),
    hasColumn(auth.admin, "excursion_lines", "excursion_type"),
    hasColumn(auth.admin, "excursion_lines", "price_agency_cents"),
    hasColumn(auth.admin, "excursion_lines", "price_retail_cents"),
    hasColumn(auth.admin, "excursion_lines", "return_time"),
    hasColumn(auth.admin, "excursion_lines", "min_pax"),
    hasColumn(auth.admin, "excursion_lines", "valid_from"),
    hasTable(auth.admin, "excursion_pickups"),
  ]);

  const unitIds = await auth.admin
    .from("excursion_units")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("excursion_date", date)
    .then((r) => (r.data ?? []).map((u) => u.id));

  const lineSelect = [
    "id",
    "name",
    "description",
    "color",
    "icon",
    "active",
    "sort_order",
    supportsDaysOfWeek ? "days_of_week" : null,
    supportsExcursionType ? "excursion_type" : null,
    supportsAgencyPrice ? "price_agency_cents" : null,
    supportsRetailPrice ? "price_retail_cents" : null,
    supportsReturnTime ? "return_time" : null,
    supportsMinPax ? "min_pax" : null,
    supportsValidFrom ? "valid_from" : null,
  ].filter(Boolean).join(",");

  const linesQuery = auth.admin
    .from("excursion_lines")
    .select(lineSelect)
    .eq("tenant_id", tenantId)
    .eq("active", true);

  if (supportsDaysOfWeek) {
    linesQuery.contains("days_of_week", [dow]);
  }

  const [linesRes, unitsRes, allocRes, vehiclesRes, driversRes] = await Promise.all([
    linesQuery.order("sort_order"),
    auth.admin.from("excursion_units").select("*").eq("tenant_id", tenantId).eq("excursion_date", date).order("label"),
    unitIds.length > 0
      ? auth.admin.from("excursion_allocations").select("*").in("excursion_unit_id", unitIds).order("pickup_time").order("customer_name")
      : Promise.resolve({ data: [], error: null }),
    auth.admin.from("vehicles").select("id,label,plate,capacity").eq("tenant_id", tenantId).eq("active", true).order("label"),
    auth.admin.from("driver_profiles").select("id,full_name,phone").eq("tenant_id", tenantId).eq("active", true).order("full_name"),
  ]);

  if (linesRes.error) throw new Error(linesRes.error.message);
  if (unitsRes.error) throw new Error(unitsRes.error.message);

  const lines = ((linesRes.data ?? []) as Array<Record<string, unknown>>).map((line) => ({
    id: String(line.id),
    name: String(line.name),
    description: typeof line.description === "string" ? line.description : null,
    color: typeof line.color === "string" ? line.color : "#6366f1",
    icon: typeof line.icon === "string" ? line.icon : "🚌",
    active: typeof line.active === "boolean" ? line.active : true,
    sort_order: typeof line.sort_order === "number" ? line.sort_order : 0,
    days_of_week: Array.isArray(line.days_of_week) ? (line.days_of_week as number[]) : [],
    excursion_type: typeof line.excursion_type === "string" ? line.excursion_type : "misto",
    price_agency_cents: typeof line.price_agency_cents === "number" ? line.price_agency_cents : 0,
    price_retail_cents: typeof line.price_retail_cents === "number" ? line.price_retail_cents : 0,
    return_time: typeof line.return_time === "string" ? line.return_time : null,
    min_pax: typeof line.min_pax === "number" ? line.min_pax : 1,
    valid_from: typeof line.valid_from === "string" ? line.valid_from : null,
  })) as ExcursionLine[];

  // Carica orari pickup solo per le linee del giorno
  const lineIds = lines.map((l) => l.id);
  const pickupsRes = supportsPickups && lineIds.length > 0
    ? await auth.admin.from("excursion_pickups").select("*").in("excursion_line_id", lineIds).order("sort_order")
    : { data: [], error: null };

  if (pickupsRes.error) throw new Error(pickupsRes.error.message);

  return {
    lines,
    units: (unitsRes.data ?? []) as ExcursionUnit[],
    allocations: (allocRes.data ?? []) as ExcursionAllocation[],
    pickups: (pickupsRes.data ?? []) as ExcursionPickup[],
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
