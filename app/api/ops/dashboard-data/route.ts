import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { computeDashboardData } from "@/lib/server/dashboard-data";

export const runtime = "nodejs";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data non valida (atteso YYYY-MM-DD)");
const querySchema = z.object({ today: isoDateSchema, next48h: isoDateSchema });

// Sprint Performance 14B. Replaces the Dashboard's legacy
// useTenantOperationalData() full-tenant-history fetch. Same auth roles as
// /api/ops/tenant-data (which the Dashboard used before), same tenant
// isolation. Returns only the bounded slices + aggregate counts the
// Dashboard's KPIs actually need — see lib/server/dashboard-data.ts.
export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
    if (auth instanceof NextResponse) return auth;

    const params = request.nextUrl.searchParams;
    const parsed = querySchema.safeParse({ today: params.get("today"), next48h: params.get("next48h") });
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Parametri non validi." }, { status: 400 });
    }

    const tenantId = auth.membership.tenant_id;
    const data = await computeDashboardData({
      admin: auth.admin,
      tenantId,
      today: parsed.data.today,
      next48h: parsed.data.next48h
    });

    return NextResponse.json({
      ok: true,
      tenant_id: tenantId,
      user_id: auth.user.id,
      role: auth.membership.role,
      window_services: data.windowServices,
      hotels: data.hotels,
      assignments: data.assignments,
      today_pdf_needs_attention_count: data.todayPdfNeedsAttentionCount,
      inbox_pdf_needs_review_count: data.inboxPdfNeedsReviewCount,
      inbox_to_review_count: data.inboxToReviewCount,
      undelivered_reminder_count: data.undeliveredReminderCount,
      undelivered_reminder_sample: data.undeliveredReminderSample
    });
  } catch (error) {
    console.error("Dashboard data endpoint error", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ ok: false, error: "Errore caricamento dati dashboard." }, { status: 500 });
  }
}
