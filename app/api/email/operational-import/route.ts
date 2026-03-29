import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { runEmailOperationalImport } from "@/lib/server/email-test-import";

export const runtime = "nodejs";
export const maxDuration = 120; // Claude estrazione può richiedere fino a 2 minuti

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    const result = await runEmailOperationalImport(auth);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[operational-import] ERRORE:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
