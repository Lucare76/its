import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { buildServiceLabel, buildServiceLabelShort, type AgencyBookingKind, type ServiceLabelContext } from "@/lib/service-label";
import { sendEmail as sendEmailUtil } from "@/lib/server/send-email";
import { fmtDate } from "@/lib/server/email-layout";

export const runtime = "nodejs";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "");
  if (!url || !key) throw new Error("Supabase env non configurato.");
  return createClient(url, key, { auth: { persistSession: false } });
}

const responseSchema = z.object({
  response: z.enum(["accepted", "changes_requested"]),
  notes: z.string().max(1000).optional(),
});

type ServiceRow = {
  id: string;
  tenant_id: string;
  customer_name: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  pax: number;
  arrival_date: string | null;
  arrival_time: string | null;
  departure_date: string | null;
  departure_time: string | null;
  booking_service_kind: AgencyBookingKind | null;
  transport_code: string | null;
  bus_city_origin: string | null;
  excursion_details: { title?: string } | null;
  notes: string | null;
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
    hotelName,
  };
}

// GET — carica dati dal token agenzia
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const admin = getAdmin();
    const { data: tokenRow } = await admin
      .from("booking_approval_tokens")
      .select("id, tenant_id, service_id, resolved_price_cents, action, agency_response, agency_response_at")
      .eq("agency_token", token)
      .maybeSingle();

    if (!tokenRow) return NextResponse.json({ error: "Link non valido." }, { status: 404 });
    if (tokenRow.action !== "confirmed") return NextResponse.json({ error: "La prenotazione non è ancora stata confermata dall'operatore." }, { status: 409 });

    if (tokenRow.agency_response) {
      return NextResponse.json({
        error: "Risposta già registrata.",
        already_responded: true,
        response: tokenRow.agency_response,
      }, { status: 410 });
    }

    const { data: service } = await admin
      .from("services")
      .select("id,tenant_id,customer_name,customer_first_name,customer_last_name,pax,arrival_date,arrival_time,departure_date,departure_time,booking_service_kind,transport_code,bus_city_origin,excursion_details,notes,hotels(name)")
      .eq("tenant_id", tokenRow.tenant_id)
      .eq("id", tokenRow.service_id)
      .maybeSingle() as { data: ServiceRow | null };

    if (!service) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });

    const hotelName = resolveHotelName(service.hotels);
    const customerName = service.customer_first_name && service.customer_last_name
      ? `${service.customer_first_name} ${service.customer_last_name}`
      : service.customer_name;

    return NextResponse.json({
      ok: true,
      service: {
        id: service.id,
        customer_name: customerName,
        pax: service.pax,
        arrival_date: service.arrival_date ?? "",
        arrival_time: service.arrival_time ?? "",
        departure_date: service.departure_date ?? "",
        departure_time: service.departure_time ?? "",
        hotel_name: hotelName,
        service_label: buildServiceLabel(buildCtx(service, hotelName)),
        notes: service.notes ?? "",
      },
      price_cents: tokenRow.resolved_price_cents ?? null,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}

// POST — registra risposta agenzia
export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const admin = getAdmin();
    const body = await request.json().catch(() => null);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });

    const { response, notes } = parsed.data;

    const { data: tokenRow } = await admin
      .from("booking_approval_tokens")
      .select("id, tenant_id, service_id, action, agency_response")
      .eq("agency_token", token)
      .maybeSingle();

    if (!tokenRow) return NextResponse.json({ error: "Link non valido." }, { status: 404 });
    if (tokenRow.action !== "confirmed") return NextResponse.json({ error: "Prenotazione non ancora confermata dall'operatore." }, { status: 409 });
    if (tokenRow.agency_response) return NextResponse.json({ error: "Risposta già registrata.", already_responded: true }, { status: 410 });

    await admin
      .from("booking_approval_tokens")
      .update({
        agency_response: response,
        agency_response_at: new Date().toISOString(),
        agency_response_notes: notes ?? null,
      })
      .eq("id", tokenRow.id);

    if (response === "changes_requested") {
      const [svcResult] = await Promise.all([
        admin.from("services")
          .select("id,customer_name,customer_first_name,customer_last_name,pax,arrival_date,arrival_time,booking_service_kind,transport_code,bus_city_origin,excursion_details,hotels(name),agencies(name)")
          .eq("id", tokenRow.service_id).eq("tenant_id", tokenRow.tenant_id).maybeSingle(),
        admin.from("services")
          .update({ approval_status: "agency_changes_requested", approval_notes: notes ?? null })
          .eq("id", tokenRow.service_id).eq("tenant_id", tokenRow.tenant_id),
      ]);
      const svc = svcResult.data as (typeof svcResult.data & { agencies?: { name: string } | null });
      const opsEmail = process.env.OPS_NOTIFY_EMAIL?.trim();
      if (opsEmail && svc) {
        const hotelRow = Array.isArray(svc.hotels) ? svc.hotels[0] : svc.hotels;
        const hotelName = (hotelRow as { name?: string } | null)?.name ?? "N/D";
        const agencyName = (svc.agencies as { name?: string } | null)?.name ?? "Agenzia";
        const customerName = svc.customer_first_name && svc.customer_last_name
          ? `${svc.customer_first_name} ${svc.customer_last_name}` : svc.customer_name;
        const serviceLabel = buildServiceLabelShort({ kind: svc.booking_service_kind ?? "transfer_port_hotel", transportCode: svc.transport_code ?? null, busCityOrigin: svc.bus_city_origin ?? null, excursionTitle: (svc.excursion_details as { title?: string } | null)?.title ?? null });
        const subject = `✏️ Modifica richiesta — ${serviceLabel}, ${fmtDate(svc.arrival_date ?? "")}`;
        const bodyText = [`AGENZIA HA RICHIESTO MODIFICHE`, `Servizio: ${serviceLabel}`, `Cliente: ${customerName}`, `Agenzia: ${agencyName}`, `Arrivo: ${fmtDate(svc.arrival_date ?? "")} ${svc.arrival_time ?? ""}`, `Pax: ${svc.pax}`, notes ? `Note agenzia: ${notes}` : null].filter(Boolean).join("\n");
        await sendEmailUtil({ to: opsEmail, subject, html: `<pre style="font-family:sans-serif">${bodyText}</pre>`, text: bodyText });
      }
    }

    return NextResponse.json({ ok: true, response });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Errore interno." }, { status: 500 });
  }
}
