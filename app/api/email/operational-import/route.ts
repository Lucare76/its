import { NextRequest, NextResponse } from "next/server";
import { authorizePricingRequest } from "@/lib/server/pricing-auth";
import { pollEmailNow } from "@/lib/server/email-poll";

export const runtime = "nodejs";
export const maxDuration = 120; // Claude estrazione può richiedere fino a 2 minuti

export async function POST(request: NextRequest) {
  try {
    const auth = await authorizePricingRequest(request, ["admin", "operator"]);
    if (auth instanceof NextResponse) return auth;

    // Il refresh manuale Inbox passa force=1: ignora il cooldown (l'operatore
    // vuole un controllo reale ora), ma resta comunque soggetto al lock di
    // concorrenza — se un import è già in corso non apre una seconda
    // connessione IMAP.
    const force = new URL(request.url).searchParams.get("force") === "1";
    const result = await pollEmailNow(auth, { force });

    if (result.status === "error") {
      if (result.imap_not_configured) {
        return NextResponse.json({ ok: false, error: "IMAP non configurato (IMAP_HOST/IMAP_USER/IMAP_PASS mancanti).", imap_not_configured: true });
      }
      console.error("[operational-import] ERRORE:", result.error);
      return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }

    if (result.status === "skipped_in_progress" || result.status === "skipped_recent") {
      return NextResponse.json({
        ok: true,
        status: result.status,
        skipped: true,
        last_success_at: result.last_success_at ?? null,
        unreadFound: 0,
        emailsProcessed: 0,
        pdfFound: 0,
        draftsCreated: 0,
        duplicateWarnings: 0,
        skippedNoPdf: 0
      });
    }

    const detail = result.detail!;
    return NextResponse.json({
      ok: true,
      status: "imported",
      mailbox: detail.mailbox,
      unreadFound: detail.unreadFound,
      emailsProcessed: detail.emailsProcessed,
      pdfFound: detail.pdfFound,
      draftsCreated: detail.draftsCreated,
      duplicateWarnings: detail.duplicateWarnings,
      skippedNoPdf: detail.skippedNoPdf,
      started_at: result.started_at,
      finished_at: result.finished_at,
      last_success_at: result.last_success_at
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[operational-import] ERRORE:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
