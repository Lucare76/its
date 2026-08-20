/**
 * GET /api/cron/medmar-delivery-retry
 *
 * Retry controllato per delivery Medmar rimaste bloccate su PDF lento
 * (awaiting_pdf / pdf_not_found — vedi lib/server/medmar-booking/delivery-retry.ts).
 * Non emette nulla, non fa lock/booking/payment, non reinvia mai se gia'
 * `delivered`: ogni retry richiama `deliverMedmarTicket`, lo stesso motore
 * sicuro e idempotente gia' usato dal pulsante manuale e dall'auto-delivery
 * post-emissione.
 *
 * Auth: stesso pattern Bearer CRON_SECRET degli altri cron interni (vedi
 * app/api/cron/sla-check/route.ts, app/api/cron/poll-emails/route.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { auditLog } from "@/lib/server/ops-audit";
import { runMedmarDeliveryRetryBatch, MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE } from "@/lib/server/medmar-booking/delivery-retry";

export const runtime = "nodejs";
export const maxDuration = 60;

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/^["']|["']$/g, "")!,
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim().replace(/^["']|["']$/g, "")!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ ok: false, error: "Server configuration error" }, { status: 500 });
  }
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const limitParam = Number(new URL(request.url).searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : MEDMAR_DELIVERY_RETRY_DEFAULT_BATCH_SIZE;

  const admin = adminClient();

  try {
    const summary = await runMedmarDeliveryRetryBatch(admin, limit);

    // Nessun dato sensibile nei log: solo conteggi e id, mai email/PDF/allegati.
    auditLog({
      event: "medmar_delivery_retry_batch",
      level: summary.errors > 0 ? "warn" : "info",
      outcome: `delivered=${summary.delivered} pending=${summary.still_pending} escalated=${summary.escalated_to_manual_review} errors=${summary.errors}`,
      details: {
        candidates_found: summary.candidates_found,
        processed: summary.processed,
        delivered: summary.delivered,
        still_pending: summary.still_pending,
        escalated_to_manual_review: summary.escalated_to_manual_review,
        errors: summary.errors,
      },
    });

    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    auditLog({
      event: "medmar_delivery_retry_batch_failed",
      level: "error",
      outcome: err instanceof Error ? err.message : "unknown_error",
    });
    return NextResponse.json({ ok: false, error: "Errore interno durante il retry delivery Medmar." }, { status: 500 });
  }
}
