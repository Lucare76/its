import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { confirmPdfImport } from "@/lib/server/agency-pdf-import";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const confirmSchema = z.object({
  inbound_email_id: z.string().uuid()
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const body = await request.json().catch(() => null);
    const parsed = confirmSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const result = await confirmPdfImport(auth, {
      inboundEmailId: parsed.data.inbound_email_id
    });

    return NextResponse.json(result);
  } catch (error) {
    auditLog({ event: "pdf_import_confirm_unhandled", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ ok: false, error: "Errore interno server." }, { status: 500 });
  }
}
