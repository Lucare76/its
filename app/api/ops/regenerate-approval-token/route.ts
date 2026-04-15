/**
 * POST /api/ops/regenerate-approval-token
 * Invalida i token scaduti/usati per un servizio e ne genera uno nuovo,
 * poi invia l'email di notifica all'operatore.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendOperatorNotifyEmail } from "@/lib/server/agency-approval-email";
import type { ServiceLabelContext } from "@/lib/service-label";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  let body: { service_id?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Body JSON non valido." }, { status: 400 }); }

  const serviceId = body.service_id?.trim();
  if (!serviceId) return NextResponse.json({ error: "service_id richiesto." }, { status: 400 });

  const tenantId = auth.membership.tenant_id;

  // Carica i dettagli del servizio
  const { data: svc, error: svcErr } = await auth.admin
    .from("services")
    .select("id,customer_name,customer_first_name,customer_last_name,phone,pax,arrival_date,arrival_time,departure_date,departure_time,booking_service_kind,approval_status,notes,transport_code,bus_city_origin,excursion_details,hotels(name),agencies(name),customer_email")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (svcErr) return NextResponse.json({ error: svcErr.message }, { status: 500 });
  if (!svc) return NextResponse.json({ error: "Servizio non trovato." }, { status: 404 });
  if (svc.approval_status !== "pending_operator") {
    return NextResponse.json({ error: "Il servizio non è più in attesa di approvazione." }, { status: 409 });
  }

  // Invalida i vecchi token (marca come usati)
  await auth.admin
    .from("booking_approval_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("service_id", serviceId)
    .eq("tenant_id", tenantId)
    .is("used_at", null);

  // Crea nuovo token
  const { data: tokenRow, error: tokenErr } = await auth.admin
    .from("booking_approval_tokens")
    .insert({ tenant_id: tenantId, service_id: serviceId })
    .select("token")
    .single();

  if (tokenErr || !tokenRow) {
    return NextResponse.json({ error: tokenErr?.message ?? "Errore creazione token." }, { status: 500 });
  }

  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://app.ischiatransferservice.it";
  const approvalUrl = `${appBaseUrl}/operator/approve/${tokenRow.token}`;

  // Dati per l'email
  const hotelsRaw = svc.hotels;
  const hotelName = (Array.isArray(hotelsRaw) ? hotelsRaw[0] : hotelsRaw)?.name ?? "";
  const agenciesRaw = svc.agencies;
  const agencyName = (Array.isArray(agenciesRaw) ? agenciesRaw[0] : agenciesRaw)?.name ?? null;
  const customerName = svc.customer_first_name && svc.customer_last_name
    ? `${svc.customer_first_name} ${svc.customer_last_name}`
    : svc.customer_name;

  const excursionDetails = svc.excursion_details as { title?: string } | null;
  const serviceCtx: ServiceLabelContext = {
    kind: svc.booking_service_kind ?? "transfer_port_hotel",
    transportCode: svc.transport_code ?? null,
    busCityOrigin: svc.bus_city_origin ?? null,
    excursionTitle: excursionDetails?.title ?? null,
    hotelName,
  };

  await sendOperatorNotifyEmail({
    serviceId,
    customerName,
    customerPhone: svc.phone ?? "—",
    customerEmail: svc.customer_email ?? null,
    agencyName,
    serviceCtx,
    arrivalDate: svc.arrival_date ?? "",
    arrivalTime: svc.arrival_time ?? "",
    departureDate: svc.departure_date ?? "",
    departureTime: svc.departure_time ?? "",
    hotelName,
    pax: svc.pax ?? 1,
    notes: svc.notes ?? "",
    approvalUrl,
  });

  return NextResponse.json({ ok: true, token: tokenRow.token });
}
