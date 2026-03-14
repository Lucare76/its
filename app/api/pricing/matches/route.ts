import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { tryMatchAndApplyPricing } from "@/lib/server/pricing-matching";

export const runtime = "nodejs";

type ReapplyServiceRow = {
  id: string;
  tenant_id: string;
  service_type: "transfer" | "bus_tour" | null;
  direction: "arrival" | "departure";
  date: string;
  time: string;
  pax: number | null;
};

type ReapplyEmailRow = {
  id: string;
  raw_text: string | null;
  extracted_text: string | null;
};

const actionSchema = z.object({
  action: z.enum(["approve", "reject", "reapply"]),
  ids: z.array(z.string().uuid()).min(1).max(200)
});

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, membership } = auth;

    const reviewOnly = request.nextUrl.searchParams.get("review_only") === "true";
    const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.round(limitRaw), 1), 500) : 200;

    let query = admin
      .from("inbound_booking_imports")
      .select("id, created_at, normalized_agency_name, normalized_route_name, pax, match_status, match_quality, review_required, match_confidence, service_id, pricing_rule_id, match_notes")
      .eq("tenant_id", membership.tenant_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (reviewOnly) query = query.eq("review_required", true);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ rows: data ?? [] });
  } catch (error) {
    console.error("Pricing matches GET error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const { admin, user, membership } = auth;

    const body = (await request.json().catch(() => null)) as unknown;
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { action, ids } = parsed.data;

    if (action === "approve") {
      const { error } = await (admin
        .from("inbound_booking_imports") as any)
        .update({
          review_required: false,
          match_status: "matched",
          reviewed_by_user_id: user.id,
          reviewed_at: now
        })
        .eq("tenant_id", membership.tenant_id)
        .in("id", ids);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action, updated: ids.length });
    }

    if (action === "reject") {
      const { error } = await (admin
        .from("inbound_booking_imports") as any)
        .update({
          review_required: false,
          match_status: "rejected",
          reviewed_by_user_id: user.id,
          reviewed_at: now
        })
        .eq("tenant_id", membership.tenant_id)
        .in("id", ids);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, action, updated: ids.length });
    }

    const { data: imports, error: importsError } = await admin
      .from("inbound_booking_imports")
      .select("id, inbound_email_id, service_id")
      .eq("tenant_id", membership.tenant_id)
      .in("id", ids);
    if (importsError) return NextResponse.json({ error: importsError.message }, { status: 500 });

    let reprocessed = 0;
    let skipped = 0;
    for (const row of (imports ?? []) as Array<{ id: string; inbound_email_id: string | null; service_id: string | null }>) {
      if (!row.inbound_email_id || !row.service_id) {
        skipped += 1;
        continue;
      }

      const [{ data: serviceData }, { data: emailData }] = await Promise.all([
        admin
          .from("services")
          .select("id, tenant_id, service_type, direction, date, time, pax")
          .eq("id", row.service_id)
          .eq("tenant_id", membership.tenant_id)
          .maybeSingle(),
        admin
          .from("inbound_emails")
          .select("id, raw_text, extracted_text")
          .eq("id", row.inbound_email_id)
          .eq("tenant_id", membership.tenant_id)
          .maybeSingle()
      ]);

      const service = (serviceData ?? null) as ReapplyServiceRow | null;
      const email = (emailData ?? null) as ReapplyEmailRow | null;

      if (!service || !email) {
        skipped += 1;
        continue;
      }

      await tryMatchAndApplyPricing(admin, {
        tenantId: membership.tenant_id,
        inboundEmailId: email.id,
        serviceId: service.id,
        sourceText: `${email.raw_text ?? ""}\n${email.extracted_text ?? ""}`.trim(),
        serviceType: (service.service_type ?? "transfer") as "transfer" | "bus_tour",
        direction: service.direction as "arrival" | "departure",
        date: service.date,
        time: service.time,
        pax: Number(service.pax ?? 1)
      });

      await (admin
        .from("inbound_booking_imports") as any)
        .update({
          review_required: false,
          match_status: "applied",
          reviewed_by_user_id: user.id,
          reviewed_at: now,
          match_notes: "Rielaborazione manuale eseguita (creato nuovo record match)."
        })
        .eq("id", row.id)
        .eq("tenant_id", membership.tenant_id);

      reprocessed += 1;
    }

    return NextResponse.json({ ok: true, action, reprocessed, skipped });
  } catch (error) {
    console.error("Pricing matches POST error", error);
    return NextResponse.json({ error: "Errore interno server." }, { status: 500 });
  }
}
