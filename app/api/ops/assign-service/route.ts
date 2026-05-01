/**
 * POST /api/ops/assign-service
 * Assegna o rimuove un singolo servizio creando sempre un trip_group con group_id.
 * Usato da dispatch, service-workflow e dashboard per garantire che le
 * assegnazioni siano visibili nel Piano del Giorno.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const userId = auth.user.id;

    type Body = {
      service_id: string;
      driver_user_id?: string | null;
      vehicle_label?: string | null;
      action?: "assign" | "remove";
    };

    const body = (await request.json().catch(() => null)) as Body | null;
    if (!body?.service_id) {
      return NextResponse.json({ ok: false, error: "service_id obbligatorio." }, { status: 400 });
    }

    const action = body.action ?? "assign";
    const now = new Date().toISOString();

    // Recupera il servizio per avere la data
    const { data: service, error: serviceErr } = await auth.admin
      .from("services")
      .select("id, date, status")
      .eq("id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    if (serviceErr || !service) {
      return NextResponse.json({ ok: false, error: "Servizio non trovato." }, { status: 404 });
    }

    const date = service.date as string;

    // Verifica disponibilità confermata
    const { data: availability } = await auth.admin
      .from("daily_availability_confirmations")
      .select("confirmed")
      .eq("tenant_id", tenantId)
      .eq("date", date)
      .maybeSingle();

    if (!availability?.confirmed) {
      return NextResponse.json({
        ok: false,
        error: "Disponibilita del giorno non confermata. Completa prima la conferma in Disponibilita."
      }, { status: 409 });
    }

    // Recupera assignment esistente
    const { data: existingAssignment } = await auth.admin
      .from("assignments")
      .select("id, group_id")
      .eq("service_id", body.service_id)
      .eq("tenant_id", tenantId)
      .maybeSingle();

    // ─── REMOVE ───────────────────────────────────────────────────────────────
    if (action === "remove") {
      if (!existingAssignment) {
        return NextResponse.json({ ok: true });
      }
      await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);

      if (existingAssignment.group_id) {
        const { data: remaining } = await auth.admin
          .from("assignments")
          .select("id")
          .eq("group_id", existingAssignment.group_id)
          .eq("tenant_id", tenantId);
        if (!remaining?.length) {
          await auth.admin.from("trip_groups")
            .update({ status: "cancelled", updated_at: now })
            .eq("id", existingAssignment.group_id)
            .eq("tenant_id", tenantId);
        }
      }

      await auth.admin.from("services").update({ status: "new" }).eq("id", body.service_id).eq("tenant_id", tenantId);
      return NextResponse.json({ ok: true });
    }

    // ─── ASSIGN ───────────────────────────────────────────────────────────────
    let groupId: string;

    if (existingAssignment?.group_id) {
      groupId = existingAssignment.group_id as string;
      await Promise.all([
        auth.admin.from("trip_groups").update({
          driver_user_id: body.driver_user_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          updated_at: now,
        }).eq("id", groupId).eq("tenant_id", tenantId),
        auth.admin.from("assignments").update({
          driver_user_id: body.driver_user_id ?? null,
          vehicle_label: body.vehicle_label ?? "",
        }).eq("id", existingAssignment.id).eq("tenant_id", tenantId),
      ]);
    } else {
      // Rimuovi eventuale assignment vecchio senza group_id
      if (existingAssignment) {
        await auth.admin.from("assignments").delete().eq("id", existingAssignment.id).eq("tenant_id", tenantId);
      }

      const { data: newGroup, error: groupErr } = await auth.admin
        .from("trip_groups")
        .insert({
          tenant_id: tenantId,
          date,
          driver_user_id: body.driver_user_id ?? null,
          vehicle_label: body.vehicle_label ?? null,
          created_by: userId,
          created_at: now,
          updated_at: now,
        })
        .select("id")
        .single();

      if (groupErr || !newGroup?.id) {
        return NextResponse.json({ ok: false, error: groupErr?.message ?? "Errore creazione giro." }, { status: 500 });
      }

      groupId = newGroup.id as string;

      await auth.admin.from("assignments").insert({
        tenant_id: tenantId,
        service_id: body.service_id,
        driver_user_id: body.driver_user_id ?? null,
        vehicle_label: body.vehicle_label ?? "",
        group_id: groupId,
      });
    }

    await auth.admin.from("services").update({ status: "assigned" }).eq("id", body.service_id).eq("tenant_id", tenantId);

    await auth.admin.from("status_events").upsert({
      tenant_id: tenantId,
      service_id: body.service_id,
      status: "assigned",
      at: now,
      by_user_id: userId,
    }, { onConflict: "tenant_id,service_id,status", ignoreDuplicates: true });

    return NextResponse.json({ ok: true, group_id: groupId });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Errore." },
      { status: 500 }
    );
  }
}
