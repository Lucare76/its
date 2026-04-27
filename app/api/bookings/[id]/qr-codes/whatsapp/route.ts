import { NextRequest, NextResponse } from "next/server";
import { authorizeServiceRoleRequest } from "@/lib/server/pricing-auth";
import { appUrlFromRequest, sendBusBookingQrWhatsApp } from "@/lib/server/bus-booking-qr";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authorizeServiceRoleRequest(request, {
    roles: ["admin", "operator", "supervisor", "assistenza"],
    auditPrefix: "bus_qr_whatsapp",
  });
  if (auth instanceof NextResponse) return auth;

  try {
    const { id } = await params;
    const body = await request.json().catch(() => null) as {
      selection?: "outbound" | "return" | "both";
      media_kind?: "image" | "document";
      dry_run?: boolean;
    } | null;

    const result = await sendBusBookingQrWhatsApp({
      admin: auth.admin,
      tenantId: auth.membership.tenant_id,
      bookingId: id,
      appUrl: appUrlFromRequest(request),
      selection: body?.selection ?? "both",
      mediaKind: body?.media_kind ?? "image",
      dryRun: body?.dry_run ?? false,
    });

    return NextResponse.json({
      ok: result.ok,
      preview_only: result.previewOnly,
      phone: result.phone,
      template_name: result.templateName,
      messages: result.messages,
      errors: result.errors,
    }, { status: result.ok ? 200 : 400 });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "Invio WhatsApp QR bus non riuscito.",
    }, { status: 400 });
  }
}
