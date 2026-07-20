import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { fetchMetaPricingAnalytics } from "@/lib/server/whatsapp/costs";

export const runtime = "nodejs";

const querySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function GET(request: NextRequest) {
  const auth = await authorizePricingRequest(request, ["admin", "supervisor"]);
  if (auth instanceof NextResponse) return auth;

  const parsed = querySchema.safeParse({
    start: request.nextUrl.searchParams.get("start"),
    end: request.nextUrl.searchParams.get("end"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Intervallo non valido." }, { status: 400 });
  }

  try {
    const result = await Promise.race([
      fetchMetaPricingAnalytics(parsed.data),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Timeout pricing_analytics Meta")), 12_000)),
    ]);
    if (!result.ok) {
      console.warn("Meta pricing_analytics unavailable", {
        status: result.status,
        error: result.error,
      });
      return NextResponse.json({
        ok: false,
        available: false,
        error: result.error ?? "pricing_analytics non disponibile per account o permessi correnti.",
      });
    }
    return NextResponse.json({ ok: true, available: true, data: result.data });
  } catch (error) {
    console.warn("Meta pricing_analytics failed", {
      message: error instanceof Error ? error.message : "pricing analytics failed",
    });
    return NextResponse.json({
      ok: false,
      available: false,
      error: error instanceof Error ? error.message : "pricing_analytics non disponibile.",
    });
  }
}
