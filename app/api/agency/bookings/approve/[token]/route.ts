import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { buildServiceLabel, type AgencyBookingKind, type ServiceLabelContext } from "@/lib/service-label";
import { sendAgencyConfirmedEmail, sendAgencyRejectedEmail } from "@/lib/server/agency-approval-email";

export const runtime = "nodejs";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) throw new Error("Supabase env non configurato.");
  return createClient(url, key, { auth: { persistSession: false } });
}

const actionSchema = z.object({
  action: z.enum(["confirmed", "rejected"]),
  price_cents: z.number().int().min(0).optional(),
  notes: z.string().max(1000).optional(),
  resolved_by_email: z.string().email().max(160).optional()
});

type ServiceRow = {
  id: string;
  tenant_id: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_email: string | null;
  phone: string | null;
  pax: number;
  date: string;
  time: string;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  transport_code: string | null;
  bus_city_origin: string | null;
  excursion_details: { title?: string } | null;
  notes: string | null;
  booking_service_kind: AgencyBookingKind | null;
  agency_id: string | null;
  approval_status: string | null;
  email_confirmation_to: string | null;
  hotels: { name: string } | { name: string }[] | null;
};

function resolveHotelName(hotels: ServiceRow["hotels"]): string {
  if (!hotels) return "Hotel N/D";
  const row = Array.isArray(hotels) ? hotels[0] : hotels;
  return row?.name ?? "Hotel N/D";
}

function buildCtx(service: ServiceRow, hotelName: string): ServiceLabelContext {
  return {
    kind: service.booking_service_kind ?? "transfer_port_hotel",
    transportCode: service.transport_code,
    busCityOrigin: service.bus_city_origin,
    excursionTitle: service.excursion_details?.title ?? null,
    hotelName
  };
}

async function lookupSuggestedPrice(
  admin: ReturnType<typeof getAdmin>,
  tenantId: string,
  service: ServiceRow
): Promise<{ price_cents: number | null; source: string }> {
  try {
    const date = service.arrival_date ?? service.date;
    const { data: priceLists } = await admin
      .from("price_lists")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .lte("valid_from", date)
      .or(`valid_to.is.null,valid_to.gte.${date}`)
      .order("is_default", { ascending: false })
      .limit(1);

    const priceListId = priceLists?.[0]?.id ?? null;
    if (!priceListId) return { price_cents: null, source: "no_price_list" };

    const kind = service.booking_service_kind;
    const serviceType = kind === "excursion" ? "bus_tour" : "transfer";
    const pax = service.pax ?? 1;

    const { data: rules } = await admin
      .from("pricing_rules")
      .select("id, rule_kind, public_price_cents, agency_price_cents, pax_min, pax_max, agency_id, priority")
      .eq("tenant_id", tenantId)
      .eq("price_list_id", priceListId)
      .eq("active", true)
      .eq("service_type", serviceType)
      .lte("pax_min", pax)
      .order("priority", { ascending: false })
      .limit(20);

    if (!rules || rules.length === 0) return { price_cents: null, source: "no_rule" };

    type PricingRule = { id: string; rule_kind: string; public_price_cents: number; agency_price_cents: number | null; pax_min: number; pax_max: number | null; agency_id: string | null; priority: number };
    const agencyRules = service.agency_id ? (rules as PricingRule[]).filter(r => r.agency_id === service.agency_id) : [];
    const genericRules = (rules as PricingRule[]).filter(r => !r.agency_id);
    const candidates = agencyRules.length > 0 ? agencyRules : genericRules;
    const rule = candidates.find(r => r.pax_max === null || r.pax_max >= pax) ?? candidates[0];
    if (!rule) return { price_cents: null, source: "no_rule" };

    const multiplier = rule.rule_kind === "per_pax" ? pax : 1;
    const finalPrice = rule.agency_price_cents != null
      ? rule.agency_price_cents * multiplier
      : rule.public_price_cents * multiplier;

    return { price_cents: finalPrice, source: agencyRules.length > 0 ? "agency_rule" : "generic_rule" };
  } catch {
    return { price_cents: null, source: "error" };
  }
}

// GET — carica dati token + servizio + prezzo suggerito
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const admin = getAdmin();

    const { data: tokenRow } = await admin
      .from("booking_approval_tokens")
      .select("id, tenant_id, service_id, action, expires_at, used_at")
      .eq("token", token)
      .maybeSingle();

    if (!tokenRow) return NextResponse.json({ error: "Link non valido o scaduto." }, { status: 404 });
    if (tokenRow.used_at) return NextResponse.json({ error: "Link già utilizzato.", already_used: true, action: tokenRow.action }, { status: 410 });
    if (new Date(tokenRow.expires_at) < new Date()) return NextResponse.json({ error: "Link scaduto (48 ore)." }, { status: 410 });

    const { data: service } = await admin
      .from("services")
      .select("id,tenant_id,customer_name,customer_first_name,customer_last_name,customer_email,phone,pax,date,time,arrival_date,arrival_time,departure_date,departure_time,transport_code,bus_city_origin,excursion_details,notes,booking_service_kind,agency_id,approval_status,email_confirmation_to,hotels(name)")
      .eq("tenant_id", tokenRow.tenant_id)
      .eq("id", tokenRow.service_id)
      .maybeSingle() as { data: ServiceRow | null };

    if (!service) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

    const { data: agencyRow } = service.agency_id
      ? await admin.from("agencies").select("name").eq("id", service.agency_id).maybeSingle()
      : { data: null };

    const hotelName = resolveHotelName(service.hotels);
    const pricing = await lookupSuggestedPrice(admin, tokenRow.tenant_id, service);

    return NextResponse.json({
      ok: true,
      service: {
        id: service.id,
        customer_first_name: service.customer_first_name ?? null,
        customer_last_name: service.customer_last_name ?? null,
        customer_name: service.customer_first_name && service.customer_last_name
          ? `${service.customer_first_name} ${service.customer_last_name}`
          : service.customer_name,
        customer_email: service.customer_email ?? service.email_confirmation_to ?? null,
        phone: service.phone ?? null,
        pax: service.pax,
        arrival_date: service.arrival_date ?? service.date,
        arrival_time: service.arrival_time ?? service.time,
        departure_date: service.departure_date ?? service.date,
        departure_time: service.departure_time ?? service.time,
        hotel_name: hotelName,
        booking_service_kind: service.booking_service_kind,
        notes: service.notes ?? "",
        service_label: buildServiceLabel(buildCtx(service, hotelName)),
        agency_name: agencyRow?.name ?? null,
        approval_status: service.approval_status
      },
      pricing: { suggested_price_cents: pricing.price_cents, source: pricing.source }
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// POST — processa conferma o rifiuto
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const admin = getAdmin();
    const body = await request.json().catch(() => null);
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });

    const { action, price_cents, notes, resolved_by_email } = parsed.data;
    if (action === "confirmed" && (price_cents === undefined || price_cents === null)) {
      return NextResponse.json({ error: "Il prezzo è obbligatorio per confermare." }, { status: 400 });
    }

    const { data: tokenRow } = await admin
      .from("booking_approval_tokens")
      .select("id, tenant_id, service_id, used_at, expires_at")
      .eq("token", token)
      .maybeSingle();

    if (!tokenRow) return NextResponse.json({ error: "Link non valido." }, { status: 404 });
    if (tokenRow.used_at) return NextResponse.json({ error: "Link già utilizzato.", already_used: true }, { status: 410 });
    if (new Date(tokenRow.expires_at) < new Date()) return NextResponse.json({ error: "Link scaduto." }, { status: 410 });

    const { data: service } = await admin
      .from("services")
      .select("id,tenant_id,customer_name,customer_first_name,customer_last_name,customer_email,phone,pax,date,time,arrival_date,arrival_time,departure_date,departure_time,transport_code,bus_city_origin,excursion_details,notes,booking_service_kind,agency_id,approval_status,email_confirmation_to,hotels(name)")
      .eq("tenant_id", tokenRow.tenant_id)
      .eq("id", tokenRow.service_id)
      .maybeSingle() as { data: ServiceRow | null };

    if (!service) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

    const now = new Date().toISOString();

    await admin.from("booking_approval_tokens")
      .update({ used_at: now, action, resolved_price_cents: price_cents ?? null, resolved_notes: notes ?? null, resolved_by_email: resolved_by_email ?? null })
      .eq("id", tokenRow.id);

    const serviceUpdate: Record<string, unknown> = { approval_status: action, approval_notes: notes ?? null, approval_resolved_at: now };
    if (action === "confirmed" && price_cents !== undefined) {
      serviceUpdate.approval_price_cents = price_cents;
      serviceUpdate.final_price_cents = price_cents;
      serviceUpdate.agency_price_cents = price_cents;
    }
    await admin.from("services").update(serviceUpdate).eq("id", service.id).eq("tenant_id", tokenRow.tenant_id);

    const hotelName = resolveHotelName(service.hotels);
    const ctx = buildCtx(service, hotelName);
    const customerName = service.customer_first_name && service.customer_last_name
      ? `${service.customer_first_name} ${service.customer_last_name}`
      : service.customer_name;
    // L'email di conferma/rifiuto va sempre all'agenzia, non al cliente finale
    const emailTo = service.email_confirmation_to ?? service.customer_email ?? null;

    const { data: agencyRow } = service.agency_id
      ? await admin.from("agencies").select("name").eq("id", service.agency_id).maybeSingle()
      : { data: null };

    // Il saluto usa il nome agenzia (mai il nome del passeggero)
    const agencyDisplayName = agencyRow?.name?.trim() || null;

    const emailBase = {
      to: emailTo,
      customerName: agencyDisplayName ?? customerName,
      agencyName: agencyDisplayName,
      serviceCtx: { ...ctx, hotelName },
      arrivalDate: service.arrival_date ?? service.date,
      arrivalTime: service.arrival_time ?? service.time,
      departureDate: service.departure_date ?? service.date,
      departureTime: service.departure_time ?? service.time,
      hotelName,
      pax: service.pax,
      notes: service.notes ?? "",
      operatorNotes: notes ?? null
    };

    const emailResult = action === "confirmed"
      ? await sendAgencyConfirmedEmail({ ...emailBase, priceCents: price_cents! })
      : await sendAgencyRejectedEmail(emailBase);

    return NextResponse.json({ ok: true, action, email_status: emailResult.status, email_error: emailResult.error });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
