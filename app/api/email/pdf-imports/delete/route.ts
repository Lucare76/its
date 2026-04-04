import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const deleteSchema = z.object({
  inbound_email_id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const payload = await request.json().catch(() => null);
    const parsed = deleteSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const { data: inboundRow, error: inboundError } = await auth.admin
      .from("inbound_emails")
      .select("id, parsed_json")
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", parsed.data.inbound_email_id)
      .maybeSingle();
    if (inboundError || !inboundRow?.id) {
      return NextResponse.json({ ok: false, error: inboundError?.message ?? "Import PDF non trovato." }, { status: 404 });
    }

    const currentState = String(((inboundRow.parsed_json as Record<string, any>)?.pdf_import?.import_state as string | null | undefined) ?? "");
    const linkedServiceId = String(
      ((inboundRow.parsed_json as Record<string, any>)?.pdf_import?.linked_service_id as string | null | undefined) ?? ""
    );

    if (linkedServiceId) {
      const { data: linkedService, error: linkedServiceError } = await auth.admin
        .from("services")
        .select("id, is_draft, status")
        .eq("tenant_id", auth.membership.tenant_id)
        .eq("id", linkedServiceId)
        .maybeSingle();
      if (linkedServiceError) {
        return NextResponse.json({ ok: false, error: linkedServiceError.message }, { status: 500 });
      }
      if (linkedService?.id) {
        const { error: deleteServiceError } = await auth.admin
          .from("services")
          .delete()
          .eq("tenant_id", auth.membership.tenant_id)
          .eq("id", linkedService.id);
        if (deleteServiceError) {
          return NextResponse.json({ ok: false, error: deleteServiceError.message }, { status: 500 });
        }
      }
    }

    const { error: deleteAttachmentsError } = await auth.admin
      .from("inbound_email_attachments")
      .delete()
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("inbound_email_id", inboundRow.id);
    if (deleteAttachmentsError) {
      return NextResponse.json({ ok: false, error: deleteAttachmentsError.message }, { status: 500 });
    }

    const { error: deleteInboundError } = await auth.admin
      .from("inbound_emails")
      .delete()
      .eq("tenant_id", auth.membership.tenant_id)
      .eq("id", inboundRow.id);
    if (deleteInboundError) {
      return NextResponse.json({ ok: false, error: deleteInboundError.message }, { status: 500 });
    }

    auditLog({
      event: "pdf_import_deleted",
      tenantId: auth.membership.tenant_id,
      userId: auth.user.id,
      role: auth.membership.role,
      inboundEmailId: inboundRow.id,
      serviceId: linkedServiceId || null,
      outcome: currentState === "imported" ? "deleted_confirmed_import" : "deleted"
    });

    return NextResponse.json({
      ok: true,
      inbound_email_id: inboundRow.id,
      deleted: true,
      linked_service_id: linkedServiceId || null
    });
  } catch (error) {
    auditLog({ event: "pdf_import_delete_unhandled", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ ok: false, error: "Errore interno server." }, { status: 500 });
  }
}
