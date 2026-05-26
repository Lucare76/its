import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { ensureWhatsAppContact, normalizeWhatsAppContactPhone } from "@/lib/server/whatsapp/contacts";

export const runtime = "nodejs";

const resolveSchema = z.object({
  phone: z.string().trim().max(40),
  name: z.string().trim().max(120).optional(),
  tenantId: z.string().uuid().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor", "assistenza", "agency"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  const tenantId = auth.membership.tenant_id;
  if (parsed.data.tenantId && parsed.data.tenantId !== tenantId) {
    return NextResponse.json({ error: "Tenant non valido." }, { status: 403 });
  }

  const phoneE164 = normalizeWhatsAppContactPhone(parsed.data.phone);
  if (!phoneE164) {
    return NextResponse.json({ error: "Numero telefono non disponibile." }, { status: 400 });
  }

  const waId = phoneE164.replace(/^\+/, "");
  const { data: thread, error: threadError } = await auth.admin
    .from("whatsapp_threads")
    .select("id")
    .eq("tenant_id", tenantId)
    .or(`phone_e164.eq.${phoneE164},wa_id.eq.${waId}`)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (threadError) return NextResponse.json({ error: threadError.message }, { status: 500 });

  if (thread?.id) {
    return NextResponse.json({ ok: true, phone_e164: phoneE164, thread_id: thread.id, url: `/whatsapp?thread=${thread.id}` });
  }

  try {
    await ensureWhatsAppContact(auth.admin, {
      tenantId,
      phone: phoneE164,
      profileName: parsed.data.name,
    });
  } catch (error) {
    console.error("WhatsApp contact creation failed:", error);
  }

  return NextResponse.json({
    ok: true,
    phone_e164: phoneE164,
    thread_id: null,
    url: `/whatsapp?new=${encodeURIComponent(phoneE164)}${parsed.data.name ? `&name=${encodeURIComponent(parsed.data.name)}` : ""}`,
  });
}

