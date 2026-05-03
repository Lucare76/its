import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { syncMetaWhatsAppTemplates } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin"]);
  if (auth instanceof NextResponse) return auth;

  try {
    const templates = await syncMetaWhatsAppTemplates(auth.admin, auth.membership.tenant_id);
    return NextResponse.json({
      ok: true,
      imported: templates.length,
      templates: templates.map((template) => ({
        id: template.id,
        meta_template_id: template.meta_template_id,
        name: template.name,
        language_code: template.language_code,
        status: template.status,
        category: template.category,
        body_parameter_count: template.body_parameter_count,
        synced_at: template.synced_at
      }))
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync template Meta fallita." },
      { status: 500 }
    );
  }
}
