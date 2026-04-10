import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const ignoreSchema = z.object({
  inbound_email_id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;
    const payload = await request.json().catch(() => null);
    const parsed = ignoreSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { data: row, error } = await auth.admin
      .from("inbound_emails")
      .select("id, parsed_json")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.data.inbound_email_id)
      .maybeSingle();
    if (error || !row?.id) {
      return NextResponse.json({ ok: false, error: error?.message ?? "Import PDF non trovato." }, { status: 404 });
    }

    const currentState = String(((row.parsed_json as Record<string, any>)?.pdf_import?.import_state as string | null | undefined) ?? "");
    if (currentState === "imported" || currentState === "ignored") {
      return NextResponse.json({ ok: false, error: "Lo stato corrente non consente lo scarto." }, { status: 409 });
    }

    const nextParsedJson = {
      ...(row.parsed_json as Record<string, any>),
      review_status: "ignored",
      pdf_import: {
        ...((row.parsed_json as Record<string, any>)?.pdf_import ?? {}),
        import_state: "ignored"
      }
    };

    const { error: updateError } = await auth.admin
      .from("inbound_emails")
      .update({ parsed_json: nextParsedJson })
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", row.id);
    if (updateError) {
      auditLog({
        event: "pdf_import_ignore_failed",
        level: "error",
        tenantId: auth.membership.tenant_id,
        userId: auth.user.id,
        role: auth.membership.role,
        inboundEmailId: row.id,
        details: { message: updateError.message }
      });
      return NextResponse.json({ ok: false, error: updateError.message }, { status: 500 });
    }

    const linkedServiceId = String(
      ((row.parsed_json as Record<string, any>)?.pdf_import?.linked_service_id as string | null | undefined) ?? ""
    );
    if (linkedServiceId) {
      const { data: linkedService, error: linkedServiceError } = await auth.admin
        .from("services")
        .select("id, is_draft, notes, excursion_details")
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", linkedServiceId)
        .maybeSingle();
      if (linkedServiceError) {
        return NextResponse.json({ ok: false, error: linkedServiceError.message }, { status: 500 });
      }

      if (linkedService?.id && linkedService.is_draft) {
        const nextNotes = [linkedService.notes ?? "", "[import_state:ignored]", "[manual_review:false]"]
          .filter(Boolean)
          .join(" | ");
        const { error: serviceUpdateError } = await auth.admin
          .from("services")
          .update({
            status: "cancelled",
            notes: nextNotes,
            excursion_details: {
              ...((linkedService.excursion_details as Record<string, unknown> | null) ?? {}),
              source: "pdf",
              import_mode: "draft",
              import_state: "ignored"
            }
          })
          .eq("tenant_id", auth.membership.tenant_id)
          .eq("id", linkedService.id);
        if (serviceUpdateError) {
          return NextResponse.json({ ok: false, error: serviceUpdateError.message }, { status: 500 });
        }
      }
    }

    auditLog({
      event: "pdf_import_ignored",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      inboundEmailId: row.id,
      outcome: "ignored"
    });

    return NextResponse.json({ ok: true, inbound_email_id: row.id, status: "ignored", linked_service_id: linkedServiceId || null });
  } catch (error) {
    auditLog({ event: "pdf_import_ignore_unhandled", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ ok: false, error: "Errore interno server." }, { status: 500 });
  }
}
