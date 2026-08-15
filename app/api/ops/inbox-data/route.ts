import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

// Sprint Performance 11: route dedicata Inbox. A differenza di /api/ops/dispatch-data
// (che serve il Dispatch e per questo carica storico servizi + assignments + vehicles +
// driver registry completi), Inbox usa solo: pagina di inbound_emails più recenti,
// hotel/driver minimi (solo alla prima pagina) e i services collegati a quella pagina
// di email (più l'insieme "attivo" per i contatori, solo alla prima pagina).
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const EMAIL_COLUMNS = "id, tenant_id, subject, parsed_json, body_text, raw_text, created_at";
const SERVICE_COLUMNS =
  "id, tenant_id, status, is_draft, date, direction, booking_service_kind, service_type_code, route_kind, vessel, customer_name, customer_first_name, customer_last_name, inbound_email_id";
const HOTEL_COLUMNS = "id, tenant_id, name";
const DRIVER_COLUMNS = "user_id, tenant_id, role, full_name";

// Stessa condizione "attivo indipendentemente dalla data" già usata da dispatch-data,
// ma qui SENZA la finestra dei 30 giorni di storico terminale: Inbox non la usa (vedi
// audit FASE 1), quindi la omettiamo per ridurre il dataset.
const ACTIVE_SERVICE_STATUS_FILTER = "status.not.in.(completato,cancelled)";

type InboxEmailRow = {
  id: string;
  tenant_id: string;
  subject: string | null;
  parsed_json: Record<string, unknown> | null;
  body_text: string | null;
  raw_text: string | null;
  created_at: string;
};

function parsePositiveInt(value: string | null, fallback: number, max?: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return typeof max === "number" ? Math.min(parsed, max) : parsed;
}

function extractLinkedServiceId(parsedJson: Record<string, unknown> | null): string | null {
  if (!parsedJson) return null;
  const linked = parsedJson.linked_service_id ?? parsedJson.draft_service_id;
  return typeof linked === "string" && linked.length > 0 ? linked : null;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const tenantId = auth.membership.tenant_id;
    const url = new URL(request.url);
    const page = parsePositiveInt(url.searchParams.get("page"), 1);
    const pageSize = parsePositiveInt(url.searchParams.get("page_size"), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const isFirstPage = page === 1;

    // Richiediamo una riga in più (range inclusivo) per sapere se esiste una pagina
    // successiva senza una query di conteggio separata.
    const emailsResult = await auth.admin
      .from("inbound_emails")
      .select(EMAIL_COLUMNS)
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize);

    if (emailsResult.error) {
      return NextResponse.json({ ok: false, error: emailsResult.error.message }, { status: 500 });
    }

    const rawEmails = (emailsResult.data ?? []) as InboxEmailRow[];
    const hasMore = rawEmails.length > pageSize;
    const emails = hasMore ? rawEmails.slice(0, pageSize) : rawEmails;

    const linkedServiceIds = Array.from(
      new Set(
        emails
          .map((email) => extractLinkedServiceId(email.parsed_json))
          .filter((id): id is string => Boolean(id))
      )
    );
    const emailIds = emails.map((email) => email.id);

    const serviceOrParts: string[] = [];
    if (isFirstPage) serviceOrParts.push(ACTIVE_SERVICE_STATUS_FILTER);
    if (linkedServiceIds.length > 0) serviceOrParts.push(`id.in.(${linkedServiceIds.join(",")})`);
    if (emailIds.length > 0) serviceOrParts.push(`inbound_email_id.in.(${emailIds.join(",")})`);

    const [servicesResult, hotelsResult, driversResult] = await Promise.all([
      serviceOrParts.length > 0
        ? auth.admin.from("services").select(SERVICE_COLUMNS).eq("tenant_id", tenantId).or(serviceOrParts.join(","))
        : Promise.resolve({ data: [], error: null }),
      isFirstPage
        ? auth.admin.from("hotels").select(HOTEL_COLUMNS).eq("tenant_id", tenantId)
        : Promise.resolve({ data: [], error: null }),
      isFirstPage
        ? auth.admin.from("memberships").select(DRIVER_COLUMNS).eq("tenant_id", tenantId).eq("role", "driver")
        : Promise.resolve({ data: [], error: null })
    ]);

    const error = servicesResult.error ?? hotelsResult.error ?? driversResult.error ?? null;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      user_id: auth.user.id,
      page,
      page_size: pageSize,
      has_more: hasMore,
      inbound_emails: emails,
      services: servicesResult.data ?? [],
      hotels: hotelsResult.data ?? [],
      drivers: driversResult.data ?? []
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
