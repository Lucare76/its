import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/server/whatsapp";
import { closeInactiveWhatsAppThreads } from "@/lib/server/whatsapp/auto-close";
import { completeJobRun, startJobRun } from "@/lib/server/job-health";
import { sanitizedErrorResponse } from "@/lib/server/api-error";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  // Vercel Cron supplies CRON_SECRET automatically. Do not fall back to a
  // WhatsApp-specific secret which could differ from the scheduler's value.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let admin: ReturnType<typeof createAdminClient> | undefined;
  let runId: string | null = null;
  try {
    admin = createAdminClient();
    runId = await startJobRun({
      admin,
      jobKey: "whatsapp-auto-close",
      jobName: "Chiusura chat WhatsApp inattive",
      source: "api/cron/whatsapp-auto-close",
    });
    const result = await closeInactiveWhatsAppThreads(admin);
    await completeJobRun({
      admin, runId, status: "success",
      processedCount: result.scanned, successCount: result.closed,
      metadata: { ...result, inactivity_hours: 24 },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (admin && runId) {
      await completeJobRun({
        admin, runId, status: "failed",
        errorMessage: "Chiusura automatica WhatsApp non completata",
      }).catch(() => {});
    }
    return sanitizedErrorResponse(error, {
      status: 500, fallback: "Chiusura automatica WhatsApp non completata",
      event: "whatsapp_auto_close_failed",
    });
  }
}
