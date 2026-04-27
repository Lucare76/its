/**
 * GET  /api/ops/disponibilita?date=YYYY-MM-DD
 *   Carica autisti, mezzi, disponibilità del giorno e stato conferma.
 *
 * POST /api/ops/disponibilita
 *   Azioni: save_driver, save_vehicle, add_block, remove_block, confirm, unconfirm
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { loadVehicleCommitmentsForDate } from "@/lib/server/vehicle-commitments";

export const runtime = "nodejs";

// ─── Schemi ───────────────────────────────────────────────────────────────────

const saveDriverSchema = z.object({
  action: z.literal("save_driver"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  driver_user_id: z.string().uuid(),
  available: z.boolean(),
  available_from: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  available_to: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  notes: z.string().max(500).optional().nullable(),
});

const saveVehicleSchema = z.object({
  action: z.literal("save_vehicle"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicle_id: z.string().uuid(),
  available: z.boolean(),
  notes: z.string().max(500).optional().nullable(),
});

const addBlockSchema = z.object({
  action: z.literal("add_block"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  vehicle_id: z.string().uuid(),
  block_from: z.string().regex(/^\d{2}:\d{2}$/),
  block_to: z.string().regex(/^\d{2}:\d{2}$/),
  reason: z.enum(["escursione", "manutenzione", "fuori_servizio", "rientro_porto_ischia", "rientro_porto_casamicciola", "altro"]),
  reason_notes: z.string().max(500).optional().nullable(),
});

const removeBlockSchema = z.object({
  action: z.literal("remove_block"),
  block_id: z.string().uuid(),
});

const confirmSchema = z.object({
  action: z.enum(["confirm", "unconfirm"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;

    const date = req.nextUrl.searchParams.get("date")?.trim() || new Date().toISOString().slice(0, 10);

    const [driversRes, vehiclesRes, driverAvailRes, vehicleAvailRes, blocksRes, confirmRes, commitments] =
      await Promise.all([
        auth.admin.from("memberships")
          .select("user_id, full_name, max_vehicle_capacity")
          .eq("tenant_id", tenantId)
          .in("role", ["driver", "autista"])
          .order("full_name"),
        auth.admin.from("vehicles")
          .select("id, label, capacity, vehicle_size")
          .eq("tenant_id", tenantId)
          .eq("active", true)
          .order("capacity"),
        auth.admin.from("driver_daily_availability")
          .select("driver_user_id, available, available_from, available_to, notes")
          .eq("tenant_id", tenantId)
          .eq("date", date),
        auth.admin.from("vehicle_daily_availability")
          .select("vehicle_id, available, notes")
          .eq("tenant_id", tenantId)
          .eq("date", date),
        auth.admin.from("vehicle_time_blocks")
          .select("id, vehicle_id, block_from, block_to, reason, reason_notes")
          .eq("tenant_id", tenantId)
          .eq("date", date)
          .order("block_from"),
        auth.admin.from("daily_availability_confirmations")
          .select("confirmed, confirmed_at, confirmed_by")
          .eq("tenant_id", tenantId)
          .eq("date", date)
          .maybeSingle(),
        loadVehicleCommitmentsForDate(auth.admin, tenantId, date),
      ]);

    return NextResponse.json({
      ok: true,
      date,
      drivers: driversRes.data ?? [],
      vehicles: vehiclesRes.data ?? [],
      driver_availability: driverAvailRes.data ?? [],
      vehicle_availability: vehicleAvailRes.data ?? [],
      vehicle_blocks: blocksRes.data ?? [],
      vehicle_commitments: commitments.rows,
      confirmed: confirmRes.data?.confirmed ?? false,
      confirmed_at: confirmRes.data?.confirmed_at ?? null,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await authorizePricingRequest(req, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;
    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = body.action as string;

    // ── save_driver ───────────────────────────────────────────────────────────
    if (action === "save_driver") {
      const p = saveDriverSchema.safeParse(body);
      if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
      const d = p.data;
      const { error } = await auth.admin.from("driver_daily_availability").upsert({
        tenant_id: tenantId,
        driver_user_id: d.driver_user_id,
        date: d.date,
        available: d.available,
        available_from: d.available_from ?? null,
        available_to: d.available_to ?? null,
        notes: d.notes ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,driver_user_id,date" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // ── save_vehicle ──────────────────────────────────────────────────────────
    if (action === "save_vehicle") {
      const p = saveVehicleSchema.safeParse(body);
      if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
      const d = p.data;
      if (d.available) {
        const { byVehicleId } = await loadVehicleCommitmentsForDate(auth.admin, tenantId, d.date);
        const commitment = byVehicleId.get(d.vehicle_id);
        if (commitment) {
          return NextResponse.json({
            ok: false,
            error: `Mezzo impegnato per ${commitment.commitment_type}. Rimuovi prima l'impegno in Fleet Ops.`,
          }, { status: 409 });
        }
      }
      const { error } = await auth.admin.from("vehicle_daily_availability").upsert({
        tenant_id: tenantId,
        vehicle_id: d.vehicle_id,
        date: d.date,
        available: d.available,
        notes: d.notes ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "tenant_id,vehicle_id,date" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // ── add_block ─────────────────────────────────────────────────────────────
    if (action === "add_block") {
      const p = addBlockSchema.safeParse(body);
      if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
      const d = p.data;
      if (d.block_to <= d.block_from)
        return NextResponse.json({ ok: false, error: "L'orario di fine deve essere successivo all'inizio." }, { status: 400 });

      const { data: block, error } = await auth.admin.from("vehicle_time_blocks").insert({
        tenant_id: tenantId,
        vehicle_id: d.vehicle_id,
        date: d.date,
        block_from: d.block_from,
        block_to: d.block_to,
        reason: d.reason,
        reason_notes: d.reason_notes ?? null,
      }).select("id").single();
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, id: block?.id });
    }

    // ── remove_block ──────────────────────────────────────────────────────────
    if (action === "remove_block") {
      const p = removeBlockSchema.safeParse(body);
      if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
      const { error } = await auth.admin.from("vehicle_time_blocks")
        .delete()
        .eq("id", p.data.block_id)
        .eq("tenant_id", tenantId);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // ── confirm / unconfirm ───────────────────────────────────────────────────
    if (action === "confirm" || action === "unconfirm") {
      const p = confirmSchema.safeParse(body);
      if (!p.success) return NextResponse.json({ ok: false, error: p.error.issues[0]?.message }, { status: 400 });
      const confirming = action === "confirm";
      const { error } = await auth.admin.from("daily_availability_confirmations").upsert({
        tenant_id: tenantId,
        date: p.data.date,
        confirmed: confirming,
        confirmed_at: confirming ? new Date().toISOString() : null,
        confirmed_by: confirming ? userId : null,
      }, { onConflict: "tenant_id,date" });
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, confirmed: confirming });
    }

    return NextResponse.json({ ok: false, error: "Azione non riconosciuta." }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Errore" }, { status: 500 });
  }
}
