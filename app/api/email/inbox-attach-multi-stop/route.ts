import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { extractPdfTextFromBase64, isPdfAttachment } from "@/lib/server/pdf-text";
import { alesteMultiStopHotel, extractAlesteMultiStopRows, isAlesteMultiStop, pairAlesteBusRows } from "@/lib/server/aleste-multi-stop";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;
  const form = await request.formData();
  const parsed = z.string().uuid().safeParse(form.get("inbound_email_id"));
  const file = form.get("file");
  if (!parsed.success || !(file instanceof File) || file.size <= 0 || file.size > 8 * 1024 * 1024 || !isPdfAttachment(file.name, file.type)) {
    return NextResponse.json({ ok: false, error: "Seleziona un PDF valido (max 8 MB)." }, { status: 400 });
  }
  const tenantId = auth.membership.tenant_id;
  const { data: email } = await auth.admin.from("inbound_emails").select("id, parsed_json")
    .eq("tenant_id", tenantId).eq("id", parsed.data).maybeSingle();
  if (!email?.id || ["confirmed", "ready_operational"].includes((email.parsed_json as { review_status?: string } | null)?.review_status ?? "")) {
    return NextResponse.json({ ok: false, error: "Email non disponibile per la revisione." }, { status: 409 });
  }
  const text = await extractPdfTextFromBase64(Buffer.from(await file.arrayBuffer()).toString("base64"));
  const rows = extractAlesteMultiStopRows(text);
  const pairs = pairAlesteBusRows(rows);
  const originalForm = (email.parsed_json as { claude_extracted?: { form?: { numero_pratica?: string } } } | null)?.claude_extracted?.form;
  const practice = originalForm?.numero_pratica?.trim();
  if (!isAlesteMultiStop(text) || !pairs || (practice && !text.includes(practice))) {
    return NextResponse.json({ ok: false, error: "Il PDF non contiene le tratte complete della stessa pratica Aleste." }, { status: 422 });
  }
  const hotel = alesteMultiStopHotel(rows);
  const nextJson = { ...(email.parsed_json ?? {}), aleste_multi_stop: { rows, pairing_valid: true, hotel } };
  const updated = await auth.admin.from("inbound_emails").update({ extracted_text: text, parsed_json: nextJson })
    .eq("tenant_id", tenantId).eq("id", parsed.data);
  if (updated.error) return NextResponse.json({ ok: false, error: updated.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, rows, hotel });
}
