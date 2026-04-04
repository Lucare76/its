import { NextRequest, NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseRole } from "@/lib/rbac";
import { resolvePreferredMembership } from "@/lib/tenant-preference";
import { agencyBookingCreateSchema } from "@/lib/validation";
import { sendAgencyBookingConfirmationEmail } from "@/lib/server/agency-booking-email";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

type AgencyRole = "admin" | "agency";
type BookingKind = z.infer<typeof agencyBookingCreateSchema>["booking_service_kind"];

interface AuthContext {
  admin: SupabaseClient;
  user: { id: string; email: string | null };
  membership: { tenant_id: string; agency_id: string | null; role: AgencyRole; full_name: string };
}

async function hasColumn(admin: SupabaseClient, table: string, column: string) {
  const { error } = await admin.from(table).select(column).limit(1);
  if (!error) return true;
  if ((error as { code?: string }).code === "42703") return false;
  throw new Error(`Schema probe failed for ${table}.${column}: ${error.message}`);
}

function kindLabel(kind: BookingKind) {
  if (kind === "transfer_port_hotel") return "Transfer porto - hotel";
  if (kind === "transfer_airport_hotel") return "Transfer aeroporto - hotel";
  if (kind === "transfer_train_hotel") return "Transfer stazione - hotel";
  if (kind === "bus_city_hotel") return "Bus da citta italiana - hotel";
  return "Escursione";
}

function vesselFromKind(kind: BookingKind, transportCode: string) {
  if (kind === "transfer_airport_hotel") return transportCode ? `Volo ${transportCode}` : "Transfer aeroporto";
  if (kind === "transfer_train_hotel") return transportCode ? `Treno ${transportCode}` : "Transfer stazione";
  if (kind === "transfer_port_hotel") return "Transfer porto";
  if (kind === "bus_city_hotel") return "Bus da citta italiana";
  return "Escursione";
}

async function authorizeAgencyRequest(request: NextRequest): Promise<AuthContext | NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const authHeader = request.headers.get("authorization");
  if (!supabaseUrl || !serviceRoleKey) {
    auditLog({ event: "agency_booking_config_missing", level: "error", details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Configurazione server mancante." }, { status: 500 });
  }
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  const token = authHeader.slice("Bearer ".length);
  const {
    data: { user },
    error: userError
  } = await admin.auth.getUser(token);
  if (userError || !user) {
    auditLog({ event: "agency_booking_invalid_session", level: "warn", details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Sessione non valida." }, { status: 401 });
  }

  const { data: memberships, error: membershipError } = await admin
    .from("memberships")
    .select("tenant_id, agency_id, role, full_name")
    .eq("user_id", user.id);
  const membership = resolvePreferredMembership(
    ((memberships ?? []) as Array<{ tenant_id: string; agency_id?: string | null; role: string; full_name?: string | null }>).map((item) => ({
      ...item,
      suspended: false
    }))
  );

  const role = parseRole(membership?.role);
  if (membershipError || !membership?.tenant_id || !role) {
    auditLog({ event: "agency_booking_membership_missing", level: "warn", userId: user.id, details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Membership non trovata." }, { status: 403 });
  }
  if (role !== "agency" && role !== "admin") {
    auditLog({ event: "agency_booking_role_denied", level: "warn", tenantId: membership.tenant_id, userId: user.id, role, details: { route: request.nextUrl.pathname } });
    return NextResponse.json({ error: "Ruolo non autorizzato." }, { status: 403 });
  }

  return {
    admin,
    user: { id: user.id, email: user.email ?? null },
    membership: {
      tenant_id: membership.tenant_id,
      agency_id: membership.agency_id ?? null,
      role,
      full_name: membership.full_name ?? ""
    }
  };
}

function combineDateTime(date: string, time: string) {
  return new Date(`${date}T${time}:00`);
}

async function resolveAgencyId(
  auth: AuthContext,
  requestedAgencyId: string | undefined
): Promise<{ agencyId: string | null; error?: string }> {
  if (requestedAgencyId) {
    const { data } = await auth.admin
      .from("agencies")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", requestedAgencyId)
      .maybeSingle();
    if (!data?.id) {
      return { agencyId: null, error: "Agenzia selezionata non valida." };
    }
    return { agencyId: data.id };
  }

  if (auth.membership.role !== "agency") {
    return { agencyId: null };
  }

  if (auth.membership.agency_id) {
    const { data: agencyByMembership, error: agencyByMembershipError } = await auth.admin
      .from("agencies")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", auth.membership.agency_id)
      .maybeSingle();
    if (agencyByMembershipError) {
      return { agencyId: null, error: agencyByMembershipError.message };
    }
    if (agencyByMembership?.id) {
      return { agencyId: agencyByMembership.id };
    }
  }

  const supportsExternalCode = await hasColumn(auth.admin, "agencies", "external_code");
  const externalCode = `auth_user:${auth.user.id}`;
  const baseNameRaw = auth.membership.full_name.trim() || auth.user.email?.split("@")[0] || "Agenzia";
  const baseName = baseNameRaw.slice(0, 96);
  const fallbackName = `${baseName} ${auth.user.id.slice(0, 6)}`;

  if (supportsExternalCode) {
    const { data: existingAgency } = await auth.admin
      .from("agencies")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("external_code", externalCode)
      .maybeSingle();
    if (existingAgency?.id) {
      await auth.admin
        .from("memberships")
        .update({ agency_id: existingAgency.id })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("user_id", auth.user.id);
      return { agencyId: existingAgency.id };
    }
  } else {
    const { data: existingByName } = await auth.admin
      .from("agencies")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("name", baseName)
      .maybeSingle();
    if (existingByName?.id) {
      await auth.admin
        .from("memberships")
        .update({ agency_id: existingByName.id })
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("user_id", auth.user.id);
      return { agencyId: existingByName.id };
    }
  }

  let insertAttempt = supportsExternalCode
    ? await auth.admin
      .from("agencies")
      .insert({
        tenant_id: auth.membership.tenant_id,
        name: baseName,
        external_code: externalCode,
        active: true
      })
      .select("id")
      .single()
    : await auth.admin
        .from("agencies")
        .insert({
          tenant_id: auth.membership.tenant_id,
          name: baseName,
          active: true
        })
        .select("id")
        .single();

  if (insertAttempt.error || !insertAttempt.data?.id) {
    insertAttempt = supportsExternalCode
      ? await auth.admin
          .from("agencies")
          .insert({
            tenant_id: auth.membership.tenant_id,
            name: fallbackName,
            external_code: externalCode,
            active: true
          })
          .select("id")
          .single()
      : await auth.admin
          .from("agencies")
          .insert({
            tenant_id: auth.membership.tenant_id,
            name: fallbackName,
            active: true
          })
          .select("id")
          .single();
  }

  if (insertAttempt.error || !insertAttempt.data?.id) {
    return { agencyId: null, error: insertAttempt.error?.message ?? "Impossibile risolvere agenzia associata." };
  }

  await auth.admin
    .from("memberships")
    .update({ agency_id: insertAttempt.data.id })
    .eq("tenant_id", auth.membership.tenant_id)
    .eq("user_id", auth.user.id);

  return { agencyId: insertAttempt.data.id };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizeAgencyRequest(request);
    if (auth instanceof NextResponse) return auth;
    const supportsCreatedByUserId = await hasColumn(auth.admin, "services", "created_by_user_id");

    const url = new URL(request.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 1000)) : 200;

    let query = auth.admin
      .from("services")
      .select(
        "id,date,time,status,pax,customer_name,service_type,vessel,booking_service_kind,arrival_date,arrival_time,departure_date,departure_time,transport_code,bus_city_origin,include_ferry_tickets,email_confirmation_status,email_confirmation_sent_at,email_confirmation_to,notes,created_at,hotels(name,zone)"
      )
      .eq("tenant_id", auth.membership.tenant_id)
      .order("date", { ascending: false })
      .order("time", { ascending: false })
      .limit(limit);

    if (auth.membership.role === "agency") {
      const agencyIdResult = await resolveAgencyId(auth, undefined);

      if (supportsCreatedByUserId && agencyIdResult.agencyId) {
        query = query.or(`created_by_user_id.eq.${auth.user.id},agency_id.eq.${agencyIdResult.agencyId}`);
      } else if (supportsCreatedByUserId) {
        query = query.eq("created_by_user_id", auth.user.id);
      } else {
        if (!agencyIdResult.agencyId) {
          return NextResponse.json({ error: "Schema incompleto: impossibile filtrare prenotazioni agenzia." }, { status: 503 });
        }
        query = query.eq("agency_id", agencyIdResult.agencyId);
      }
    }

    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ error: "Errore caricamento prenotazioni." }, { status: 500 });
    }

    const rows = (data ?? []).map((row) => {
      const hotelRow = Array.isArray(row.hotels) ? row.hotels[0] : row.hotels;
      return {
        ...row,
        hotel_name: hotelRow?.name ?? "Hotel N/D",
        hotel_zone: hotelRow?.zone ?? null
      };
    });

    return NextResponse.json({ rows });
  } catch (error) {
    auditLog({ event: "agency_booking_list_failed", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizeAgencyRequest(request);
    if (auth instanceof NextResponse) return auth;
    const supportsCreatedByUserId = await hasColumn(auth.admin, "services", "created_by_user_id");

    const payload = await request.json().catch(() => null);
    const parsed = agencyBookingCreateSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const agencyIdResult = await resolveAgencyId(auth, parsed.data.agency_id || undefined);
    if (agencyIdResult.error) {
      return NextResponse.json({ error: agencyIdResult.error }, { status: 400 });
    }

    const { data: hotelData } = await auth.admin
      .from("hotels")
      .select("id, name")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.data.hotel_id)
      .maybeSingle();

    if (!hotelData?.id) {
      return NextResponse.json({ error: "Hotel non valido per il tenant corrente." }, { status: 400 });
    }

    const bookingKind = parsed.data.booking_service_kind;
    const serviceType = bookingKind === "excursion" ? "bus_tour" : "transfer";
    const notes = parsed.data.notes.trim();
    const customerName = `${parsed.data.customer_first_name.trim()} ${parsed.data.customer_last_name.trim()}`.trim();
    const transportCode = (parsed.data.transport_code ?? "").trim();
    const busCityOrigin = (parsed.data.bus_city_origin ?? "").trim();
    const customerEmail = (parsed.data.customer_email ?? "").trim();
    const ferryOutboundCode = (parsed.data.ferry_outbound_code ?? "").trim();
    const ferryReturnCode = (parsed.data.ferry_return_code ?? "").trim();
    const excursionTitle = (parsed.data.excursion_title ?? "").trim();
    const arrivalDateTime = combineDateTime(parsed.data.arrival_date, parsed.data.arrival_time);
    const departureDateTime = combineDateTime(parsed.data.departure_date, parsed.data.departure_time);
    if (departureDateTime.getTime() < arrivalDateTime.getTime()) {
      return NextResponse.json({ error: "Partenza non puo essere precedente all'arrivo." }, { status: 400 });
    }

    const baseInsert = {
      tenant_id: auth.membership.tenant_id,
      agency_id: agencyIdResult.agencyId,
      is_draft: false,
      date: parsed.data.arrival_date,
      time: parsed.data.arrival_time,
      service_type: serviceType,
      direction: "arrival",
      vessel: vesselFromKind(bookingKind, transportCode),
      pax: parsed.data.pax,
      hotel_id: parsed.data.hotel_id,
      customer_name: customerName,
      phone: parsed.data.customer_phone.trim(),
      notes,
      status: "new"
    };
    const insertPayloadBase = supportsCreatedByUserId
      ? { ...baseInsert, created_by_user_id: auth.user.id }
      : baseInsert;

    const extendedInsert = {
      ...insertPayloadBase,
      booking_service_kind: bookingKind,
      customer_first_name: parsed.data.customer_first_name.trim(),
      customer_last_name: parsed.data.customer_last_name.trim(),
      customer_email: customerEmail || null,
      arrival_date: parsed.data.arrival_date,
      arrival_time: parsed.data.arrival_time,
      departure_date: parsed.data.departure_date,
      departure_time: parsed.data.departure_time,
      transport_code: transportCode || null,
      bus_city_origin: busCityOrigin || null,
      include_ferry_tickets: parsed.data.include_ferry_tickets,
      ferry_details: {
        outbound_code: ferryOutboundCode || null,
        return_code: ferryReturnCode || null
      },
      excursion_details:
        bookingKind === "excursion"
          ? {
              title: excursionTitle
            }
          : {}
    };

    const duplicateWindow = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    let duplicateQuery = auth.admin
      .from("services")
      .select("id")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("customer_name", customerName)
      .eq("hotel_id", parsed.data.hotel_id)
      .eq("date", parsed.data.arrival_date)
      .eq("time", parsed.data.arrival_time)
      .eq("pax", parsed.data.pax)
      .eq("status", "new")
      .gte("created_at", duplicateWindow)
      .order("created_at", { ascending: false })
      .limit(1);
    if (supportsCreatedByUserId) {
      duplicateQuery = duplicateQuery.eq("created_by_user_id", auth.user.id);
    } else if (agencyIdResult.agencyId) {
      duplicateQuery = duplicateQuery.eq("agency_id", agencyIdResult.agencyId);
    }
    const { data: duplicate } = await duplicateQuery.maybeSingle();
    if (duplicate?.id) {
      auditLog({
        event: "agency_booking_duplicate_blocked",
        level: "warn",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        role: auth.membership.role,
        serviceId: duplicate.id,
        duplicate: true,
        outcome: "duplicate",
        details: { booking_kind: bookingKind, hotel_id: parsed.data.hotel_id, arrival_date: parsed.data.arrival_date }
      });
      return NextResponse.json({ ok: true, duplicate: true, existing_id: duplicate.id });
    }

    let insertAttempt = await auth.admin.from("services").insert(extendedInsert).select("id").single();
    if (insertAttempt.error || !insertAttempt.data?.id) {
      insertAttempt = await auth.admin.from("services").insert(insertPayloadBase).select("id").single();
    }
    if (insertAttempt.error || !insertAttempt.data?.id) {
      return NextResponse.json({ error: insertAttempt.error?.message ?? "Creazione prenotazione non riuscita." }, { status: 500 });
    }

    const serviceId = insertAttempt.data.id;
    await auth.admin.from("status_events").insert({
      tenant_id: auth.membership.tenant_id,
      service_id: serviceId,
      status: "new",
      by_user_id: auth.user.id
    });

    const betaFallbackRecipient = process.env.AGENCY_BOOKING_BETA_RECIPIENT_EMAIL?.trim() || null;
    const emailRecipient = customerEmail || auth.user.email || betaFallbackRecipient;
    const emailResult = await sendAgencyBookingConfirmationEmail({
      to: emailRecipient,
      customerName,
      serviceKindLabel: kindLabel(bookingKind),
      arrivalDate: parsed.data.arrival_date,
      arrivalTime: parsed.data.arrival_time,
      departureDate: parsed.data.departure_date,
      departureTime: parsed.data.departure_time,
      hotelName: hotelData.name,
      pax: parsed.data.pax,
      notes
    });

    await auth.admin
      .from("services")
      .update({
        email_confirmation_to: emailRecipient,
        email_confirmation_status: emailResult.status,
        email_confirmation_error: emailResult.error,
        email_confirmation_sent_at: emailResult.status === "sent" ? new Date().toISOString() : null
      })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", serviceId);

    auditLog({
      event: "agency_booking_created",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      serviceId,
      outcome: "created",
      details: {
        booking_kind: bookingKind,
        agency_id: agencyIdResult.agencyId,
        email_status: emailResult.status,
        email_recipient_present: Boolean(emailRecipient)
      }
    });

    return NextResponse.json({
      ok: true,
      id: serviceId,
      email_confirmation: {
        to: emailRecipient,
        status: emailResult.status,
        error: emailResult.error
      }
    });
  } catch (error) {
    auditLog({ event: "agency_booking_create_failed", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
