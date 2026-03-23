import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const bookingPatchSchema = z.object({
  customer_first_name: z.string().min(2).max(80).optional(),
  customer_last_name: z.string().min(2).max(80).optional(),
  customer_phone: z.string().min(6).max(30).optional(),
  pax: z.number().int().min(1).max(16).optional(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  transport_code: z.string().max(80).optional().nullable(),
  bus_city_origin: z.string().max(120).optional().nullable(),
  notes: z.string().max(2000).optional()
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authHeader = request.headers.get("authorization");
    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    }
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const token = authHeader.slice("Bearer ".length);
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) {
      return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
    }

    const { data: membership } = await admin
      .from("memberships")
      .select("tenant_id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    const role = parseRole(membership?.role);
    if (!membership?.tenant_id || !role || (role !== "agency" && role !== "admin")) {
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }

    const { id: serviceId } = await params;
    const { data: existing } = await admin
      .from("services")
      .select("id, tenant_id, customer_first_name, customer_last_name, booking_service_kind")
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id)
      .maybeSingle();

    if (!existing?.id) {
      return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
    }

    const payload = await request.json().catch(() => null);
    const parsed = bookingPatchSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
    }

    const patch = parsed.data;
    const update: Record<string, unknown> = {};

    if (patch.arrival_date !== undefined) { update.arrival_date = patch.arrival_date; update.date = patch.arrival_date; }
    if (patch.arrival_time !== undefined) { update.arrival_time = patch.arrival_time; update.time = patch.arrival_time; }
    if (patch.departure_date !== undefined) update.departure_date = patch.departure_date;
    if (patch.departure_time !== undefined) update.departure_time = patch.departure_time;
    if (patch.pax !== undefined) update.pax = patch.pax;
    if (patch.notes !== undefined) update.notes = patch.notes;
    if (patch.transport_code !== undefined) update.transport_code = patch.transport_code;
    if (patch.bus_city_origin !== undefined) update.bus_city_origin = patch.bus_city_origin;

    const firstName = patch.customer_first_name ?? (existing.customer_first_name as string | null) ?? "";
    const lastName = patch.customer_last_name ?? (existing.customer_last_name as string | null) ?? "";
    if (patch.customer_first_name !== undefined) { update.customer_first_name = firstName; }
    if (patch.customer_last_name !== undefined) { update.customer_last_name = lastName; }
    if (patch.customer_first_name !== undefined || patch.customer_last_name !== undefined) {
      update.customer_name = `${firstName} ${lastName}`.trim();
    }
    if (patch.customer_phone !== undefined) update.phone = patch.customer_phone;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nessun campo da aggiornare." }, { status: 400 });
    }

    const { error: updateError } = await admin
      .from("services")
      .update(update)
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    auditLog({
      event: "agency_booking_updated",
      tenantId: membership.tenant_id,
      userId: user.id,
      role,
      serviceId,
      outcome: "updated",
      details: { fields: Object.keys(update) }
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    auditLog({ event: "agency_booking_update_failed", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
