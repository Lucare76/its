/**
 * POST /api/ops/add-service
 * Inserisce un singolo servizio (arrivo O partenza) dall'operatore.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const bodySchema = z.object({
  direction: z.enum(["arrival", "departure"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
  customer_name: z.string().min(2).max(120),
  pax: z.number().int().min(1).max(50),
  hotel_id: z.string().uuid().optional().or(z.literal("")),
  vessel: z.string().max(80).optional().or(z.literal("")),
  meeting_point: z.string().max(120).optional().or(z.literal("")),
  phone: z.string().max(30).optional().or(z.literal("")),
  notes: z.string().max(2000).optional().or(z.literal(""))
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi." }, { status: 400 });

  const d = parsed.data;
  const tenantId = auth.membership.tenant_id;

  const insert: Record<string, unknown> = {
    tenant_id: tenantId,
    is_draft: false,
    status: "new",
    direction: d.direction,
    date: d.date,
    time: d.time,
    customer_name: d.customer_name.trim(),
    pax: d.pax,
    service_type: "transfer",
    vessel: d.vessel?.trim() || null,
    meeting_point: d.meeting_point?.trim() || null,
    phone: d.phone?.trim() || null,
    notes: d.notes?.trim() || null,
    hotel_id: d.hotel_id || null,
    billing_party_name: null
  };

  // Per gli arrivi: arrival_date/arrival_time; per le partenze: departure_date/departure_time
  if (d.direction === "arrival") {
    insert.arrival_date = d.date;
    insert.arrival_time = d.time;
  } else {
    insert.departure_date = d.date;
    insert.departure_time = d.time;
  }

  const { data, error } = await auth.admin
    .from("services")
    .insert(insert)
    .select("id")
    .single();

  if (error || !data?.id) return NextResponse.json({ error: error?.message ?? "Inserimento fallito." }, { status: 500 });

  await auth.admin.from("status_events").insert({
    tenant_id: tenantId,
    service_id: data.id,
    status: "new",
    by_user_id: auth.user.id
  });

  return NextResponse.json({ ok: true, id: data.id });
}
