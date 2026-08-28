import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeE164 } from "@/lib/server/whatsapp";
import { buildSnavConvocationTemplateParams, buildSnavConvocationPreviewText } from "@/lib/snav-convocation-template";
import { auditLog } from "@/lib/server/ops-audit";

export const runtime = "nodejs";

// departureDateLabel/pickupTime/vesselTime arrive already formatted by the
// client (lib/snav-convocation-format.ts), since only the browser has the
// raw Excel cell (Date object / numeric serial) needed to format them
// correctly — the server never re-derives these from raw values.
const rowSchema = z.object({
  rowIndex: z.number().int().min(1),
  inviare: z.boolean(),
  phoneRaw: z.string(),
  customerName: z.string(),
  departureDateLabel: z.string(),
  departureDateIso: z.string().nullable().optional().default(null),
  hotel: z.string(),
  passengers: z.string(),
  pickupTime: z.string(),
  vesselTime: z.string(),
});

const bodySchema = z.object({
  label: z.string().max(200).optional().default(""),
  fileName: z.string().max(500),
  rows: z.array(rowSchema).min(1).max(2000),
});

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }

  const { label, fileName, rows } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  const { data: batch, error: batchError } = await auth.admin
    .from("snav_convocation_batches")
    .insert({
      tenant_id: tenantId,
      created_by: userId,
      file_name: fileName,
      label,
      status: "validating",
      total_rows: rows.length,
    })
    .select("id")
    .single();

  if (batchError || !batch?.id) {
    return NextResponse.json({ error: batchError?.message ?? "Errore creazione batch" }, { status: 500 });
  }

  const batchId = batch.id;

  // Cross-batch duplicate check: same phone + departure date + vessel time
  // already sent successfully in a previous batch for this tenant.
  const phoneKeys = new Set<string>();
  for (const row of rows) {
    try { phoneKeys.add(normalizeE164(row.phoneRaw)); } catch { /* invalid numbers handled per-row below */ }
  }

  const previouslySent = new Set<string>();
  if (phoneKeys.size > 0) {
    const { data: sentRows } = await auth.admin
      .from("snav_convocation_rows")
      .select("phone_e164, departure_date, departure_date_label, vessel_time")
      .eq("tenant_id", tenantId)
      .eq("status", "inviato")
      .in("phone_e164", Array.from(phoneKeys));
    for (const r of sentRows ?? []) {
      const dateKey = r.departure_date ?? String(r.departure_date_label).trim().toLowerCase();
      previouslySent.add(`${r.phone_e164}||${dateKey}||${String(r.vessel_time).trim().toLowerCase()}`);
    }
  }

  const seenInBatch = new Map<string, number>();
  let prontoCount = 0;
  let esclusoCount = 0;
  let duplicatoCount = 0;
  let nonValidoCount = 0;
  let erroreCount = 0;

  const dbRows = rows.map((row) => {
    let phoneE164: string | null = null;
    let status: string;
    let errorMessage: string | null = null;

    const templateInput = {
      customerName: row.customerName.trim(),
      departureDateLabel: row.departureDateLabel.trim(),
      hotel: row.hotel.trim(),
      passengers: row.passengers.trim(),
      pickupTime: row.pickupTime.trim(),
      vesselTime: row.vesselTime.trim(),
    };
    const templateParams = buildSnavConvocationTemplateParams(templateInput);
    const generatedMessage = buildSnavConvocationPreviewText(templateInput);

    const base = {
      tenant_id: tenantId,
      batch_id: batchId,
      row_index: row.rowIndex,
      inviare: row.inviare,
      phone_raw: row.phoneRaw,
      customer_name: templateInput.customerName,
      departure_date: row.departureDateIso,
      departure_date_label: templateInput.departureDateLabel,
      hotel: templateInput.hotel,
      passengers: templateInput.passengers,
      pickup_time: templateInput.pickupTime,
      vessel_time: templateInput.vesselTime,
      generated_message: generatedMessage,
      template_payload: templateParams,
    };

    if (!row.inviare) {
      status = "escluso";
      esclusoCount++;
      try { phoneE164 = normalizeE164(row.phoneRaw); } catch { /* keep null */ }
      return { ...base, phone_e164: phoneE164, status, error_message: errorMessage };
    }

    if (!templateInput.customerName) {
      status = "errore"; errorMessage = "Nome cliente mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!templateInput.departureDateLabel) {
      status = "errore"; errorMessage = "Data partenza mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!templateInput.hotel) {
      status = "errore"; errorMessage = "Hotel mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!templateInput.passengers) {
      status = "errore"; errorMessage = "Pax mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!templateInput.pickupTime) {
      status = "errore"; errorMessage = "Ora prelevamento mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!templateInput.vesselTime) {
      status = "errore"; errorMessage = "Ora nave mancante"; erroreCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }
    if (!row.phoneRaw.trim()) {
      status = "numero_non_valido"; errorMessage = "Numero cliente mancante"; nonValidoCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }

    try {
      phoneE164 = normalizeE164(row.phoneRaw);
    } catch (err) {
      status = "numero_non_valido";
      errorMessage = err instanceof Error ? err.message : "Numero non valido";
      nonValidoCount++;
      return { ...base, phone_e164: null, status, error_message: errorMessage };
    }

    const dateKey = row.departureDateIso ?? templateInput.departureDateLabel.toLowerCase();
    const dedupKey = `${phoneE164}||${dateKey}||${templateInput.vesselTime.toLowerCase()}`;
    const firstSeenInBatch = seenInBatch.get(dedupKey);

    if (firstSeenInBatch != null) {
      status = "duplicato";
      errorMessage = `Duplicato della riga ${firstSeenInBatch}`;
      duplicatoCount++;
    } else if (previouslySent.has(dedupKey)) {
      status = "duplicato";
      errorMessage = "Convocazione già inviata con successo in un batch precedente";
      duplicatoCount++;
      seenInBatch.set(dedupKey, row.rowIndex);
    } else {
      seenInBatch.set(dedupKey, row.rowIndex);
      status = "pronto";
      prontoCount++;
    }

    return { ...base, phone_e164: phoneE164, status, error_message: errorMessage };
  });

  for (const chunk of chunkArray(dbRows, 500)) {
    const { error: insertError } = await auth.admin.from("snav_convocation_rows").insert(chunk);
    if (insertError) {
      return NextResponse.json({ error: "Errore inserimento righe: " + insertError.message }, { status: 500 });
    }
  }

  await auth.admin
    .from("snav_convocation_batches")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", batchId);

  auditLog({
    event: "snav_convocation_batch_uploaded",
    tenantId,
    userId,
    role: auth.membership.role,
    outcome: "ok",
    details: { batch_id: batchId, file_name: fileName, total_rows: rows.length, pronto: prontoCount, escluso: esclusoCount, duplicato: duplicatoCount, non_valido: nonValidoCount, errore: erroreCount },
  });

  return NextResponse.json({
    ok: true,
    batchId,
    summary: {
      total: rows.length,
      pronto: prontoCount,
      escluso: esclusoCount,
      duplicato: duplicatoCount,
      non_valido: nonValidoCount,
      errore: erroreCount,
    },
  });
}
