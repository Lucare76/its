import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { buildOperationalV2ServerPreview } from "@/lib/server/operational-v2-server-preview";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";

export const runtime = "nodejs";

const payloadSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
});

export async function POST(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "operator"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = payloadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message ?? "Payload non valido." }, { status: 400 });
  }

  try {
    const result = await buildOperationalV2ServerPreview(auth, parsed.data.rows);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Validazione operational_v2 non riuscita." },
      { status: 500 }
    );
  }
}
