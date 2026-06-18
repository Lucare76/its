import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { normalizeE164 } from "@/lib/server/whatsapp";

export const runtime = "nodejs";

const rowSchema = z.object({
  rowIndex: z.number().int().min(1),
  inviare: z.boolean(),
  phoneRaw: z.string(),
  customerName: z.string(),
  dateLine: z.string(),
  departurePoint: z.string(),
  driverName: z.string(),
  driverEmergencyPhone: z.string(),
  generatedMessage: z.string().optional().default(""),
  notes: z.string().optional().default(""),
});

const bodySchema = z.object({
  label: z.string().max(200).optional().default(""),
  fileName: z.string().max(500),
  rows: z.array(rowSchema).min(1).max(2000),
});

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi" }, { status: 400 });
  }

  const { label, fileName, rows } = parsed.data;
  const tenantId = auth.membership.tenant_id;
  const userId = auth.user.id;

  const { data: batch, error: batchError } = await auth.admin
    .from("bus_convocation_batches")
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

  const seen = new Map<string, number>();
  let prontoCount = 0;
  let esclusoCount = 0;
  let duplicatoCount = 0;
  let nonValidoCount = 0;

  const dbRows = rows.map((row) => {
    let phoneE164: string | null = null;
    let status: string;
    let errorMessage: string | null = null;

    if (!row.inviare) {
      status = "escluso";
      esclusoCount++;
      try { phoneE164 = normalizeE164(row.phoneRaw); } catch { /* keep null */ }
    } else if (!row.customerName.trim()) {
      status = "errore";
      errorMessage = "Nome cliente mancante";
      nonValidoCount++;
    } else if (!row.dateLine.trim()) {
      status = "errore";
      errorMessage = "Data / Linea bus mancante";
      nonValidoCount++;
    } else if (!row.departurePoint.trim()) {
      status = "errore";
      errorMessage = "Punto partenza mancante";
      nonValidoCount++;
    } else if (!row.driverName.trim()) {
      status = "errore";
      errorMessage = "Nome autista mancante";
      nonValidoCount++;
    } else if (!row.driverEmergencyPhone.trim()) {
      status = "errore";
      errorMessage = "Telefono emergenza autista mancante";
      nonValidoCount++;
    } else if (!row.phoneRaw.trim()) {
      status = "numero_non_valido";
      errorMessage = "Telefono cliente mancante";
      nonValidoCount++;
    } else {
      try {
        phoneE164 = normalizeE164(row.phoneRaw);
      } catch (err) {
        status = "numero_non_valido";
        errorMessage = err instanceof Error ? err.message : "Numero non valido";
        nonValidoCount++;
        return {
          tenant_id: tenantId,
          batch_id: batchId,
          row_index: row.rowIndex,
          inviare: row.inviare,
          phone_raw: row.phoneRaw,
          phone_e164: null,
          customer_name: row.customerName.trim(),
          date_line: row.dateLine.trim(),
          departure_point: row.departurePoint.trim(),
          driver_name: row.driverName.trim(),
          driver_emergency_phone: row.driverEmergencyPhone.trim(),
          generated_message: row.generatedMessage,
          notes: row.notes,
          status,
          error_message: errorMessage,
        };
      }

      const dupKey = `${phoneE164}||${row.dateLine.trim().toLowerCase()}`;
      const firstSeen = seen.get(dupKey);
      if (firstSeen != null) {
        status = "duplicato";
        errorMessage = `Duplicato della riga ${firstSeen}`;
        duplicatoCount++;
      } else {
        seen.set(dupKey, row.rowIndex);
        status = "pronto";
        prontoCount++;
      }
    }

    return {
      tenant_id: tenantId,
      batch_id: batchId,
      row_index: row.rowIndex,
      inviare: row.inviare,
      phone_raw: row.phoneRaw,
      phone_e164: phoneE164,
      customer_name: row.customerName.trim(),
      date_line: row.dateLine.trim(),
      departure_point: row.departurePoint.trim(),
      driver_name: row.driverName.trim(),
      driver_emergency_phone: row.driverEmergencyPhone.trim(),
      generated_message: row.generatedMessage,
      notes: row.notes,
      status,
      error_message: errorMessage,
    };
  });

  const chunks = chunkArray(dbRows, 500);
  for (const chunk of chunks) {
    const { error: insertError } = await auth.admin
      .from("bus_convocation_rows")
      .insert(chunk);
    if (insertError) {
      return NextResponse.json({ error: "Errore inserimento righe: " + insertError.message }, { status: 500 });
    }
  }

  await auth.admin
    .from("bus_convocation_batches")
    .update({ status: "ready", updated_at: new Date().toISOString() })
    .eq("id", batchId);

  return NextResponse.json({
    ok: true,
    batchId,
    summary: {
      total: rows.length,
      pronto: prontoCount,
      escluso: esclusoCount,
      duplicato: duplicatoCount,
      non_valido: nonValidoCount,
    },
  });
}
