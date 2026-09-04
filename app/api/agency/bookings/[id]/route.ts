import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";
import { auditLog } from "@/lib/server/ops-audit";
import { sendEmail } from "@/lib/server/send-email";
import { ensureWhatsAppContact } from "@/lib/server/whatsapp/contacts";
import {
  recalculateDirectFormulaPickupForEdit,
  type FormulaPickupEditState,
} from "@/lib/server/recalculate-formula-pickup";

export const runtime = "nodejs";

const bookingPatchSchema = z.object({
  hotel_id: z.string().uuid().optional(),
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

async function hasColumn(admin: SupabaseClient, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
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
      .select("tenant_id, agency_id, role")
      .eq("user_id", user.id)
      .maybeSingle();

    const role = parseRole(membership?.role);
    if (!membership?.tenant_id || !role || (role !== "agency" && role !== "admin")) {
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }
    const supportsCreatedByUserId = await hasColumn(admin, "services", "created_by_user_id");

    const { id: serviceId } = await params;
    let existingQuery = admin
      .from("services")
      .select("id, tenant_id, customer_first_name, customer_last_name, phone, booking_service_kind, direction, hotel_id, billing_party_name, orario_barca, departure_date, departure_time, date")
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id);

    if (role === "agency") {
      if (membership.agency_id && supportsCreatedByUserId) {
        existingQuery = existingQuery.or(`agency_id.eq.${membership.agency_id},created_by_user_id.eq.${user.id}`);
      } else if (membership.agency_id) {
        existingQuery = existingQuery.eq("agency_id", membership.agency_id);
      } else if (supportsCreatedByUserId) {
        existingQuery = existingQuery.eq("created_by_user_id", user.id);
      } else {
        return NextResponse.json({ error: "Schema incompleto: impossibile verificare l'agenzia proprietaria." }, { status: 503 });
      }
    }

    const { data: existing } = await existingQuery.maybeSingle();

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

    if (patch.hotel_id !== undefined) update.hotel_id = patch.hotel_id;
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

    // Step B — ricalcolo write-time pickup Formula direct: l'agenzia NON può
    // riassegnare agency_id/billing_party_name (nessun campo simile in
    // bookingPatchSchema — permessi invariati), quindi qui l'unico trigger
    // possibile è hotel_id e/o la data/orario di partenza. Nessuna query a
    // ferry_pickup_rules se nessuno di questi è realmente cambiato.
    const agencyCurrentPickupState: FormulaPickupEditState = {
      booking_service_kind: existing.booking_service_kind as string | null,
      direction: existing.direction as string | null,
      hotel_id: existing.hotel_id as string | null,
      billing_party_name: existing.billing_party_name as string | null,
      orario_barca: existing.orario_barca as string | null,
      departure_date: existing.departure_date as string | null,
      departure_time: existing.departure_time as string | null,
      date: existing.date as string | null,
    };
    const agencyFinalPickupState: FormulaPickupEditState = {
      ...agencyCurrentPickupState,
      hotel_id: patch.hotel_id !== undefined ? patch.hotel_id : agencyCurrentPickupState.hotel_id,
      departure_date: patch.departure_date !== undefined ? patch.departure_date : agencyCurrentPickupState.departure_date,
      departure_time: patch.departure_time !== undefined ? patch.departure_time : agencyCurrentPickupState.departure_time,
    };
    const agencyPickupRecalc = await recalculateDirectFormulaPickupForEdit(
      admin,
      agencyCurrentPickupState,
      agencyFinalPickupState
    );
    if (agencyPickupRecalc) {
      update.pickup_hotel = agencyPickupRecalc.pickup_hotel;
      update.pickup_alert = agencyPickupRecalc.pickup_alert;
    }

    // Fetch service details for notification email
    const { data: serviceForMail } = await admin
      .from("services")
      .select("customer_name, date, arrival_date, arrival_time, departure_date, departure_time, pax, hotels(name), agencies(name)")
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id)
      .maybeSingle();

    const { error: updateError } = await admin
      .from("services")
      .update(update)
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    if (patch.customer_phone !== undefined || patch.customer_first_name !== undefined || patch.customer_last_name !== undefined) {
      ensureWhatsAppContact(admin, {
        tenantId: membership.tenant_id,
        phone: patch.customer_phone ?? (existing.phone as string | null),
        profileName: `${firstName} ${lastName}`.trim(),
      }).catch((contactError) => console.error("WhatsApp contact creation failed:", contactError));
    }

    // Notifica operatore della modifica
    const operatorEmail = process.env.OPERATOR_NOTIFICATION_EMAIL ?? process.env.AGENCY_BOOKING_FROM_EMAIL ?? null;
    if (operatorEmail && serviceForMail) {
      const agencyNameMail =
        Array.isArray(serviceForMail.agencies) ? (serviceForMail.agencies[0] as { name?: string })?.name ?? "Agenzia"
        : (serviceForMail.agencies as { name?: string } | null)?.name ?? (membership as { full_name?: string | null }).full_name ?? "Agenzia";
      const hotelNameMail =
        Array.isArray(serviceForMail.hotels) ? (serviceForMail.hotels[0] as { name?: string })?.name ?? "N/D"
        : (serviceForMail.hotels as { name?: string } | null)?.name ?? "N/D";
      const pivotDate = (serviceForMail.arrival_date ?? serviceForMail.date) as string | null;
      const dateLabel = pivotDate ? pivotDate.split("-").reverse().join("/") : "—";
      const changedFields = Object.keys(update).filter((k) => k !== "customer_name").join(", ");
      await sendEmail({
        to: operatorEmail,
        subject: `✏️ Modifica prenotazione — ${agencyNameMail} — ${dateLabel}`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
          <h2 style="color:#1e3a8a;margin-bottom:8px;">Prenotazione modificata dall'agenzia</h2>
          <p style="color:#475569;">L'agenzia <strong>${agencyNameMail}</strong> ha modificato la seguente prenotazione:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${serviceForMail.customer_name ?? "—"}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Hotel</td><td style="padding:8px 12px;">${hotelNameMail}</td></tr>
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Data servizio</td><td style="padding:8px 12px;">${dateLabel}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Campi modificati</td><td style="padding:8px 12px;">${changedFields}</td></tr>
          </table>
          <p style="color:#64748b;font-size:13px;background:#eff6ff;padding:12px 16px;border-radius:8px;border:1px solid #93c5fd;">
            Accedi al gestionale per verificare i dettagli aggiornati.
          </p>
        </div>`,
      });
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

/**
 * DELETE /api/agency/bookings/[id]
 * Annulla la tratta (status = cancelled). NON elimina il record — rimane per l'estratto agenzia.
 * L'operatore riceve notifica email e decide penale/sconto.
 *
 * Body opzionale (JSON):
 *   cancel_legs  "arrival" | "departure" | "both"  (default "both")
 *   cancel_note  string (facoltativo — motivo cancellazione)
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
    const authHeader = request.headers.get("authorization");
    if (!supabaseUrl || !serviceRoleKey) return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
    if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

    const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const token = authHeader.slice("Bearer ".length);
    const { data: { user }, error: userError } = await admin.auth.getUser(token);
    if (userError || !user) return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });

    const { data: membership } = await admin
      .from("memberships")
      .select("tenant_id, agency_id, role, full_name")
      .eq("user_id", user.id)
      .maybeSingle();

    const role = parseRole(membership?.role);
    if (!membership?.tenant_id || !role || (role !== "agency" && role !== "admin")) {
      return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
    }

    // Legge body opzionale (cancel_legs, cancel_note)
    const bodyRaw = await request.json().catch(() => null) as { cancel_legs?: string; cancel_note?: string } | null;
    const cancelLegs: "arrival" | "departure" | "both" =
      bodyRaw?.cancel_legs === "arrival" ? "arrival" :
      bodyRaw?.cancel_legs === "departure" ? "departure" : "both";
    const cancelNote = typeof bodyRaw?.cancel_note === "string" ? bodyRaw.cancel_note.trim() : "";

    const { id: serviceId } = await params;
    const supportsCreatedByUserId = await hasColumn(admin, "services", "created_by_user_id");

    let query = admin
      .from("services")
      .select("id, status, customer_name, date, time, direction, hotel_id, pax, arrival_date, departure_date, agency_id, agencies(name), hotels(name)")
      .eq("id", serviceId)
      .eq("tenant_id", membership.tenant_id);

    if (role === "agency") {
      if (membership.agency_id && supportsCreatedByUserId) {
        query = query.or(`agency_id.eq.${membership.agency_id},created_by_user_id.eq.${user.id}`);
      } else if (membership.agency_id) {
        query = query.eq("agency_id", membership.agency_id);
      } else if (supportsCreatedByUserId) {
        query = query.eq("created_by_user_id", user.id);
      } else {
        return NextResponse.json({ error: "Schema incompleto: impossibile verificare l'agenzia." }, { status: 503 });
      }
    }

    const { data: service } = await query.maybeSingle();
    if (!service?.id) return NextResponse.json({ error: "Prenotazione non trovata." }, { status: 404 });
    if (service.status === "cancelled") return NextResponse.json({ ok: true, already_cancelled: true });

    // Annulla
    await admin.from("services").update({ status: "cancelled" }).eq("id", serviceId).eq("tenant_id", membership.tenant_id);

    const legLabel =
      cancelLegs === "arrival" ? "andata" :
      cancelLegs === "departure" ? "ritorno" : "andata+ritorno";
    const eventNotes = [
      `Tratta: ${legLabel}`,
      cancelNote ? `Motivo: ${cancelNote}` : null,
    ].filter(Boolean).join(" | ");

    await admin.from("status_events").insert({
      tenant_id: membership.tenant_id,
      service_id: serviceId,
      status: "cancelled",
      by_user_id: user.id,
      ...(eventNotes ? { notes: eventNotes } : {}),
    });

    // Notifica operatore
    const operatorEmail = process.env.OPERATOR_NOTIFICATION_EMAIL ?? process.env.AGENCY_BOOKING_FROM_EMAIL ?? null;
    if (operatorEmail) {
      const agencyName =
        Array.isArray(service.agencies) ? (service.agencies[0] as { name?: string })?.name ?? "Agenzia"
        : (service.agencies as { name?: string } | null)?.name ?? (membership.full_name as string | null | undefined) ?? "Agenzia";
      const hotelName =
        Array.isArray(service.hotels) ? (service.hotels[0] as { name?: string })?.name ?? "N/D"
        : (service.hotels as { name?: string } | null)?.name ?? "N/D";
      const dateFormatted = (service.arrival_date ?? service.date as string)?.split("-").reverse().join("/") ?? "—";
      const legHuman =
        cancelLegs === "arrival" ? "Solo andata" :
        cancelLegs === "departure" ? "Solo ritorno" : "Andata + Ritorno";

      await sendEmail({
        to: operatorEmail,
        subject: `Annullamento richiesto — ${agencyName} — ${service.customer_name} — ${dateFormatted}`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;">
          <h2 style="color:#991b1b;margin-bottom:8px;">Annullamento tratta — richiesta agenzia</h2>
          <p style="color:#475569;">L'agenzia <strong>${agencyName}</strong> ha richiesto l'annullamento:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;width:40%;">Cliente</td><td style="padding:8px 12px;">${service.customer_name}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Data</td><td style="padding:8px 12px;">${dateFormatted}</td></tr>
            <tr><td style="padding:8px 12px;background:#f8fafc;font-weight:600;">Hotel</td><td style="padding:8px 12px;">${hotelName}</td></tr>
            <tr><td style="padding:8px 12px;background:#f1f5f9;font-weight:600;">Pax</td><td style="padding:8px 12px;">${service.pax}</td></tr>
            <tr><td style="padding:8px 12px;background:#fef2f2;font-weight:700;color:#991b1b;">Tratta</td><td style="padding:8px 12px;color:#991b1b;font-weight:600;">${legHuman}</td></tr>
            ${cancelNote ? `<tr><td style="padding:8px 12px;background:#fef9c3;font-weight:600;color:#854d0e;">Motivo</td><td style="padding:8px 12px;color:#854d0e;">${cancelNote}</td></tr>` : ""}
          </table>
          <p style="color:#64748b;font-size:13px;background:#fef9c3;padding:12px 16px;border-radius:8px;border:1px solid #d97706;">
            <strong>Azione richiesta:</strong> decidere se applicare una penale. Usa "Cancella con penale" nella sezione Richieste prenotazioni agenzie.
          </p>
        </div>`,
      });
    }

    auditLog({ event: "agency_booking_cancelled", tenantId: membership.tenant_id, userId: user.id, role, serviceId, outcome: "cancelled", details: { legs: cancelLegs } });
    return NextResponse.json({ ok: true, cancelled: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Errore interno." }, { status: 500 });
  }
}
