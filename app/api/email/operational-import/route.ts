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
    // IMAP non configurato — non è un errore applicativo, restituisce 200
    if (message.includes("Missing IMAP_HOST") || message.includes("IMAP_HOST/IMAP_USER/IMAP_PASS")) {
      return NextResponse.json({ ok: false, error: "IMAP non configurato (IMAP_HOST/IMAP_USER/IMAP_PASS mancanti).", imap_not_configured: true });
    }
    console.error("[operational-import] ERRORE:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
