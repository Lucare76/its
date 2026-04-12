/**
 * GET /api/ops/inbound-emails
 * Lista email inbound recenti con stato processamento — richiede admin/operator.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 200);
    const offset = Number(searchParams.get("offset") ?? "0");
    const tenantId = auth.membership.tenant_id;

    const [emailsResult, countResult] = await Promise.all([
      auth.admin
        .from("inbound_emails")
        .select("id, from_email, subject, created_at, parsed_json, extracted_text")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1),
      auth.admin
        .from("inbound_emails")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId),
    ]);

    if (emailsResult.error) throw new Error(emailsResult.error.message);

    const emails = (emailsResult.data ?? []).map((row) => {
      const pj = (row.parsed_json ?? {}) as Record<string, unknown>;
      const suggestions = (pj.parser_suggestions ?? {}) as Record<string, unknown>;
      return {
        id: row.id as string,
        from_email: row.from_email as string,
        subject: row.subject as string,
        created_at: row.created_at as string,
        review_status: (pj.review_status as string) ?? "unknown",
        draft_service_id: (pj.draft_service_id as string | null) ?? null,
        direction: (suggestions.direction as string | null) ?? null,
        date: (suggestions.date as string | null) ?? null,
        hotel: (suggestions.hotel as string | null) ?? null,
        customer_name: (suggestions.customer_name as string | null) ?? null,
        pax: (suggestions.pax as number | null) ?? null,
        has_pdf: row.extracted_text != null,
        pdf_parser: (pj.pdf_parser as { key?: string; score?: number } | null) ?? null,
      };
    });

    return NextResponse.json({
      ok: true,
      emails,
      total: countResult.count ?? 0,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore sconosciuto" },
      { status: 500 }
    );
  }
}
