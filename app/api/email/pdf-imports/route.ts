import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { buildPdfImportDetail } from "@/lib/server/pdf-imports";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const { data: inboundRows, error: inboundError } = await auth.admin
      .from("inbound_emails")
      .select("id, tenant_id, from_email, subject, extracted_text, parsed_json, created_at")
      .eq("tenant_id", auth.membership.tenant_id)
      .order("created_at", { ascending: false })
      .limit(300);
    if (inboundError) {
      return NextResponse.json({ ok: false, error: inboundError.message }, { status: 500 });
    }

    const pdfInboundRows = ((inboundRows ?? []) as Array<Record<string, any>>).filter((row) => Boolean(row.parsed_json?.pdf_import));
    const { data: serviceRows } = await auth.admin
      .from("services")
      .select("id, inbound_email_id, is_draft, status, customer_name, date, time, notes, created_at")
      .eq("tenant_id", auth.membership.tenant_id)
      .order("created_at", { ascending: false })
      .limit(500);

    const serviceByInbound = new Map<string, Record<string, any>>();
    for (const service of (serviceRows ?? []) as Array<Record<string, any>>) {
      const inboundEmailId = String(service.inbound_email_id ?? "");
      if (!inboundEmailId || serviceByInbound.has(inboundEmailId)) continue;
      serviceByInbound.set(inboundEmailId, service);
    }

    const linkedServiceIds = [...serviceByInbound.values()].map((item) => item.id).filter(Boolean);
    const { data: statusRows } = linkedServiceIds.length
      ? await auth.admin
          .from("status_events")
          .select("id, service_id, status, at")
          .eq("tenant_id", auth.membership.tenant_id)
          .in("service_id", linkedServiceIds)
          .order("at", { ascending: false })
      : { data: [] };

    const eventsByServiceId = new Map<string, Array<Record<string, any>>>();
    for (const item of (statusRows ?? []) as Array<Record<string, any>>) {
      const key = String(item.service_id);
      const current = eventsByServiceId.get(key) ?? [];
      current.push(item);
      eventsByServiceId.set(key, current);
    }

    const rows = pdfInboundRows.map((row) =>
      buildPdfImportDetail(
        row as any,
        (serviceByInbound.get(String(row.id)) as any) ?? null,
        (eventsByServiceId.get(String(serviceByInbound.get(String(row.id))?.id ?? "")) as any) ?? []
      )
    );

    return NextResponse.json({ ok: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
