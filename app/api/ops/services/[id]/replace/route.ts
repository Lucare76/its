import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const replaceSchema = z.object({
  customer_first_name: z.string().max(80).optional(),
  customer_last_name: z.string().min(1).max(80),
  customer_phone: z.string().min(6).max(30),
  pax: z.number().int().min(1).max(99),
  hotel_id: z.string().uuid(),
  arrival_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  arrival_time: z.string().regex(/^\d{2}:\d{2}$/),
  departure_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  departure_time: z.string().regex(/^\d{2}:\d{2}$/),
  transport_code: z.string().max(80).optional().nullable(),
  bus_city_origin: z.string().max(120).optional().nullable(),
  notes: z.string().max(2000),
  agency_id: z.union([z.string().uuid(), z.literal(""), z.null()]).optional().transform((v) => v === "" ? null : v),
  agency_quoted_price_cents: z.number().int().optional().nullable(),
});

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const { id: serviceId } = await params;
  const tenantId = auth.membership.tenant_id;

  const { data: existing } = await auth.admin
    .from("services")
    .select("id")
    .eq("id", serviceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!existing?.id) {
    return NextResponse.json({ error: "Pratica non trovata." }, { status: 404 });
  }

  const parsed = replaceSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });
  }

  const d = parsed.data;
  const customerName = d.customer_first_name
    ? `${d.customer_first_name} ${d.customer_last_name}`.trim()
    : d.customer_last_name;

  const update: Record<string, unknown> = {
    customer_name: customerName,
    customer_last_name: d.customer_last_name,
    phone: d.customer_phone,
    pax: d.pax,
    hotel_id: d.hotel_id,
    arrival_date: d.arrival_date,
    arrival_time: d.arrival_time,
    departure_date: d.departure_date,
    departure_time: d.departure_time,
    date: d.arrival_date,
    time: d.arrival_time,
    notes: d.notes,
    transport_code: d.transport_code ?? null,
    bus_city_origin: d.bus_city_origin ?? null,
  };
  if (d.customer_first_name !== undefined) update.customer_first_name = d.customer_first_name;
  if (d.agency_id !== undefined) update.agency_id = d.agency_id ?? null;
  if (d.agency_quoted_price_cents !== undefined) update.agency_quoted_price_cents = d.agency_quoted_price_cents ?? null;

  const { error } = await auth.admin
    .from("services")
    .update(update)
    .eq("id", serviceId)
    .eq("tenant_id", tenantId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  auditLog({
    event: "ops_service_replaced",
    tenantId,
    userId: auth.user.id,
    role: auth.membership.role,
    serviceId,
    outcome: "replaced",
    details: { fields: Object.keys(update) }
  });

  return NextResponse.json({ ok: true, id: serviceId });
}
