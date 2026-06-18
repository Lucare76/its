import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { sendWhatsAppMessage, logWhatsAppEvent } from "@/lib/server/whatsapp";

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  batchId: z.string().uuid(),
  templateName: z.string().optional().default("its_partenza_bus_dettaglio"),
  languageCode: z.string().optional().default("it"),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }

  const { batchId, templateName, languageCode } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  const { data: batch } = await auth.admin
    .from("bus_convocation_batches")
    .select("id, status")
    .eq("id", batchId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (!batch) {
    return NextResponse.json({ error: "Batch non trovato" }, { status: 404 });
  }

  if (batch.status === "sending") {
    return NextResponse.json({ error: "Invio già in corso" }, { status: 409 });
  }

  await auth.admin
    .from("bus_convocation_batches")
    .update({ status: "sending", updated_at: new Date().toISOString() })
    .eq("id", batchId);

  const { data: rows, error: rowsError } = await auth.admin
    .from("bus_convocation_rows")
    .select("*")
    .eq("batch_id", batchId)
    .eq("tenant_id", tenantId)
    .in("status", ["da_inviare", "da_reinviare"])
    .order("row_index", { ascending: true })
    .limit(2000);

  if (rowsError) {
    await auth.admin
      .from("bus_convocation_batches")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", batchId);
    return NextResponse.json({ error: rowsError.message }, { status: 500 });
  }

  if (!rows || rows.length === 0) {
    await auth.admin
      .from("bus_convocation_batches")
      .update({ status: "ready", updated_at: new Date().toISOString() })
      .eq("id", batchId);
    return NextResponse.json({ ok: true, sent: 0, failed: 0, skipped: 0 });
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.phone_e164) {
      await auth.admin
        .from("bus_convocation_rows")
        .update({ status: "numero_non_valido", error_message: "Numero non valido", updated_at: new Date().toISOString() })
        .eq("id", row.id);
      failed++;
      continue;
    }

    const variables: Record<string, string> = {
      "1": String(row.customer_name ?? ""),
      "2": String(row.date_line ?? ""),
      "3": String(row.departure_point ?? ""),
      "4": String(row.service_time ?? ""),
      "5": String(row.driver_name ?? ""),
      "6": String(row.driver_emergency_phone ?? ""),
    };

    const nowIso = new Date().toISOString();

    const existingLogs = await auth.admin
      .from("bus_convocation_send_logs")
      .select("attempt_number")
      .eq("row_id", row.id)
      .order("attempt_number", { ascending: false })
      .limit(1);
    const attemptNumber = ((existingLogs.data?.[0]?.attempt_number as number) ?? 0) + 1;

    let result: { ok: boolean; messageId?: string | null; error?: string; phoneE164?: string };
    try {
      result = await sendWhatsAppMessage({
        to: row.phone_e164,
        template: templateName,
        variables,
        languageCode,
      });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : "Errore invio" };
    }

    if (result.ok) {
      await auth.admin
        .from("bus_convocation_rows")
        .update({
          status: "inviato",
          provider_message_id: result.messageId ?? null,
          sent_at: nowIso,
          error_message: null,
          updated_at: nowIso,
        })
        .eq("id", row.id);
      sent++;
    } else {
      await auth.admin
        .from("bus_convocation_rows")
        .update({
          status: "errore",
          error_message: result.error ?? "Errore sconosciuto",
          updated_at: nowIso,
        })
        .eq("id", row.id);
      failed++;
    }

    await auth.admin
      .from("bus_convocation_send_logs")
      .insert({
        tenant_id: tenantId,
        batch_id: batchId,
        row_id: row.id,
        operator_user_id: userId,
        phone_e164: row.phone_e164,
        template_name: templateName,
        language_code: languageCode,
        variables_json: variables,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.ok ? (result.messageId ?? null) : null,
        error_message: result.ok ? null : (result.error ?? null),
        attempt_number: attemptNumber,
        attempted_at: nowIso,
      });

    try {
      await logWhatsAppEvent(auth.admin, {
        tenant_id: tenantId,
        service_id: null,
        to_phone: row.phone_e164,
        kind: "bus_convocazione",
        template: templateName,
        status: result.ok ? "sent" : "failed",
        provider_message_id: result.ok ? (result.messageId ?? null) : null,
        happened_at: nowIso,
        payload_json: {
          source: "bus-convocations/send",
          batch_id: batchId,
          customer_name: row.customer_name,
          date_line: row.date_line,
          departure_point: row.departure_point,
          driver_name: row.driver_name,
        },
      });
    } catch {
      // Non bloccare l'invio se il log fallisce
    }
  }

  const { data: allRows } = await auth.admin
    .from("bus_convocation_rows")
    .select("status")
    .eq("batch_id", batchId)
    .eq("tenant_id", tenantId);

  const sentCount = (allRows ?? []).filter((r) => r.status === "inviato").length;
  const errorCount = (allRows ?? []).filter((r) => r.status === "errore").length;
  const skippedCount = (allRows ?? []).filter((r) =>
    ["escluso", "duplicato", "numero_non_valido"].includes(r.status as string)
  ).length;

  await auth.admin
    .from("bus_convocation_batches")
    .update({
      status: "completed",
      sent_count: sentCount,
      error_count: errorCount,
      skipped_count: skippedCount,
      updated_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  return NextResponse.json({ ok: true, sent, failed, skipped: skippedCount });
}
