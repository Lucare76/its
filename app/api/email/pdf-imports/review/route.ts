import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { pdfImportReviewSchema, savePdfImportReview } from "@/lib/server/agency-pdf-import";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

const reviewPayloadSchema = z.object({
  inbound_email_id: z.string().uuid(),
  reviewed_values: pdfImportReviewSchema
});

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const payload = await request.json().catch(() => null);
    const parsed = reviewPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
    }

    const result = await savePdfImportReview(auth, {
      inboundEmailId: parsed.data.inbound_email_id,
      reviewedValues: parsed.data.reviewed_values
    });

    return NextResponse.json(result);
  } catch (error) {
    auditLog({ event: "pdf_import_review_unhandled", level: "error", details: { message: error instanceof Error ? error.message : "Unknown error" } });
    return NextResponse.json({ ok: false, error: "Errore interno server." }, { status: 500 });
  }
}
